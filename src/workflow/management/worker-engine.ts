/**
 * WorkerEngine — wraps the existing file-based worker invocation in the
 * ManagementAgentEngine interface.
 *
 * The management worker is run via StepRunner.runStep(), and the decision
 * is read from the decision.json file written by the worker.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import type { StepRunner } from "../executor.js";
import type { StepDefinition } from "../types.js";
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
  HookContext,
} from "./types.js";
import {
  ENV_MANAGEMENT_HOOK_ID,
  ENV_MANAGEMENT_INPUT_FILE,
  ENV_MANAGEMENT_DECISION_FILE,
  DEFAULT_PROCEED_DIRECTIVE,
} from "./types.js";
import { resolveManagementDecision } from "./decision-resolver.js";
import { ManagementEventSink } from "./management-event-sink.js";

// ---------------------------------------------------------------------------
// WorkerEngine options
// ---------------------------------------------------------------------------

export interface WorkerEngineOptions {
  contextDir: string;
  stepRunner: StepRunner;
  workspaceDir: string;
  agentConfig: ManagementAgentConfig;
  baseEnv?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// WorkerEngine
// ---------------------------------------------------------------------------

export class WorkerEngine implements ManagementAgentEngine {
  private readonly contextDir: string;
  private readonly stepRunner: StepRunner;
  private readonly workspaceDir: string;
  private readonly agentConfig: ManagementAgentConfig;
  private readonly baseEnv?: Record<string, string>;

  constructor(opts: WorkerEngineOptions) {
    this.contextDir = opts.contextDir;
    this.stepRunner = opts.stepRunner;
    this.workspaceDir = opts.workspaceDir;
    this.agentConfig = opts.agentConfig;
    this.baseEnv = opts.baseEnv;
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
    const { hook, hookId, hookStartedAt, context, budget, abortSignal, invocationPaths } = args;

    const invDir = invocationPaths?.invDir ?? path.join(this.contextDir, "_management", "inv", hookId);
    const inputFile = invocationPaths?.inputFile ?? path.join(invDir, "input.json");
    const decisionFile = invocationPaths?.decisionFile ?? path.join(invDir, "decision.json");
    if (!invocationPaths) {
      // Direct engine invocation path (outside ManagementController).
      await mkdir(invDir, { recursive: true });
      await writeFile(inputFile, JSON.stringify(context, null, 2));
    }

    // Build the management worker step definition
    const mgmtStepDef: StepDefinition = {
      worker: this.agentConfig.worker ?? "OPENCODE",
      model: this.agentConfig.model,
      instructions: this.agentConfig.base_instructions ?? "You are a workflow management agent.",
      capabilities: this.agentConfig.capabilities ?? ["READ"],
      timeout: this.agentConfig.timeout,
      max_steps: this.agentConfig.max_steps,
      max_command_time: this.agentConfig.max_command_time,
    };

    // Build env vars
    const mgmtEnv: Record<string, string> = {
      ...(this.baseEnv ?? {}),
      [ENV_MANAGEMENT_HOOK_ID]: hookId,
      [ENV_MANAGEMENT_INPUT_FILE]: inputFile,
      [ENV_MANAGEMENT_DECISION_FILE]: decisionFile,
    };

    const timeoutMs = Math.max(0, budget.deadlineAt - Date.now());
    const hookAbortController = new AbortController();
    let abortedOrTimedOut = false;

    const runWorker = Effect.tryPromise<void, Error>({
      try: async () => {
        const managementSink = new ManagementEventSink(invDir);
        await this.stepRunner.runStep(
          `_management:${hook}:${context.step_id}`,
          mgmtStepDef,
          this.workspaceDir,
          hookAbortController.signal,
          mgmtEnv,
          managementSink,
        );
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });

    try {
      await runEffectPromise(
        raceAbort(
          withTimeout(runWorker, timeoutMs, () => {
            abortedOrTimedOut = true;
            hookAbortController.abort("management hook timeout");
            return new ManagementHookTimeoutError();
          }),
          abortSignal,
          () => {
            abortedOrTimedOut = true;
            hookAbortController.abort(abortSignal.reason ?? "management hook aborted");
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
      // Worker execution errors still fall through to decision resolution.
    } finally {
      if (!hookAbortController.signal.aborted) {
        hookAbortController.abort("management hook completed");
      }
    }

    if (abortSignal.aborted || abortedOrTimedOut) {
      return {
        directive: { ...DEFAULT_PROCEED_DIRECTIVE },
        source: "fallback",
        reason: abortSignal.aborted
          ? "management hook aborted"
          : "management hook timed out",
      };
    }

    // Resolve the decision file
    const resolution = await resolveManagementDecision(
      decisionFile,
      hookId,
      hook,
      context.step_id,
      hookStartedAt,
    );

    // Determine if this was a genuine decision or a fallback
    const isFallback =
      resolution.source === "none" ||
      resolution.hookIdMatch === false ||
      !!resolution.reason;

    return {
      directive: resolution.directive,
      meta: {
        ...(resolution.reasoning ? { reasoning: resolution.reasoning } : {}),
        ...(resolution.confidence !== undefined ? { confidence: resolution.confidence } : {}),
      },
      ...(isFallback && resolution.reason ? { reason: resolution.reason } : {}),
      source: isFallback ? "fallback" : "decided",
    };
  }

  async dispose(): Promise<void> {
    // No-op: worker engine has no persistent state
  }
}
