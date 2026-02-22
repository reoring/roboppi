import { ErrorClass } from "../types/common.js";
import type { Artifact, Observation, WorkerCost } from "../types/worker-result.js";
import { mkdir, readFile, writeFile, cp, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  WorkflowDefinition,
  StepDefinition,
  CompletionCheckDef,
  WorkflowState,
  StepState,
  ConvergenceDef,
  ExportRef,
} from "./types.js";
import { WorkflowStatus, StepStatus, isSubworkflowStep } from "./types.js";
import { validateDag } from "./dag-validator.js";
import { parseDuration } from "./duration.js";
import { ContextManager } from "./context-manager.js";
import { resolveTaskLike } from "./resolve-worker-task.js";
import type { CompletionDecisionSource } from "./completion-decision.js";
import type { BranchRuntimeContext } from "./branch-context.js";
import { toBranchWorkflowMeta } from "./branch-context.js";
import type { ExecEventSink } from "../tui/exec-event.js";
import { NoopExecEventSink } from "../tui/noop-sink.js";
import { loadChildWorkflow } from "./workflow-loader.js";
import { assertNoRecursion, resolveMaxNestingDepth, SubworkflowRecursionError, SubworkflowDepthError } from "./recursion-guard.js";
import type { AgentCatalog } from "./agent-catalog.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface StepRunResult {
  status: "SUCCEEDED" | "FAILED";
  errorClass?: ErrorClass;
  artifacts?: Artifact[];
  observations?: Observation[];
  cost?: WorkerCost;
}

export interface CheckResult {
  complete: boolean;
  failed: boolean;
  errorClass?: ErrorClass;
  reason?: string;

  /**
   * Optional: completion decision diagnostics.
   * When present, used for convergence guarding and debuggability.
   */
  decisionSource?: CompletionDecisionSource;
  decisionCheckIdMatch?: boolean;

  /** Optional: structured diagnostics from completion_check decision_file. */
  reasons?: string[];
  fingerprints?: string[];
}

const COMPLETION_INFRA_FAILURE_LIMIT = 2;

const DEFAULT_CONVERGENCE_STALL_THRESHOLD = 2;
const DEFAULT_CONVERGENCE_MAX_STAGE = 3;
const CONVERGENCE_ARTIFACT_DIR = "_convergence";
const MAX_CONVERGENCE_SIGNAL_ITEMS = 40;

export interface StepRunner {
  runStep(
    stepId: string,
    step: StepDefinition,
    workspaceDir: string,
    abortSignal: AbortSignal,
    env?: Record<string, string>,
  ): Promise<StepRunResult>;

  runCheck(
    stepId: string,
    check: CompletionCheckDef,
    workspaceDir: string,
    abortSignal: AbortSignal,
    env?: Record<string, string>,
  ): Promise<CheckResult>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set<StepStatus>([
  StepStatus.SUCCEEDED,
  StepStatus.FAILED,
  StepStatus.INCOMPLETE,
  StepStatus.SKIPPED,
  StepStatus.CANCELLED,
]);

function isTerminal(status: StepStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Returns true if the dependency allows downstream steps to proceed. */
function depAllowsProgress(
  depState: StepState,
  depDef: StepDefinition,
): boolean {
  if (depState.status === StepStatus.SUCCEEDED) return true;
  if (depState.status === StepStatus.INCOMPLETE) return true;
  if (
    depState.status === StepStatus.FAILED &&
    depDef.on_failure === "continue"
  ) {
    return true;
  }
  return false;
}

/** Returns true if the dependency blocks downstream (abort / fatal). */
function depBlocksDownstream(
  depState: StepState,
  depDef: StepDefinition,
): boolean {
  if (depState.status === StepStatus.SKIPPED) return true;
  if (depState.status === StepStatus.CANCELLED) return true;
  if (
    depState.status === StepStatus.FAILED &&
    depDef.on_failure !== "continue"
  ) {
    return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// WorkflowExecutor
// ---------------------------------------------------------------------------

export interface WorkflowExecutorOptions {
  /** Absolute path of this workflow YAML (for subworkflow path resolution). */
  definitionPath?: string;
  /** Call stack of workflow file paths for recursion detection. */
  workflowCallStack?: string[];
  /** Agent catalog for loading child workflows. */
  agentCatalog?: AgentCatalog;
  /** Maximum subworkflow nesting depth. */
  maxNestingDepth?: number;
}

export class WorkflowExecutor {
  private readonly steps: Record<string, StepState> = {};
  private readonly stepDefs: Record<string, StepDefinition>;
  private readonly concurrency: number;
  private readonly workflowTimeoutMs: number;
  private runningCount = 0;
  private workflowAbortController: AbortController | null = null;
  private abortReason: "timeout" | "external" | null = null;
  private workflowStartedAt: number | null = null;

  // Internal: latest convergence signals per step (not persisted in StepState).
  private readonly convergenceSignals: Record<string, {
    fingerprints?: string[];
    reasons?: string[];
    lastStallKey?: string;
  }> = {};

  // Notification mechanism — resolved whenever a step reaches a terminal state
  // or when a running slot becomes free.
  private notifyResolve: (() => void) | null = null;
  private pendingNotification = false;

  // Subworkflow options
  private readonly definitionPath?: string;
  private readonly workflowCallStack: string[];
  private readonly agentCatalog?: AgentCatalog;
  private readonly maxNestingDepth: number;

  constructor(
    private readonly definition: WorkflowDefinition,
    private readonly contextManager: ContextManager,
    private readonly stepRunner: StepRunner,
    private readonly workspaceDir: string,
    private readonly env?: Record<string, string>,
    private readonly abortSignal?: AbortSignal,
    private readonly branchContext?: BranchRuntimeContext,
    private readonly supervised: boolean = false,
    private readonly sink: ExecEventSink = new NoopExecEventSink(),
    options?: WorkflowExecutorOptions,
  ) {
    this.stepDefs = definition.steps;
    this.concurrency =
      definition.concurrency != null ? definition.concurrency : Infinity;
    this.workflowTimeoutMs = parseDuration(definition.timeout);
    this.definitionPath = options?.definitionPath;
    this.workflowCallStack = options?.workflowCallStack ?? (this.definitionPath ? [this.definitionPath] : []);
    this.agentCatalog = options?.agentCatalog;
    this.maxNestingDepth = resolveMaxNestingDepth(options?.maxNestingDepth);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  async execute(): Promise<WorkflowState> {
    // 1. Validate DAG
    const dagErrors = validateDag(this.definition);
    if (dagErrors.length > 0) {
      throw new Error(
        `Workflow DAG validation failed: ${dagErrors.map((e) => e.message).join("; ")}`,
      );
    }

    // 2. Initialize step states and context
    const workflowId = crypto.randomUUID();
    const startedAt = Date.now();
    this.workflowStartedAt = startedAt;
    await this.contextManager.initWorkflow(
      workflowId,
      this.definition.name,
      startedAt,
      this.buildWorkflowMetaExtras(),
    );
    this.sink.emit({
      type: "workflow_started",
      workflowId,
      name: this.definition.name,
      workspaceDir: this.workspaceDir,
      supervised: this.supervised,
      startedAt,
      definitionSummary: {
        steps: Object.keys(this.stepDefs),
        concurrency: this.concurrency === Infinity ? undefined : this.concurrency,
        timeout: this.definition.timeout,
      },
    });
    for (const [stepId, stepDef] of Object.entries(this.stepDefs)) {
      const maxIter = stepDef.max_iterations ?? 1;
      this.steps[stepId] = {
        status: StepStatus.PENDING,
        iteration: 0,
        maxIterations: maxIter,
      };
      await this.contextManager.initStep(stepId);
    }

    // 3. Set up workflow-level abort controller for timeout
    this.workflowAbortController = new AbortController();

    const timeoutId = setTimeout(() => {
      if (this.abortReason === null) this.abortReason = "timeout";
      this.workflowAbortController!.abort();
    }, this.workflowTimeoutMs);

    const onExternalAbort = () => {
      if (this.abortReason === null) this.abortReason = "external";
      this.workflowAbortController!.abort();
    };

    if (this.abortSignal) {
      if (this.abortSignal.aborted) {
        onExternalAbort();
      } else {
        this.abortSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    let workflowStatus: WorkflowStatus = WorkflowStatus.FAILED;
    let completedAt = startedAt;
    let executionError: unknown = null;

    try {
      // 4. Run the scheduling loop
      await this.schedulingLoop();
      workflowStatus = this.computeWorkflowStatus();
    } catch (err) {
      executionError = err;
      if (this.workflowAbortController.signal.aborted) {
        workflowStatus = this.abortReason === "external"
          ? WorkflowStatus.CANCELLED
          : WorkflowStatus.TIMED_OUT;
      } else {
        workflowStatus = WorkflowStatus.FAILED;
      }
    } finally {
      clearTimeout(timeoutId);
      if (this.abortSignal) {
        this.abortSignal.removeEventListener("abort", onExternalAbort);
      }
      completedAt = Date.now();
      this.sink.emit({
        type: "workflow_finished",
        status: workflowStatus,
        completedAt,
      });
      await this.contextManager.writeWorkflowMeta({
        id: workflowId,
        name: this.definition.name,
        startedAt,
        status: workflowStatus,
        completedAt,
        resolved: {
          timeoutMs: this.workflowTimeoutMs,
          concurrency: this.concurrency,
        },
        ...this.buildWorkflowMetaExtras(),
      });
    }

    if (executionError !== null) {
      throw executionError;
    }

    return {
      workflowId,
      name: this.definition.name,
      status: workflowStatus,
      steps: { ...this.steps },
      startedAt,
      completedAt,
    };
  }

  // -----------------------------------------------------------------------
  // Scheduling loop — event/promise-based
  // -----------------------------------------------------------------------

  private async schedulingLoop(): Promise<void> {
    // Start initial ready steps
    this.updateReadySteps();
    this.launchReadySteps();

    while (!this.allTerminal()) {
      // If workflow was timed out / aborted
      if (this.workflowAbortController!.signal.aborted) {
        this.handleWorkflowTimeout();
        // Wait for all running steps to finish (they should be aborting)
        while (this.runningCount > 0) {
          await this.waitForNotification();
        }
        break;
      }

      // Wait for something to happen
      await this.waitForNotification();

      // Re-evaluate
      this.updateReadySteps();
      this.launchReadySteps();
    }
  }

  private waitForNotification(): Promise<void> {
    // If a notification fired before we started waiting, consume it immediately
    if (this.pendingNotification) {
      this.pendingNotification = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const signal = this.workflowAbortController!.signal;

      // If the workflow is already aborted, yield to the event loop so
      // in-flight step cancellations can make progress (avoid microtask spin).
      if (signal.aborted) {
        setTimeout(resolve, 0);
        return;
      }
      const onAbort = () => {
        this.notifyResolve = null;
        resolve();
      };
      this.notifyResolve = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      // Also resolve on workflow abort so we don't hang
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private notify(): void {
    if (this.notifyResolve) {
      const resolve = this.notifyResolve;
      this.notifyResolve = null;
      resolve();
    } else {
      this.pendingNotification = true;
    }
  }

  // -----------------------------------------------------------------------
  // Step readiness
  // -----------------------------------------------------------------------

  private updateReadySteps(): void {
    for (const [stepId, state] of Object.entries(this.steps)) {
      if (state.status !== StepStatus.PENDING) continue;

      const stepDef = this.stepDefs[stepId]!;
      const deps = stepDef.depends_on ?? [];

      if (deps.length === 0) {
        state.status = StepStatus.READY;
        this.sink.emit({
          type: "step_state",
          stepId,
          status: state.status,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
        });
        continue;
      }

      let allResolved = true;
      let shouldSkip = false;

      for (const depId of deps) {
        const depState = this.steps[depId];
        const depDef = this.stepDefs[depId];
        if (!depState || !depDef) continue;

        if (depBlocksDownstream(depState, depDef)) {
          shouldSkip = true;
          break;
        }

        if (!depAllowsProgress(depState, depDef)) {
          allResolved = false;
        }
      }

      if (shouldSkip) {
        state.status = StepStatus.SKIPPED;
        this.sink.emit({
          type: "step_state",
          stepId,
          status: state.status,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
        });
        this.notify();
      } else if (allResolved) {
        state.status = StepStatus.READY;
        this.sink.emit({
          type: "step_state",
          stepId,
          status: state.status,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Launching steps
  // -----------------------------------------------------------------------

  private launchReadySteps(): void {
    for (const [stepId, state] of Object.entries(this.steps)) {
      if (state.status !== StepStatus.READY) continue;
      if (this.runningCount >= this.concurrency) break;

      this.launchStep(stepId);
    }
  }

  private launchStep(stepId: string): void {
    const state = this.steps[stepId]!;
    state.status = StepStatus.RUNNING;
    state.iteration = 1;
    state.startedAt = Date.now();
    this.runningCount++;

    this.sink.emit({
      type: "step_state",
      stepId,
      status: state.status,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      startedAt: state.startedAt,
    });
    this.sink.emit({
      type: "step_phase",
      stepId,
      phase: "executing",
      at: Date.now(),
    });

    // Fire-and-forget — the promise resolves when step reaches terminal state
    this.runStepLifecycle(stepId).catch(() => {
      // Ensure we always decrement and notify even on unexpected errors
    });
  }

  // -----------------------------------------------------------------------
  // Step lifecycle — runs in background
  // -----------------------------------------------------------------------

  private async runStepLifecycle(stepId: string): Promise<void> {
    const stepDef = this.stepDefs[stepId]!;

    // Subworkflow step: delegate to dedicated handler
    if (isSubworkflowStep(stepDef)) {
      return this.runSubworkflowStepLifecycle(stepId, stepDef);
    }

    const state = this.steps[stepId]!;
    let retryCount = 0;
    const maxRetries = stepDef.max_retries ?? 0;
    let lastStepResult: StepRunResult | undefined;

    try {
      // Main loop: handles both completion_check iterations and retries
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // If workflow was aborted (timeout), bail out — status already set by handleWorkflowTimeout
        if (this.workflowAbortController!.signal.aborted) return;

        try {
          await this.assertBranchLock(stepId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.markStepFailed(stepId, msg, ErrorClass.FATAL);
          this.skipDependents(stepId);
          return;
        }

        // Resolve inputs before running the step
        if (stepDef.inputs && stepDef.inputs.length > 0) {
          await this.contextManager.resolveInputs(stepId, stepDef.inputs, this.workspaceDir);
        }

        // Run the main worker
        state.status = StepStatus.RUNNING;
        this.sink.emit({
          type: "step_state",
          stepId,
          status: state.status,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          startedAt: state.startedAt,
        });
        this.notify();

        const stepAbort = this.createStepAbort();
        let result: StepRunResult;
        try {
          const effectiveStepDef = this.applyConvergenceToStepDef(stepId, stepDef, state);
          result = await this.stepRunner.runStep(
            stepId,
            effectiveStepDef,
            this.workspaceDir,
            stepAbort,
            this.env,
          );
          lastStepResult = result;
        } catch (_err) {
          if (this.workflowAbortController!.signal.aborted) return;
          this.markStepFailed(stepId, "Worker execution threw an error", ErrorClass.FATAL);
          this.handleFailurePolicy(stepId, ErrorClass.FATAL);
          return;
        }

        // Check abort after async operation
        if (this.workflowAbortController!.signal.aborted) return;

        if (result.status === "FAILED") {
          // Check if FATAL — always abort regardless of on_failure
          if (result.errorClass === ErrorClass.FATAL) {
            this.markStepFailed(stepId, "FATAL error", ErrorClass.FATAL);
            this.handleFailurePolicy(stepId, ErrorClass.FATAL);
            return;
          }

          // Handle on_failure policy
          const onFailure = stepDef.on_failure ?? "abort";

          if (onFailure === "retry" && retryCount < maxRetries) {
            retryCount++;
            // Exponential backoff with jitter
            const baseDelay = 100;
            const exponentialDelay = baseDelay * Math.pow(2, retryCount - 1);
            const delay = Math.min(exponentialDelay, 5000);
            await sleep(delay);
            if (this.workflowAbortController!.signal.aborted) return;
            continue; // retry the step
          }

          // No more retries or not retry policy
          const obs = (result.observations ?? []).find((o) => typeof o.summary === "string" && o.summary.trim())
            ?.summary;
          const preview = obs
            ? obs.replace(/\s+/g, " ").trim().slice(0, 240)
            : "";
          this.markStepFailed(
            stepId,
            `Step failed (errorClass: ${result.errorClass ?? "unknown"})${preview ? `: ${preview}` : ""}`,
            result.errorClass,
          );

          if (onFailure === "abort" || onFailure === "retry") {
            this.skipDependents(stepId);
          }
          return;
        }

        try {
          await this.maybeUpdateExpectedBranchAfterTransition(stepId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.markStepFailed(stepId, msg, ErrorClass.FATAL);
          this.skipDependents(stepId);
          return;
        }

        const collectOutputsIfDefined = async () => {
          if (stepDef.outputs && stepDef.outputs.length > 0) {
            this.sink.emit({
              type: "step_phase",
              stepId,
              phase: "collecting_outputs",
              at: Date.now(),
            });
            await this.contextManager.collectOutputs(stepId, stepDef.outputs, this.workspaceDir);
          }
        };

        // Check for completion_check
        if (!stepDef.completion_check) {
          await collectOutputsIfDefined();
          state.status = StepStatus.SUCCEEDED;
          state.completedAt = Date.now();
          this.sink.emit({
            type: "step_state",
            stepId,
            status: state.status,
            iteration: state.iteration,
            maxIterations: state.maxIterations,
            completedAt: state.completedAt,
          });
          return;
        }

        // Run completion check
        state.status = StepStatus.CHECKING;
        this.sink.emit({
          type: "step_state",
          stepId,
          status: state.status,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
        });
        this.sink.emit({
          type: "step_phase",
          stepId,
          phase: "checking",
          at: Date.now(),
        });
        this.notify();

        const checkAbort = this.createStepAbort();
        let checkResult: CheckResult;
        try {
          const effectiveCheck = this.resolveCheckTimeout(stepDef, stepDef.completion_check);
          checkResult = await this.stepRunner.runCheck(
            stepId,
            effectiveCheck,
            this.workspaceDir,
            checkAbort,
            this.env,
          );
        } catch (err) {
          if (this.workflowAbortController!.signal.aborted) return;
          const msg = err instanceof Error ? err.message : String(err);

          await collectOutputsIfDefined();
          this.markStepFailed(stepId, `Completion check threw an error: ${msg}`, ErrorClass.FATAL);
          this.handleFailurePolicy(stepId, ErrorClass.FATAL);
          return;
        }

        if (this.workflowAbortController!.signal.aborted) return;

        // Collect outputs after completion_check so both the main step and the check
        // can contribute artifacts (e.g. review reports, verdict files).
        await collectOutputsIfDefined();

        if (checkResult.failed) {
          const reason = checkResult.reason ? `: ${checkResult.reason}` : "";
          this.markStepFailed(stepId, `Completion check failed${reason}`);
          const onFailure = stepDef.on_failure ?? "abort";
          if (onFailure === "abort") {
            this.skipDependents(stepId);
          }
          return;
        }

        let effectiveCheckResult: CheckResult = checkResult;
        if (this.isConvergenceEnabled(stepDef)) {
          try {
            effectiveCheckResult = await this.applyConvergenceGuards(
              stepId,
              stepDef,
              state,
              effectiveCheckResult,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.markStepFailed(stepId, `Convergence guard failed: ${msg}`);
            const onFailure = stepDef.on_failure ?? "abort";
            if (onFailure === "abort" || onFailure === "retry") {
              this.skipDependents(stepId);
            }
            return;
          }
        }

        if (effectiveCheckResult.complete) {
          state.status = StepStatus.SUCCEEDED;
          state.completedAt = Date.now();
          this.sink.emit({
            type: "step_state",
            stepId,
            status: state.status,
            iteration: state.iteration,
            maxIterations: state.maxIterations,
            completedAt: state.completedAt,
          });
          return;
        }

        // Not complete — detect completion_check infrastructure failures early.
        // This is distinct from a "real" INCOMPLETE (i.e., work remaining).
        if (this.isCompletionInfraFailure(effectiveCheckResult)) {
          const count = (state.completionInfraFailureCount ?? 0) + 1;
          state.completionInfraFailureCount = count;

          const detail = this.formatCompletionInfraFailure(effectiveCheckResult);
          state.lastCompletionInfraFailure = detail;

          if (count >= COMPLETION_INFRA_FAILURE_LIMIT) {
            this.markStepFailed(
              stepId,
              `Completion check infrastructure failure repeated (${count}x): ${detail}`,
            );
            const onFailure = stepDef.on_failure ?? "abort";
            if (onFailure === "abort" || onFailure === "retry") {
              this.skipDependents(stepId);
            }
            return;
          }
        } else {
          // Reset infra failure streak when we successfully get a stable decision.
          state.completionInfraFailureCount = 0;
          state.lastCompletionInfraFailure = undefined;
        }

        // Convergence Controller: detect stalled identical failure sets and escalate.
        if (this.isConvergenceEnabled(stepDef)) {
          const shouldFail = await this.updateConvergenceState(
            stepId,
            stepDef,
            state,
            effectiveCheckResult,
          );
          if (shouldFail) {
            const onFailure = stepDef.on_failure ?? "abort";
            if (onFailure === "abort" || onFailure === "retry") {
              this.skipDependents(stepId);
            }
            return;
          }
        }

        // Not complete — check iteration limit
        if (state.iteration >= state.maxIterations) {
          const onExhausted = stepDef.on_iterations_exhausted ?? "abort";
          if (onExhausted === "abort") {
            this.markStepFailed(stepId, "Max iterations exhausted");
            this.skipDependents(stepId);
          } else {
            state.status = StepStatus.INCOMPLETE;
            state.completedAt = Date.now();
            this.sink.emit({
              type: "step_state",
              stepId,
              status: state.status,
              iteration: state.iteration,
              maxIterations: state.maxIterations,
              completedAt: state.completedAt,
            });
          }
          return;
        }

        // Loop: increment iteration and re-run
        state.iteration++;
        this.sink.emit({
          type: "step_state",
          stepId,
          status: state.status,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
        });
        retryCount = 0; // reset retry count for new iteration
      }
    } finally {
      this.runningCount--;
      await this.writeStepResolvedMeta(stepId, state, stepDef, retryCount, lastStepResult);
      this.notify();
    }
  }

  // -----------------------------------------------------------------------
  // Subworkflow step lifecycle
  // -----------------------------------------------------------------------

  private async runSubworkflowStepLifecycle(
    stepId: string,
    stepDef: StepDefinition & { workflow: string },
  ): Promise<void> {
    const state = this.steps[stepId]!;
    let retryCount = 0;
    const maxRetries = stepDef.max_retries ?? 0;

    let lastChildDefinitionPath: string | undefined;
    let lastEffectiveTimeoutMs: number | undefined;
    let lastSubworkflowMeta: {
      path: string;
      name: string;
      workflowId: string;
      status: string;
      contextDir: string;
      startedAt: number;
      completedAt?: number;
    } | undefined;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (this.workflowAbortController!.signal.aborted) return;

        try {
          await this.assertBranchLock(stepId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.markStepFailed(stepId, msg, ErrorClass.FATAL);
          this.skipDependents(stepId);
          return;
        }

        // Resolve inputs before running
        if (stepDef.inputs && stepDef.inputs.length > 0) {
          await this.contextManager.resolveInputs(stepId, stepDef.inputs, this.workspaceDir);
        }

        state.status = StepStatus.RUNNING;
        this.sink.emit({
          type: "step_state",
          stepId,
          status: state.status,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          startedAt: state.startedAt,
        });
        this.notify();

        let childResult: WorkflowState;
        let childContextDir: string;
        const runId = crypto.randomUUID();

        try {
          // 1. Load child workflow (inherits parent's resolved agent catalog;
          //    see loadChildWorkflow JSDoc for catalog inheritance design).
          const childLoaded = await loadChildWorkflow(
            stepDef.workflow,
            this.definitionPath,
            this.workspaceDir,
            this.agentCatalog,
          );

          lastChildDefinitionPath = childLoaded.definitionPath;

          assertNoRecursion(
            childLoaded.definitionPath,
            this.workflowCallStack,
            { maxDepth: this.maxNestingDepth },
          );

          // 2. Child context directory
          childContextDir = path.join(
            this.contextManager.contextDir,
            "_subworkflows",
            stepId,
            runId,
          );
          await mkdir(childContextDir, { recursive: true });

          // 3. Compute effective timeout: min(childTimeout, stepTimeout, remainingParent)
          const childTimeoutMs = parseDuration(childLoaded.definition.timeout);
          const stepTimeoutMs = stepDef.timeout
            ? parseDuration(stepDef.timeout)
            : Infinity;
          const elapsedWorkflowMs = this.workflowStartedAt
            ? Date.now() - this.workflowStartedAt
            : 0;
          const remainingParentMs = Math.max(0, this.workflowTimeoutMs - elapsedWorkflowMs);
          const effectiveTimeoutMs = Math.max(
            1,
            Math.min(childTimeoutMs, stepTimeoutMs, remainingParentMs),
          );
          lastEffectiveTimeoutMs = effectiveTimeoutMs;

          // Override child definition timeout
          const childDef: WorkflowDefinition = {
            ...childLoaded.definition,
            timeout: `${effectiveTimeoutMs}ms`,
          };

          // 4. Create child executor
          const childCtx = new ContextManager(childContextDir);
          const childCallStack = [...this.workflowCallStack, childLoaded.definitionPath];

          const childExecutor = new WorkflowExecutor(
            childDef,
            childCtx,
            this.stepRunner,
            this.workspaceDir,
            this.env,
            this.workflowAbortController!.signal,
            this.branchContext
              ? { ...this.branchContext, branchTransitionStep: undefined }
              : undefined,
            this.supervised,
            new NoopExecEventSink(), // MVP: no child events in parent sink
            {
              definitionPath: childLoaded.definitionPath,
              workflowCallStack: childCallStack,
              agentCatalog: childLoaded.agentCatalog,
              maxNestingDepth: this.maxNestingDepth,
            },
          );

          // 5. Execute child workflow
          childResult = await childExecutor.execute();
        } catch (err) {
          if (this.workflowAbortController!.signal.aborted) return;

          const msg = err instanceof Error ? err.message : String(err);
          const errorClass = (err instanceof SubworkflowRecursionError || err instanceof SubworkflowDepthError)
            ? ErrorClass.FATAL
            : ErrorClass.NON_RETRYABLE;
          const onFailure = stepDef.on_failure ?? "abort";

          if (errorClass !== ErrorClass.FATAL && onFailure === "retry" && retryCount < maxRetries) {
            retryCount++;
            const baseDelay = 100;
            const exponentialDelay = baseDelay * Math.pow(2, retryCount - 1);
            const delay = Math.min(exponentialDelay, 5000);
            await sleep(delay);
            if (this.workflowAbortController!.signal.aborted) return;
            continue;
          }

          this.markStepFailed(stepId, msg, errorClass);
          this.handleFailurePolicy(stepId, errorClass);
          return;
        }

        if (this.workflowAbortController!.signal.aborted) return;

        lastSubworkflowMeta = {
          path: stepDef.workflow,
          name: childResult.name,
          workflowId: childResult.workflowId,
          status: childResult.status,
          contextDir: childContextDir,
          startedAt: childResult.startedAt,
          completedAt: childResult.completedAt,
        };

        // 6. Copy exports (best-effort, even on failure)
        if (stepDef.exports && stepDef.exports.length > 0) {
          await this.copyExports(stepId, stepDef.exports, childContextDir);
        }

        // 8. Map child status to parent step status
        if (childResult.status === WorkflowStatus.SUCCEEDED) {
          try {
            await this.maybeUpdateExpectedBranchAfterTransition(stepId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.markStepFailed(stepId, msg, ErrorClass.FATAL);
            this.skipDependents(stepId);
            return;
          }

          state.status = StepStatus.SUCCEEDED;
          state.completedAt = Date.now();
          this.sink.emit({
            type: "step_state",
            stepId,
            status: state.status,
            iteration: state.iteration,
            maxIterations: state.maxIterations,
            completedAt: state.completedAt,
          });
          return;
        }

        if (childResult.status === WorkflowStatus.CANCELLED) {
          state.status = StepStatus.CANCELLED;
          state.completedAt = Date.now();
          this.sink.emit({
            type: "step_state",
            stepId,
            status: state.status,
            iteration: state.iteration,
            maxIterations: state.maxIterations,
            completedAt: state.completedAt,
          });
          return;
        }

        // FAILED or TIMED_OUT
        // Check for FATAL propagation: if any child step had FATAL error
        const childHasFatal = Object.values(childResult.steps).some(
          (s) => s.errorClass === ErrorClass.FATAL,
        );

        const onFailure = stepDef.on_failure ?? "abort";

        if (childHasFatal) {
          this.markStepFailed(stepId, `Child workflow "${childResult.name}" failed (FATAL)`, ErrorClass.FATAL);
          this.handleFailurePolicy(stepId, ErrorClass.FATAL);
          return;
        }

        // Retry if policy allows
        if (onFailure === "retry" && retryCount < maxRetries) {
          retryCount++;
          const baseDelay = 100;
          const exponentialDelay = baseDelay * Math.pow(2, retryCount - 1);
          const delay = Math.min(exponentialDelay, 5000);
          await sleep(delay);
          if (this.workflowAbortController!.signal.aborted) return;
          continue;
        }

        // No more retries
        const statusLabel = childResult.status === WorkflowStatus.TIMED_OUT
          ? "timed out"
          : "failed";
        this.markStepFailed(
          stepId,
          `Child workflow "${childResult.name}" ${statusLabel}`,
          ErrorClass.NON_RETRYABLE,
        );
        this.handleFailurePolicy(stepId, ErrorClass.NON_RETRYABLE);
        return;
      }
    } finally {
      this.runningCount--;

      if (this.workflowAbortController?.signal.aborted && state.status === StepStatus.RUNNING) {
        state.status = StepStatus.CANCELLED;
        state.completedAt = state.completedAt ?? Date.now();
      }

      try {
        const baseMeta = {
          stepId,
          status: state.status,
          startedAt: state.startedAt ?? 0,
          completedAt: state.completedAt,
          wallTimeMs: (state.completedAt ?? Date.now()) - (state.startedAt ?? 0),
          attempts: retryCount + 1,
          iterations: state.iteration,
          maxIterations: state.maxIterations,
          workerKind: stepDef.worker,
          artifacts: [],
        };

        await this.contextManager.writeStepMeta(stepId, {
          ...baseMeta,
          ...(lastSubworkflowMeta ? { subworkflow: lastSubworkflowMeta } : {}),
        });
        await this.contextManager.writeStepResolved(stepId, {
          ...baseMeta,
          subworkflowCall: {
            requestedPath: stepDef.workflow,
            ...(lastChildDefinitionPath ? { definitionPath: lastChildDefinitionPath } : {}),
            ...(lastEffectiveTimeoutMs !== undefined ? { effectiveTimeoutMs: lastEffectiveTimeoutMs } : {}),
            maxNestingDepth: this.maxNestingDepth,
          },
          resolved: {
            ...(lastEffectiveTimeoutMs !== undefined ? { timeoutMs: lastEffectiveTimeoutMs } : {}),
          },
        });
      } catch {
        // best-effort
      }

      this.notify();
    }
  }

  private async copyExports(
    parentStepId: string,
    exports: ExportRef[],
    childContextDir: string,
  ): Promise<void> {
    const childBase = path.resolve(childContextDir);
    for (const exp of exports) {
      const srcDir = path.resolve(childContextDir, exp.from, exp.artifact);
      if (srcDir !== childBase && !srcDir.startsWith(childBase + path.sep)) {
        continue;
      }
      const destName = exp.as ?? exp.artifact;
      let destDir: string;
      try {
        destDir = this.contextManager.getArtifactPath(parentStepId, destName);
      } catch {
        continue;
      }

      try {
        const srcStat = await stat(srcDir).catch(() => null);
        if (!srcStat) continue; // best-effort: skip missing artifacts
        await mkdir(path.dirname(destDir), { recursive: true });
        await cp(srcDir, destDir, { recursive: true });
      } catch {
        // best-effort: don't fail the step if export copy fails
      }
    }
  }

  private async writeStepResolvedMeta(
    stepId: string,
    state: StepState,
    stepDef: StepDefinition,
    retryCount: number,
    lastResult?: StepRunResult,
  ): Promise<void> {
    try {
      const artifacts = (lastResult?.artifacts ?? []).map((a) => ({
        name: a.ref ?? "",
        path: a.ref ?? "",
        type: a.type,
      }));
      const baseMeta = {
        stepId,
        status: state.status,
        startedAt: state.startedAt ?? 0,
        completedAt: state.completedAt,
        wallTimeMs: (state.completedAt ?? Date.now()) - (state.startedAt ?? 0),
        attempts: retryCount + 1,
        iterations: state.iteration,
        maxIterations: state.maxIterations,
        workerKind: stepDef.worker,
        artifacts,
        ...(lastResult?.cost ? { workerResult: { cost: lastResult.cost } } : {}),
      };

      // _meta.json: step execution metadata (status, timing, artifacts)
      await this.contextManager.writeStepMeta(stepId, baseMeta);

      // _resolved.json: resolved execution parameters for observability
      const resolved = resolveTaskLike(stepDef, this.workspaceDir);
      await this.contextManager.writeStepResolved(stepId, {
        ...baseMeta,
        resolved: {
          timeoutMs: resolved.timeoutMs,
          workspaceRef: resolved.workspaceRef,
          workerKind: resolved.workerKind,
          model: resolved.model,
          capabilities: resolved.capabilities.map(String),
          ...(resolved.maxSteps !== undefined ? { maxSteps: resolved.maxSteps } : {}),
          ...(resolved.maxCommandTimeMs !== undefined ? { maxCommandTimeMs: resolved.maxCommandTimeMs } : {}),
        },
      });
    } catch {
      // Best-effort: don't fail the workflow if metadata writing fails
    }
  }

  private isCompletionInfraFailure(checkResult: CheckResult): boolean {
    // Signals we treat as infrastructure / decision-channel failures:
    // - could not determine decision (source none)
    // - stale/missing/unsupported decision_file (reason set by resolver)
    // - explicit check_id mismatch
    if (checkResult.decisionCheckIdMatch === false) return true;

    const src = checkResult.decisionSource;
    if (src === "none") return true;

    const r = (checkResult.reason ?? "").toLowerCase();
    if (!r) return false;
    if (r.includes("could not parse completion decision")) return true;
    if (r.includes("decision_file")) return true;
    return false;
  }

  private formatCompletionInfraFailure(checkResult: CheckResult): string {
    const parts: string[] = [];
    if (checkResult.decisionSource) parts.push(`source=${checkResult.decisionSource}`);
    if (checkResult.decisionCheckIdMatch !== undefined) {
      parts.push(`check_id_match=${checkResult.decisionCheckIdMatch}`);
    }
    if (checkResult.reason && checkResult.reason.trim()) {
      parts.push(`reason=${checkResult.reason.trim()}`);
    }
    return parts.length > 0 ? parts.join(" ") : "unknown";
  }

  // -----------------------------------------------------------------------
  // Convergence Controller (opt-in)
  // -----------------------------------------------------------------------

  private resolveConvergenceConfig(stepDef: StepDefinition): ConvergenceDef | null {
    const cfg = stepDef.convergence;
    if (!cfg) return null;
    if (cfg.enabled !== true) return null;
    if (!stepDef.completion_check) return null;
    return cfg;
  }

  private isConvergenceEnabled(stepDef: StepDefinition): boolean {
    return this.resolveConvergenceConfig(stepDef) !== null;
  }

  private applyConvergenceToStepDef(
    stepId: string,
    stepDef: StepDefinition,
    state: StepState,
  ): StepDefinition {
    const cfg = this.resolveConvergenceConfig(stepDef);
    if (!cfg) return stepDef;

    if (state.convergenceStage === undefined) {
      state.convergenceStage = 1;
    }

    const stage = state.convergenceStage ?? 1;
    if (stage <= 1) return stepDef;

    const append = this.buildConvergenceInstructionsAppend(stepId, state, cfg);
    if (!append) return stepDef;

    return {
      ...stepDef,
      instructions: (stepDef.instructions ?? "").trimEnd() + "\n\n" + append.trim() + "\n",
    };
  }

  private buildConvergenceInstructionsAppend(
    stepId: string,
    state: StepState,
    cfg: ConvergenceDef,
  ): string | null {
    const stage = state.convergenceStage ?? 1;
    if (stage <= 1) return null;

    const maxStage = cfg.max_stage ?? DEFAULT_CONVERGENCE_MAX_STAGE;
    const signals = this.convergenceSignals[stepId] ?? {};
    const fingerprints = signals.fingerprints ?? [];
    const reasons = signals.reasons ?? [];

    const lines: string[] = [];
    lines.push("[Convergence Controller]");
    lines.push(`Stage: ${stage}/${maxStage}`);
    lines.push("The workflow detected stalled, repeating failures. Switch to minimal, targeted changes.");
    lines.push("");
    lines.push("Rules:");
    lines.push("- Make the smallest possible change that resolves the listed fingerprints.");
    lines.push("- Avoid refactors, formatting-only edits, and unrelated changes.");
    lines.push("- If you already made out-of-scope changes, revert them.");
    if (cfg.allowed_paths && cfg.allowed_paths.length > 0) {
      const preview = cfg.allowed_paths.slice(0, 12).join(", ");
      lines.push(`- Allowed paths: ${preview}${cfg.allowed_paths.length > 12 ? ", ..." : ""}`);
    }
    if (typeof cfg.max_changed_files === "number") {
      lines.push(`- Diff budget: max_changed_files=${cfg.max_changed_files}`);
    }

    if (fingerprints.length > 0) {
      lines.push("");
      lines.push("Fingerprints (top):");
      for (const fp of fingerprints.slice(0, 20)) {
        lines.push(`- ${fp}`);
      }
    }
    if (reasons.length > 0) {
      lines.push("");
      lines.push("Reasons (top):");
      for (const r of reasons.slice(0, 12)) {
        lines.push(`- ${r}`);
      }
    }

    const stageOverride = (cfg.stages ?? []).find((s) => s.stage === stage);
    if (stageOverride?.append_instructions && stageOverride.append_instructions.trim()) {
      lines.push("");
      lines.push(stageOverride.append_instructions.trim());
    }

    return lines.join("\n");
  }

  private async applyConvergenceGuards(
    stepId: string,
    stepDef: StepDefinition,
    state: StepState,
    checkResult: CheckResult,
  ): Promise<CheckResult> {
    const cfg = this.resolveConvergenceConfig(stepDef);
    if (!cfg) return checkResult;

    // Scope/diff-budget guard (git-based). Only run when configured.
    const needsGit =
      (cfg.allowed_paths && cfg.allowed_paths.length > 0) ||
      typeof cfg.max_changed_files === "number";
    if (!needsGit) return checkResult;

    const scope = await this.evaluateGitScope(cfg);

    const extraFingerprints: string[] = [];
    const extraReasons: string[] = [];
    let forceIncomplete = false;

    if (typeof cfg.max_changed_files === "number") {
      if (scope.changedFiles.length > cfg.max_changed_files) {
        forceIncomplete = true;
        extraFingerprints.push("diff_budget:max_changed_files_exceeded");
        extraReasons.push(
          `changed files (${scope.changedFiles.length}) exceed max_changed_files (${cfg.max_changed_files})`,
        );
      }
    }

    if (cfg.allowed_paths && cfg.allowed_paths.length > 0) {
      if (scope.violations.length > 0) {
        forceIncomplete = true;
        extraFingerprints.push("scope:outside_allowed_paths");
        for (const f of scope.violations.slice(0, 25)) {
          extraFingerprints.push(`scope:file:${f}`);
        }
        const preview = scope.violations.slice(0, 12).join(", ");
        extraReasons.push(
          `files outside allowed_paths (${scope.violations.length}): ${preview}${scope.violations.length > 12 ? ", ..." : ""}`,
        );
      }
    }

    if (forceIncomplete) {
      await this.writeConvergenceJson(stepId, "scope.json", scope);
    }

    const mergedFingerprints = mergeStringLists(checkResult.fingerprints, extraFingerprints, MAX_CONVERGENCE_SIGNAL_ITEMS);
    const mergedReasons = mergeStringLists(checkResult.reasons, extraReasons, MAX_CONVERGENCE_SIGNAL_ITEMS);

    const out: CheckResult = {
      ...checkResult,
      ...(mergedFingerprints ? { fingerprints: mergedFingerprints } : {}),
      ...(mergedReasons ? { reasons: mergedReasons } : {}),
    };

    if (forceIncomplete && out.complete) {
      out.complete = false;
    }

    // Keep convergence stage initialized.
    if (state.convergenceStage === undefined) {
      state.convergenceStage = 1;
    }

    return out;
  }

  private async updateConvergenceState(
    stepId: string,
    stepDef: StepDefinition,
    state: StepState,
    checkResult: CheckResult,
  ): Promise<boolean> {
    const cfg = this.resolveConvergenceConfig(stepDef);
    if (!cfg) return false;

    if (state.convergenceStage === undefined) {
      state.convergenceStage = 1;
    }

    const stallThreshold = cfg.stall_threshold ?? DEFAULT_CONVERGENCE_STALL_THRESHOLD;
    const maxStage = cfg.max_stage ?? DEFAULT_CONVERGENCE_MAX_STAGE;
    const failOnMaxStage = cfg.fail_on_max_stage !== false;

    const fingerprints = normalizeSignalList(checkResult.fingerprints, MAX_CONVERGENCE_SIGNAL_ITEMS);
    const reasons = normalizeSignalList(checkResult.reasons, MAX_CONVERGENCE_SIGNAL_ITEMS);

    // Save latest signals for instruction overlays.
    this.convergenceSignals[stepId] = {
      fingerprints,
      reasons,
      lastStallKey: state.convergenceLastStallKey,
    };

    const keyInputs = (fingerprints && fingerprints.length > 0)
      ? fingerprints
      : (reasons && reasons.length > 0)
          ? reasons.map((r) => `reason:${r}`)
          : null;

    if (!keyInputs || keyInputs.length === 0) {
      await this.writeConvergenceJson(stepId, "state.json", {
        iteration: state.iteration,
        stage: state.convergenceStage,
        stallCount: state.convergenceStallCount ?? 0,
        lastStallKey: state.convergenceLastStallKey,
        decisionSource: checkResult.decisionSource,
        checkIdMatch: checkResult.decisionCheckIdMatch,
        fingerprints: fingerprints ?? [],
        reasons: reasons ?? [],
        note: "no fingerprints/reasons provided; stall detection skipped",
        updatedAt: Date.now(),
      });
      return false;
    }

    const stallKey = hashStrings(keyInputs);
    const prevKey = state.convergenceLastStallKey;
    if (prevKey === stallKey) {
      state.convergenceStallCount = (state.convergenceStallCount ?? 0) + 1;
    } else {
      state.convergenceLastStallKey = stallKey;
      state.convergenceStallCount = 1;
    }

    const snapshot = {
      iteration: state.iteration,
      stage: state.convergenceStage,
      stallCount: state.convergenceStallCount,
      stallThreshold,
      maxStage,
      lastStallKey: state.convergenceLastStallKey,
      decisionSource: checkResult.decisionSource,
      checkIdMatch: checkResult.decisionCheckIdMatch,
      fingerprints: fingerprints ?? [],
      reasons: reasons ?? [],
      updatedAt: Date.now(),
    };

    await this.writeConvergenceJson(stepId, "state.json", snapshot);

    if ((state.convergenceStallCount ?? 0) < stallThreshold) {
      return false;
    }

    // Escalate stage.
    const currentStage = state.convergenceStage ?? 1;
    const nextStage = Math.min(currentStage + 1, maxStage);
    state.convergenceStage = nextStage;
    state.convergenceStallCount = 0;

    await this.writeConvergenceJson(stepId, "stage-transition.json", {
      from: currentStage,
      to: nextStage,
      reason: "stalled identical failure set",
      stallKey: state.convergenceLastStallKey,
      iteration: state.iteration,
      transitionedAt: Date.now(),
    });

    if (nextStage >= maxStage && failOnMaxStage) {
      const preview = (fingerprints ?? []).slice(0, 6).join(", ");
      this.markStepFailed(
        stepId,
        `Convergence stalled: reached stage ${nextStage}/${maxStage} after ${stallThreshold} repeats` +
          (preview ? ` (fingerprints: ${preview}${(fingerprints?.length ?? 0) > 6 ? ", ..." : ""})` : ""),
      );
      return true;
    }

    return false;
  }

  private async evaluateGitScope(cfg: ConvergenceDef): Promise<{
    baseRef: string;
    changedFiles: string[];
    ignoredFiles: string[];
    violations: string[];
  }> {
    const baseRef = await this.resolveGitBaseRef(cfg);
    const changedFiles = await this.listGitChangedFiles(baseRef);

    const ignoredPatterns = [
      "context/**",
      ".roboppi-loop/**",
      ".git/**",
      ...(cfg.ignored_paths ?? []),
    ];

    const normalized = changedFiles.map(normalizeRelPath);
    const ignoredFiles: string[] = [];
    const scoped: string[] = [];
    for (const f of normalized) {
      if (matchesAnyPattern(ignoredPatterns, f)) {
        ignoredFiles.push(f);
      } else {
        scoped.push(f);
      }
    }

    const allowed = cfg.allowed_paths ?? [];
    const violations: string[] = [];
    if (allowed.length > 0) {
      for (const f of scoped) {
        if (!matchesAnyPattern(allowed, f)) {
          violations.push(f);
        }
      }
    }

    return {
      baseRef,
      changedFiles: scoped.sort(),
      ignoredFiles: ignoredFiles.sort(),
      violations: violations.sort(),
    };
  }

  private async resolveGitBaseRef(cfg: ConvergenceDef): Promise<string> {
    if (cfg.diff_base_ref && cfg.diff_base_ref.trim()) {
      return cfg.diff_base_ref.trim();
    }
    if (cfg.diff_base_ref_file && cfg.diff_base_ref_file.trim()) {
      const full = resolveWithin(this.workspaceDir, cfg.diff_base_ref_file.trim());
      const content = await readFile(full, "utf-8").catch(() => "");
      const firstLine = content.split("\n")[0]?.trim() ?? "";
      if (firstLine) return firstLine;
    }
    return "HEAD";
  }

  private async listGitChangedFiles(baseRef: string): Promise<string[]> {
    // Tracked changes (baseRef -> working tree).
    const tracked = await runCommand(this.workspaceDir, ["git", "diff", "--name-only", baseRef]);
    if (tracked.code !== 0 && tracked.code !== 1) {
      throw new Error(`git diff failed (code ${tracked.code}): ${tracked.stderr.trim() || tracked.stdout.trim()}`);
    }

    // Untracked (non-ignored).
    const untracked = await runCommand(this.workspaceDir, ["git", "ls-files", "--others", "--exclude-standard"]);
    if (untracked.code !== 0) {
      throw new Error(`git ls-files failed (code ${untracked.code}): ${untracked.stderr.trim() || untracked.stdout.trim()}`);
    }

    const set = new Set<string>();
    for (const line of tracked.stdout.split("\n")) {
      const v = line.trim();
      if (v) set.add(v);
    }
    for (const line of untracked.stdout.split("\n")) {
      const v = line.trim();
      if (v) set.add(v);
    }
    return [...set];
  }

  private async writeConvergenceJson(stepId: string, name: string, data: unknown): Promise<void> {
    const dir = this.contextManager.getArtifactPath(stepId, CONVERGENCE_ARTIFACT_DIR);
    await mkdir(dir, { recursive: true });
    const p = path.join(dir, name);
    await writeFile(p, JSON.stringify(data, null, 2));
  }

  // -----------------------------------------------------------------------
  // Failure handling
  // -----------------------------------------------------------------------

  private markStepFailed(stepId: string, error: string, errorClass?: ErrorClass): void {
    const state = this.steps[stepId]!;
    state.status = StepStatus.FAILED;
    state.completedAt = Date.now();
    state.error = error;
    state.errorClass = errorClass;
    this.sink.emit({
      type: "step_state",
      stepId,
      status: state.status,
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      completedAt: state.completedAt,
      error,
    });
  }

  private handleFailurePolicy(
    stepId: string,
    errorClass: ErrorClass,
  ): void {
    // FATAL always aborts
    if (errorClass === ErrorClass.FATAL) {
      this.skipDependents(stepId);
      return;
    }

    const stepDef = this.stepDefs[stepId]!;
    const onFailure = stepDef.on_failure ?? "abort";
    if (onFailure !== "continue") {
      this.skipDependents(stepId);
    }
  }

  private skipDependents(failedStepId: string): void {
    // Mark all steps that transitively depend on the failed step as SKIPPED
    for (const [stepId, state] of Object.entries(this.steps)) {
      if (isTerminal(state.status)) continue;
      if (state.status === StepStatus.RUNNING || state.status === StepStatus.CHECKING) continue;

      const stepDef = this.stepDefs[stepId]!;
      const deps = stepDef.depends_on ?? [];
      if (deps.includes(failedStepId)) {
        state.status = StepStatus.SKIPPED;
        this.sink.emit({
          type: "step_state",
          stepId,
          status: state.status,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
        });
      }
    }
    // Transitively skip dependents of skipped steps
    let changed = true;
    while (changed) {
      changed = false;
      for (const [stepId, state] of Object.entries(this.steps)) {
        if (state.status !== StepStatus.PENDING && state.status !== StepStatus.READY) continue;
        const stepDef = this.stepDefs[stepId]!;
        const deps = stepDef.depends_on ?? [];
        for (const depId of deps) {
          const depState = this.steps[depId];
          if (depState && depState.status === StepStatus.SKIPPED) {
            state.status = StepStatus.SKIPPED;
            this.sink.emit({
              type: "step_state",
              stepId,
              status: state.status,
              iteration: state.iteration,
              maxIterations: state.maxIterations,
            });
            changed = true;
            break;
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Timeout handling
  // -----------------------------------------------------------------------

  private handleWorkflowTimeout(): void {
    for (const [stepId, state] of Object.entries(this.steps)) {
      if (state.status === StepStatus.RUNNING || state.status === StepStatus.CHECKING) {
        state.status = StepStatus.CANCELLED;
        state.completedAt = Date.now();
        this.sink.emit({
          type: "step_state",
          stepId,
          status: state.status,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          completedAt: state.completedAt,
        });
      } else if (
        state.status === StepStatus.PENDING ||
        state.status === StepStatus.READY
      ) {
        state.status = StepStatus.SKIPPED;
        this.sink.emit({
          type: "step_state",
          stepId,
          status: state.status,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Workflow completion
  // -----------------------------------------------------------------------

  private allTerminal(): boolean {
    return Object.values(this.steps).every((s) => isTerminal(s.status));
  }

  private computeWorkflowStatus(): WorkflowStatus {
    if (this.workflowAbortController?.signal.aborted) {
      return this.abortReason === "external"
        ? WorkflowStatus.CANCELLED
        : WorkflowStatus.TIMED_OUT;
    }

    const states = Object.values(this.steps);
    const hasFailed = states.some((s) => s.status === StepStatus.FAILED);
    if (hasFailed) return WorkflowStatus.FAILED;

    const hasCancelled = states.some((s) => s.status === StepStatus.CANCELLED);
    if (hasCancelled) return WorkflowStatus.CANCELLED;

    return WorkflowStatus.SUCCEEDED;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private buildWorkflowMetaExtras(): Record<string, unknown> {
    if (!this.branchContext) return {};
    return toBranchWorkflowMeta(this.branchContext);
  }

  private async assertBranchLock(stepId: string): Promise<void> {
    const context = this.branchContext;
    if (!context || !context.enabled) return;

    if (!context.startupToplevel) return;
    const toplevel = await runCommand(this.workspaceDir, [
      "git",
      "rev-parse",
      "--show-toplevel",
    ]);
    if (toplevel.code !== 0) {
      const detail = toplevel.stderr.trim() || toplevel.stdout.trim() || `exit=${toplevel.code}`;
      throw new Error(
        `Branch lock failed before step "${stepId}": cannot resolve current repo toplevel (${detail}).`,
      );
    }
    const currentToplevel = toplevel.stdout.trim();
    if (currentToplevel !== context.startupToplevel) {
      throw new Error(
        `Branch drift detected before step "${stepId}": repo toplevel mismatch ` +
          `(expected "${context.startupToplevel}", actual "${currentToplevel}"). ` +
          `Recovery: run from "${context.startupToplevel}" and retry.`,
      );
    }

    const expectedBranch =
      context.expectedCurrentBranch ??
      context.expectedWorkBranch ??
      context.startupBranch;
    if (!expectedBranch) return;

    const branch = await runCommand(this.workspaceDir, [
      "git",
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    if (branch.code !== 0) {
      const detail = branch.stderr.trim() || branch.stdout.trim() || `exit=${branch.code}`;
      throw new Error(
        `Branch lock failed before step "${stepId}": cannot resolve current branch (${detail}).`,
      );
    }
    const currentBranch = branch.stdout.trim();
    if (currentBranch !== expectedBranch) {
      throw new Error(
        `Branch drift detected before step "${stepId}": expected branch "${expectedBranch}" ` +
          `but found "${currentBranch}". Recovery: git checkout "${expectedBranch}" and retry.`,
      );
    }
  }

  private async maybeUpdateExpectedBranchAfterTransition(stepId: string): Promise<void> {
    const context = this.branchContext;
    if (!context || !context.enabled) return;
    if (!context.createBranch) return;
    if (!context.branchTransitionStep) return;
    if (stepId !== context.branchTransitionStep) return;

    const branch = await runCommand(this.workspaceDir, [
      "git",
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    if (branch.code !== 0) {
      const detail = branch.stderr.trim() || branch.stdout.trim() || `exit=${branch.code}`;
      throw new Error(
        `Branch transition failed after step "${stepId}": cannot resolve current branch (${detail}).`,
      );
    }
    const next = branch.stdout.trim();
    if (!next || next === "HEAD") {
      throw new Error(
        `Branch transition failed after step "${stepId}": expected a named branch but got "${next || "<empty>"}".`,
      );
    }

    context.expectedWorkBranch = next;
    context.expectedCurrentBranch = next;
  }

  private createStepAbort(): AbortSignal {
    // Link to workflow-level abort
    return this.workflowAbortController!.signal;
  }

  /**
   * If the completion_check has no explicit timeout, derive a default
   * from the parent step's timeout (step timeout / 4).  This prevents
   * a check from silently inheriting the 24 h fallback.
   */
  private resolveCheckTimeout(
    stepDef: StepDefinition,
    check: CompletionCheckDef,
  ): CompletionCheckDef {
    if (check.timeout) return check;

    const stepTimeoutMs = stepDef.timeout
      ? parseDuration(stepDef.timeout)
      : this.workflowTimeoutMs;
    const checkTimeoutMs = Math.max(1000, Math.floor(stepTimeoutMs / 4));

    // Express as a plain ms duration string so resolveTaskLike can parse it.
    return { ...check, timeout: `${checkTimeoutMs}ms` };
  }
}

function normalizeSignalList(list: string[] | undefined, limit: number): string[] | undefined {
  if (!list || list.length === 0) return undefined;
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) continue;
    out.push(s.length > 240 ? s.slice(0, 240) : s);
    if (out.length >= limit) break;
  }
  if (out.length === 0) return undefined;
  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const s of out) {
    if (seen.has(s)) continue;
    seen.add(s);
    deduped.push(s);
  }
  return deduped;
}

function mergeStringLists(
  a: string[] | undefined,
  b: string[] | undefined,
  limit: number,
): string[] | undefined {
  const merged = normalizeSignalList([...(a ?? []), ...(b ?? [])], limit);
  return merged;
}

function hashStrings(items: string[]): string {
  const stable = [...new Set(items.map((s) => s.trim()).filter(Boolean))].sort();
  const h = createHash("sha256");
  h.update(stable.join("\n"), "utf8");
  return h.digest("hex");
}

function normalizeRelPath(p: string): string {
  let s = p.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  // Collapse accidental repeated slashes.
  s = s.replace(/\/+/g, "/");
  return s;
}

function matchesAnyPattern(patterns: string[], file: string): boolean {
  const f = normalizeRelPath(file);
  for (const p of patterns) {
    if (matchesPattern(p, f)) return true;
  }
  return false;
}

function matchesPattern(pattern: string, file: string): boolean {
  const patRaw = typeof pattern === "string" ? pattern.trim() : "";
  if (!patRaw) return false;
  let pat = normalizeRelPath(patRaw);

  // Fast path: no wildcards => treat as path prefix.
  if (!hasWildcard(pat)) {
    // Allow both "dir" and "dir/" forms.
    if (pat.endsWith("/")) pat = pat.slice(0, -1);
    return file === pat || file.startsWith(pat + "/");
  }

  const re = globToRegExp(pat);
  return re.test(file);
}

function hasWildcard(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?") || pattern.includes("[");
}

function globToRegExp(glob: string): RegExp {
  // Very small glob subset:
  // - "**" => ".*" (crosses path separators)
  // - "*"  => "[^/]*" (single segment)
  // - "?"  => "[^/]" (single char in segment)
  const g = normalizeRelPath(glob);
  let re = "^";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        re += ".*";
      } else {
        re += "[^/]*";
      }
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      continue;
    }
    re += escapeRegExpChar(c);
  }
  re += "$";
  return new RegExp(re);
}

function escapeRegExpChar(c: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(c) ? `\\${c}` : c;
}

function resolveWithin(baseDir: string, relPath: string): string {
  const segments = relPath.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(`Path traversal detected: ${relPath}`);
  }
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(baseDir, relPath);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path traversal detected: ${relPath}`);
  }
  return resolved;
}

async function runCommand(
  cwd: string,
  command: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 127, stdout: "", stderr: msg };
  }
}
