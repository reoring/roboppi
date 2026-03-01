/**
 * ManagementController — orchestrates management agent hook invocations.
 *
 * Responsibilities:
 * - Generate hook_id, create invocation directories
 * - Delegate to a ManagementAgentEngine (WorkerEngine or PiSdkEngine)
 * - Validate decisions against permission matrix and step state
 * - Write decisions.jsonl audit log
 * - Enforce runaway guards (max_consecutive_interventions, min_remaining_time)
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { StepRunner } from "../executor.js";
import type { StepDefinition, StepState } from "../types.js";
import { StepStatus } from "../types.js";
import { parseDuration } from "../duration.js";
import type {
  ManagementConfig,
  ManagementHook,
  ManagementDirective,
  ManagementAgentEngine,
  ManagementAgentEngineResult,
  DecisionsLogEntry,
} from "./types.js";
import {
  DEFAULT_PROCEED_DIRECTIVE,
} from "./types.js";
import { HookContextBuilder } from "./hook-context-builder.js";
import { validateDirective, validateDirectiveShape } from "./directive-validator.js";
import { createEngine } from "./engine-factory.js";

// ---------------------------------------------------------------------------
// ManagementController
// ---------------------------------------------------------------------------

export class ManagementController {
  private readonly contextDir: string;
  private readonly config: ManagementConfig;
  private readonly engine: ManagementAgentEngine;
  private readonly contextBuilder: HookContextBuilder;
  private readonly hookTimeoutMs: number;
  private readonly maxConsecutiveInterventions: number;
  private readonly minRemainingTimeMs: number;

  private consecutiveInterventions = 0;
  private decisionsLogPath: string;
  private initPromise: Promise<void> | null = null;

  /**
   * Create a ManagementController.
   *
   * Supports two constructor signatures:
   * 1. (contextDir, config, engine) — engine abstraction (new)
   * 2. (contextDir, config, stepRunner, workspaceDir, baseEnv?) — legacy (creates WorkerEngine)
   */
  constructor(
    contextDir: string,
    config: ManagementConfig,
    engineOrStepRunner: ManagementAgentEngine | StepRunner,
    workspaceDir?: string,
    baseEnv?: Record<string, string>,
  ) {
    this.contextDir = contextDir;
    this.config = config;
    this.contextBuilder = new HookContextBuilder(contextDir);

    this.hookTimeoutMs = config.agent?.timeout
      ? parseDuration(config.agent.timeout)
      : 30_000;
    this.maxConsecutiveInterventions =
      config.max_consecutive_interventions ?? 10;
    this.minRemainingTimeMs = config.min_remaining_time
      ? parseDuration(config.min_remaining_time)
      : 0;

    this.decisionsLogPath = path.join(
      contextDir,
      "_management",
      "decisions.jsonl",
    );

    // Determine if we received an engine or a step runner
    if (this.isManagementAgentEngine(engineOrStepRunner)) {
      this.engine = engineOrStepRunner;
    } else {
      // Legacy: wrap step runner in a WorkerEngine
      this.engine = createEngine(config.agent?.engine, {
        contextDir,
        stepRunner: engineOrStepRunner,
        workspaceDir: workspaceDir!,
        agentConfig: config.agent ?? {},
        baseEnv,
      });
    }
  }

  private isManagementAgentEngine(obj: unknown): obj is ManagementAgentEngine {
    return (
      typeof obj === "object" &&
      obj !== null &&
      "invokeHook" in obj &&
      "dispose" in obj &&
      typeof (obj as Record<string, unknown>).invokeHook === "function" &&
      typeof (obj as Record<string, unknown>).dispose === "function"
    );
  }

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = mkdir(
        path.join(this.contextDir, "_management"),
        { recursive: true },
      ).then(() => {});
    }
    return this.initPromise!;
  }

  /**
   * Check if a specific hook is enabled for a step.
   */
  isHookEnabled(
    hook: ManagementHook,
    stepDef?: StepDefinition,
  ): boolean {
    if (!this.config.enabled) return false;

    // Step-level override
    const stepMgmt = stepDef?.management;
    if (stepMgmt?.enabled === false) return false;

    const stepOverride = (stepMgmt as unknown as Record<string, unknown> | undefined)?.[hook];
    if (typeof stepOverride === "boolean") {
      return stepOverride;
    }

    // Workflow-level hook config
    const hooks = this.config.hooks;
    if (!hooks) return false;

    return (hooks as Record<string, boolean | undefined>)[hook] === true;
  }

  /**
   * Check if we should skip this hook invocation due to runaway guards.
   */
  shouldSkipHook(workflowStartedAt: number, workflowTimeoutMs: number): boolean {
    // min_remaining_time guard
    if (this.minRemainingTimeMs > 0) {
      const elapsed = Date.now() - workflowStartedAt;
      const remaining = workflowTimeoutMs - elapsed;
      if (remaining < this.minRemainingTimeMs) {
        return true;
      }
    }

    // max_consecutive_interventions guard
    if (this.consecutiveInterventions >= this.maxConsecutiveInterventions) {
      // NOTE: callers that rely on shouldSkipHook() must ensure this does not
      // become a permanent bypass. The preferred path is to let invokeHook()
      // handle guards (it resets the streak when forcing proceed).
      return true;
    }

    return false;
  }

  /**
   * Invoke a management hook and return the validated directive.
   */
  async invokeHook(
    hook: ManagementHook,
    stepId: string,
    stepStatus: StepStatus,
    steps: Record<string, StepState>,
    abortSignal: AbortSignal,
    opts?: {
      contextHint?: string;
      stallEvent?: unknown;
      checkResult?: unknown;
      workflowStartedAt?: number;
      workflowTimeoutMs?: number;
    },
  ): Promise<ManagementDirective> {
    // Guard: min_remaining_time / max_consecutive_interventions.
    // If we bypass, we do NOT create an invocation directory.
    const workflowStartedAt = opts?.workflowStartedAt;
    const workflowTimeoutMs = opts?.workflowTimeoutMs;

    let bypassReason: string | null = null;

    // min_remaining_time guard (only when we have timing info)
    if (
      bypassReason === null &&
      this.minRemainingTimeMs > 0 &&
      workflowStartedAt !== undefined &&
      workflowTimeoutMs !== undefined
    ) {
      const elapsed = Date.now() - workflowStartedAt;
      const remaining = workflowTimeoutMs - elapsed;
      if (remaining < this.minRemainingTimeMs) {
        bypassReason = "bypassed by min_remaining_time";
      }
    }

    // max_consecutive_interventions guard
    if (
      bypassReason === null &&
      this.consecutiveInterventions >= this.maxConsecutiveInterventions
    ) {
      bypassReason = "bypassed by max_consecutive_interventions";
    }

    if (bypassReason !== null) {
      await this.ensureInit();

      // If this was a max_consecutive_interventions trigger, reset the streak so
      // management degrades to safe proceed rather than permanently disabling hooks.
      if (this.consecutiveInterventions >= this.maxConsecutiveInterventions) {
        this.consecutiveInterventions = 0;
      }

      const hookId = crypto.randomUUID();
      const logEntry: DecisionsLogEntry = {
        ts: Date.now(),
        hook_id: hookId,
        hook,
        step_id: stepId,
        directive: { ...DEFAULT_PROCEED_DIRECTIVE },
        applied: false,
        wallTimeMs: 0,
        source: "fallback",
        reason: bypassReason,
      };
      await appendFile(this.decisionsLogPath, JSON.stringify(logEntry) + "\n");

      return { ...DEFAULT_PROCEED_DIRECTIVE };
    }

    await this.ensureInit();

    const hookId = crypto.randomUUID();
    const hookStartedAt = Date.now();

    // Build context and write input.json (single source of truth)
    const { context, invDir, inputFile, decisionFile } =
      await this.contextBuilder.buildAndWrite(
        hookId,
        hook,
        stepId,
        steps,
        opts,
      );

    // If workflow was aborted, return proceed
    if (abortSignal.aborted) {
      return { ...DEFAULT_PROCEED_DIRECTIVE };
    }

    // Invoke the engine
    let engineResult: ManagementAgentEngineResult;
    let engineInvokeReason: string | undefined;
    try {
      engineResult = await this.engine.invokeHook({
        hook,
        hookId,
        hookStartedAt,
        context,
        invocationPaths: { invDir, inputFile, decisionFile },
        budget: {
          deadlineAt: Date.now() + this.hookTimeoutMs,
        },
        abortSignal,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      engineInvokeReason = `engine invokeHook threw: ${detail}`;
      engineResult = { directive: { ...DEFAULT_PROCEED_DIRECTIVE }, source: "fallback" };
    }

    let finalDirective = engineResult.directive;
    let applied = engineResult.source !== "fallback";
    let reason: string | undefined = engineInvokeReason ?? engineResult.reason;

    // If engine returned a fallback, mark as not applied
    if (engineResult.source === "fallback") {
      applied = false;
      if (!reason) {
        reason = "engine fallback (timeout, error, or missing decision)";
      }
    }

    // Validate directive shape (required fields, bounds). This is required for
    // PiSdkEngine tool calls as well as file-based decisions.
    const shape = validateDirectiveShape(finalDirective as unknown);
    if (!shape.valid) {
      applied = false;
      reason = shape.reason ?? "directive shape validation failed";
      finalDirective = { ...DEFAULT_PROCEED_DIRECTIVE };
    } else {
      finalDirective = shape.directive!;
    }

    // Validate against permission matrix and step state
    if (finalDirective.action !== "proceed") {
      const validation = validateDirective(finalDirective, hook, stepStatus);
      if (!validation.valid) {
        applied = false;
        reason = validation.reason ?? "directive validation failed";
        finalDirective = { ...DEFAULT_PROCEED_DIRECTIVE };
      }
    }

    // Update consecutive interventions counter
    if (finalDirective.action !== "proceed" && applied) {
      this.consecutiveInterventions++;
    } else if (finalDirective.action === "proceed") {
      this.consecutiveInterventions = 0;
    }

    // Write to decisions.jsonl
    const wallTimeMs = Date.now() - hookStartedAt;
    const logEntry: DecisionsLogEntry = {
      ts: Date.now(),
      hook_id: hookId,
      hook,
      step_id: stepId,
      directive: finalDirective,
      applied,
      wallTimeMs,
      source: engineResult.source ?? "decided",
      ...(reason ? { reason } : {}),
      ...(engineResult.meta?.reasoning ? { reasoning: engineResult.meta.reasoning } : {}),
      ...(engineResult.meta?.confidence !== undefined
        ? { confidence: engineResult.meta.confidence }
        : {}),
    };

    await appendFile(
      this.decisionsLogPath,
      JSON.stringify(logEntry) + "\n",
    );

    return finalDirective;
  }

  /**
   * Stop the controller and dispose the engine.
   */
  async stop(): Promise<void> {
    await this.engine.dispose();
  }
}
