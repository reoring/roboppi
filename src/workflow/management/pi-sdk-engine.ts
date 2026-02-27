/**
 * PiSdkEngine — uses Pi's createAgentSession() to run a persistent
 * management agent with typed decision tool.
 *
 * The session persists across hook invocations for cross-step context.
 * The agent emits directives by calling the `roboppi_management_decision`
 * custom tool, instead of writing to a decision file.
 *
 * For audit parity, the engine still writes decision.json after each hook.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { raceAbort, runEffectPromise, withTimeout } from "../../core/effect-concurrency.js";
import {
  ManagementHookAbortedError,
  ManagementHookTimeoutError,
} from "./errors.js";
import type {
  ManagementAgentEngine,
  ManagementAgentEngineResult,
  ManagementAgentConfig,
  ManagementHook,
  ManagementDirective,
  ManagementAction,
  HookContext,
} from "./types.js";
import { DEFAULT_PROCEED_DIRECTIVE, VALID_MANAGEMENT_ACTIONS } from "./types.js";

// ---------------------------------------------------------------------------
// Types for the Pi SDK (minimal subset we depend on)
// ---------------------------------------------------------------------------

/** Minimal shape of Pi's createAgentSession function. */
export type CreateAgentSessionFn = (opts: Record<string, unknown>) => Promise<{
  session: PiSession;
}>;

/** Minimal shape of Pi's AgentSession. */
export interface PiSession {
  prompt(text: string, opts?: Record<string, unknown>): Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  dispose(): void;
  abort?(): Promise<void>;
}

/** Minimal shape of a Pi ToolDefinition. */
export interface PiToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// PiSdkEngine options
// ---------------------------------------------------------------------------

export interface PiSdkEngineOptions {
  contextDir: string;
  workspaceDir: string;
  agentConfig: ManagementAgentConfig;
  /** Inject createAgentSession for testing. If not provided, dynamically imports Pi SDK. */
  createAgentSession?: CreateAgentSessionFn;
}

// ---------------------------------------------------------------------------
// Capability → Pi tool mapping helper
// ---------------------------------------------------------------------------

/** Stub tool descriptor when Pi SDK is not available. */
function stubTool(name: string): { name: string } {
  return { name };
}

function buildPiTools(
  capabilities: string[],
  workspaceDir: string,
  piModule: any,
): unknown[] {
  const caps = new Set(capabilities);
  const tools: unknown[] = [];

  if (caps.has("EDIT") || caps.has("RUN_COMMANDS")) {
    // Full coding tools: read, bash, edit, write
    if (piModule?.createCodingTools) {
      tools.push(...piModule.createCodingTools(workspaceDir));
    } else {
      // Fallback: stub tools for testing / when Pi SDK unavailable
      tools.push(stubTool("read"), stubTool("bash"), stubTool("edit"), stubTool("write"));
    }
  } else if (caps.has("RUN_TESTS")) {
    // Read + restricted bash
    if (piModule?.createReadOnlyTools) {
      tools.push(...piModule.createReadOnlyTools(workspaceDir));
    } else {
      tools.push(stubTool("read"), stubTool("grep"), stubTool("find"), stubTool("ls"));
    }
    if (piModule?.createBashTool) {
      tools.push(piModule.createBashTool(workspaceDir));
    } else {
      tools.push(stubTool("bash"));
    }
  } else if (caps.has("READ")) {
    // Read-only tools: read, grep, find, ls
    if (piModule?.createReadOnlyTools) {
      tools.push(...piModule.createReadOnlyTools(workspaceDir));
    } else {
      tools.push(stubTool("read"), stubTool("grep"), stubTool("find"), stubTool("ls"));
    }
  }

  return tools;
}

// ---------------------------------------------------------------------------
// PiSdkEngine
// ---------------------------------------------------------------------------

export class PiSdkEngine implements ManagementAgentEngine {
  private readonly contextDir: string;
  private readonly workspaceDir: string;
  private readonly agentConfig: ManagementAgentConfig;
  private readonly createAgentSessionFn: CreateAgentSessionFn | undefined;

  private session: PiSession | null = null;
  private sessionPromise: Promise<PiSession> | null = null;

  /** Captured directive from the last decision tool call. */
  private capturedDirective: ManagementDirective | null = null;
  private capturedMeta: { reasoning?: string; confidence?: number } | null = null;
  private capturedHookId: string | null = null;

  /** When false, the decision tool rejects calls (e.g. after timeout/abort). */
  private acceptingToolCalls = false;

  constructor(opts: PiSdkEngineOptions) {
    this.contextDir = opts.contextDir;
    this.workspaceDir = opts.workspaceDir;
    this.agentConfig = opts.agentConfig;
    this.createAgentSessionFn = opts.createAgentSession;
  }

  async invokeHook(args: {
    hook: ManagementHook;
    hookId: string;
    hookStartedAt: number;
    context: HookContext;
    invocationPaths?: {
      invDir: string;
      inputFile: string;
      decisionFile: string;
    };
    budget: {
      deadlineAt: number;
      maxSteps?: number;
      maxCommandTimeMs?: number;
    };
    abortSignal: AbortSignal;
  }): Promise<ManagementAgentEngineResult> {
    const { hook, hookId, context, budget, abortSignal, invocationPaths } = args;

    const invDir = invocationPaths?.invDir ?? path.join(this.contextDir, "_management", "inv", hookId);
    const inputFile = invocationPaths?.inputFile ?? path.join(invDir, "input.json");
    const decisionFile = invocationPaths?.decisionFile ?? path.join(invDir, "decision.json");
    if (!invocationPaths) {
      // Direct engine invocation path (outside ManagementController).
      await mkdir(invDir, { recursive: true });
      await writeFile(inputFile, JSON.stringify(context, null, 2));
    }

    // Reset captured state and enable tool calls for this invocation
    this.capturedDirective = null;
    this.capturedMeta = null;
    this.capturedHookId = null;
    this.acceptingToolCalls = true;

    try {
      // Ensure session exists
      const session = await this.ensureSession();

      // Build prompt
      const prompt = this.buildPrompt(hook, hookId, context, inputFile);

      const timeoutMs = Math.max(0, budget.deadlineAt - Date.now());
      const stopSessionPrompt = () => {
        this.acceptingToolCalls = false;
        if (session.abort) {
          session.abort().catch(() => {});
        }
      };

      const promptEffect = Effect.tryPromise<void, Error>({
        try: () => session.prompt(prompt),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });

      try {
        await runEffectPromise(
          raceAbort(
            withTimeout(promptEffect, timeoutMs, () => {
              stopSessionPrompt();
              return new ManagementHookTimeoutError();
            }),
            abortSignal,
            () => {
              stopSessionPrompt();
              return new ManagementHookAbortedError();
            },
          ),
        );
      } catch (err) {
        if (
          err instanceof ManagementHookTimeoutError ||
          err instanceof ManagementHookAbortedError
        ) {
          return {
            directive: { ...DEFAULT_PROCEED_DIRECTIVE },
            source: "fallback",
            reason: err.message,
          };
        }
        throw err;
      }

      // Disable further tool calls now that we've read the result
      this.acceptingToolCalls = false;

      // Read captured state — TS CFA can't see across the async prompt() callback
      // that mutates these fields, so use type assertions to break narrowing.
      const capturedDir = this.capturedDirective as ManagementDirective | null;
      const capturedMeta = this.capturedMeta as { reasoning?: string; confidence?: number } | null;
      const capturedHId = this.capturedHookId as string | null;

      if (capturedDir && capturedHId === hookId) {
        // Write decision.json for audit parity
        const decisionData = {
          hook_id: hookId,
          hook,
          step_id: context.step_id,
          directive: capturedDir,
          ...(capturedMeta?.reasoning ? { reasoning: capturedMeta.reasoning } : {}),
          ...(capturedMeta?.confidence !== undefined
            ? { confidence: capturedMeta.confidence }
            : {}),
        };
        await writeFile(decisionFile, JSON.stringify(decisionData, null, 2));

        return {
          directive: capturedDir,
          meta: capturedMeta ?? undefined,
        };
      }

      // Tool was not called or hook_id didn't match — default to proceed
      return {
        directive: { ...DEFAULT_PROCEED_DIRECTIVE },
        source: "fallback" as const,
        reason: "decision tool was not called or hook_id did not match",
      };
    } catch (err) {
      // Any error → proceed
      const detail = err instanceof Error ? err.message : String(err);
      return {
        directive: { ...DEFAULT_PROCEED_DIRECTIVE },
        source: "fallback" as const,
        reason: `pi sdk hook execution failed: ${detail}`,
      };
    } finally {
      this.acceptingToolCalls = false;
    }
  }

  async dispose(): Promise<void> {
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
    this.sessionPromise = null;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async ensureSession(): Promise<PiSession> {
    if (this.session) return this.session;
    if (this.sessionPromise) return this.sessionPromise;

    this.sessionPromise = this.createSession();
    this.session = await this.sessionPromise;
    return this.session;
  }

  private async createSession(): Promise<PiSession> {
    const createFn = this.createAgentSessionFn ?? (await this.loadPiSdk());

    // Build the decision custom tool
    const decisionTool = this.buildDecisionTool();

    // Build Pi tools from capabilities
    let piModule: any = null;
    if (!this.createAgentSessionFn) {
      try {
        piModule = await import("@mariozechner/pi-coding-agent");
      } catch {
        // Pi SDK not available — tools will be empty
      }
    }

    const tools = buildPiTools(
      this.agentConfig.capabilities ?? ["READ"],
      this.workspaceDir,
      piModule,
    );

    const sessionOpts: Record<string, unknown> = {
      cwd: this.workspaceDir,
      customTools: [decisionTool],
      ...(tools.length > 0 ? { tools } : {}),
    };

    // Set model if specified
    if (this.agentConfig.model) {
      sessionOpts.model = this.agentConfig.model;
    }

    // Use in-memory session manager (no persistence needed for management)
    if (piModule?.SessionManager) {
      sessionOpts.sessionManager = piModule.SessionManager.inMemory();
    } else {
      // For testing with mock createAgentSession
      sessionOpts.sessionManager = { type: "in-memory" };
    }

    const { session } = await createFn(sessionOpts);
    return session;
  }

  private async loadPiSdk(): Promise<CreateAgentSessionFn> {
    try {
      const piModule = await import("@mariozechner/pi-coding-agent");
      return piModule.createAgentSession as CreateAgentSessionFn;
    } catch {
      throw new Error(
        "Pi coding-agent SDK (@mariozechner/pi-coding-agent) is not installed. " +
        "Install it or use engine: 'worker' instead.",
      );
    }
  }

  private buildDecisionTool(): PiToolDefinition {
    return {
      name: "roboppi_management_decision",
      label: "Management Decision",
      description:
        "Return a management directive for the current hook. " +
        "You MUST call this tool exactly once with your decision.",
      parameters: {
        type: "object",
        properties: {
          hook_id: { type: "string", description: "The hook_id from the current invocation." },
          hook: { type: "string", description: "The hook name." },
          step_id: { type: "string", description: "The step ID." },
          directive: {
            type: "object",
            description: "The management directive.",
            properties: {
              action: { type: "string" },
            },
            required: ["action"],
          },
          reasoning: { type: "string", description: "Optional reasoning for the decision." },
          confidence: { type: "number", description: "Optional confidence score (0-1)." },
        },
        required: ["hook_id", "hook", "step_id", "directive"],
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const hookId = params.hook_id as string;
        const directive = params.directive as ManagementDirective;
        const reasoning = params.reasoning as string | undefined;
        const confidence = params.confidence as number | undefined;

        // Reject late calls from a timed-out/aborted invocation
        if (!this.acceptingToolCalls) {
          return {
            content: [{ type: "text", text: "Decision rejected: invocation expired." }],
            details: {},
          };
        }

        // Validate action
        if (directive && typeof directive.action === "string" &&
            VALID_MANAGEMENT_ACTIONS.has(directive.action as ManagementAction)) {
          this.capturedHookId = hookId;
          this.capturedDirective = directive;
          this.capturedMeta = {
            ...(reasoning ? { reasoning } : {}),
            ...(confidence !== undefined ? { confidence } : {}),
          };
        }

        return {
          content: [{ type: "text", text: "Decision recorded." }],
          details: {},
        };
      },
    };
  }

  private buildPrompt(
    hook: ManagementHook,
    hookId: string,
    context: HookContext,
    inputFile: string,
  ): string {
    const baseInstructions = this.agentConfig.base_instructions ?? "";

    return [
      baseInstructions,
      "",
      `## Current Hook Invocation`,
      `- hook: ${hook}`,
      `- hook_id: ${hookId}`,
      `- step_id: ${context.step_id}`,
      `- input_file: ${inputFile}`,
      "",
      `## Workflow State`,
      JSON.stringify(context.workflow_state, null, 2),
      "",
      `## Step State`,
      JSON.stringify(context.step_state, null, 2),
      "",
      ...(context.stall_event
        ? [
            `## Stall Event`,
            JSON.stringify(context.stall_event, null, 2),
            "",
          ]
        : []),
      ...(context.check_result
        ? [
            `## Check Result`,
            JSON.stringify(context.check_result, null, 2),
            "",
          ]
        : []),
      ...(context.context_hint
        ? [`## Context Hint`, context.context_hint, ""]
        : []),
      `## Instructions`,
      `Call the \`roboppi_management_decision\` tool exactly once with your decision.`,
      `Include hook_id: "${hookId}" in your tool call.`,
      `Default to { action: "proceed" } unless you have strong evidence for intervention.`,
    ].join("\n");
  }
}
