import { ErrorClass } from "../types/common.js";
import type { Artifact, Observation, WorkerCost } from "../types/worker-result.js";
import type {
  WorkflowDefinition,
  StepDefinition,
  CompletionCheckDef,
  WorkflowState,
  StepState,
} from "./types.js";
import { WorkflowStatus, StepStatus } from "./types.js";
import { validateDag } from "./dag-validator.js";
import { parseDuration } from "./duration.js";
import type { ContextManager } from "./context-manager.js";

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
}

export interface StepRunner {
  runStep(
    stepId: string,
    step: StepDefinition,
    workspaceDir: string,
    abortSignal: AbortSignal,
  ): Promise<StepRunResult>;

  runCheck(
    stepId: string,
    check: CompletionCheckDef,
    workspaceDir: string,
    abortSignal: AbortSignal,
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

export class WorkflowExecutor {
  private readonly steps: Record<string, StepState> = {};
  private readonly stepDefs: Record<string, StepDefinition>;
  private readonly concurrency: number;
  private readonly workflowTimeoutMs: number;
  private runningCount = 0;
  private workflowAbortController: AbortController | null = null;

  // Notification mechanism — resolved whenever a step reaches a terminal state
  // or when a running slot becomes free.
  private notifyResolve: (() => void) | null = null;
  private pendingNotification = false;

  constructor(
    private readonly definition: WorkflowDefinition,
    private readonly contextManager: ContextManager,
    private readonly stepRunner: StepRunner,
    private readonly workspaceDir: string,
  ) {
    this.stepDefs = definition.steps;
    this.concurrency =
      definition.concurrency != null ? definition.concurrency : Infinity;
    this.workflowTimeoutMs = parseDuration(definition.timeout);
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
    await this.contextManager.initWorkflow(crypto.randomUUID(), this.definition.name);
    for (const [stepId, stepDef] of Object.entries(this.stepDefs)) {
      const maxIter = stepDef.max_iterations ?? 1;
      this.steps[stepId] = {
        status: StepStatus.PENDING,
        iteration: 0,
        maxIterations: maxIter,
      };
      await this.contextManager.initStep(stepId);
    }

    const startedAt = Date.now();

    // 3. Set up workflow-level abort controller for timeout
    this.workflowAbortController = new AbortController();
    const timeoutId = setTimeout(() => {
      this.workflowAbortController!.abort();
    }, this.workflowTimeoutMs);

    try {
      // 4. Run the scheduling loop
      await this.schedulingLoop();
    } finally {
      clearTimeout(timeoutId);
    }

    // 5. Determine workflow status
    const workflowStatus = this.computeWorkflowStatus();
    const completedAt = Date.now();

    return {
      workflowId: crypto.randomUUID(),
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
      // If already aborted, resolve immediately
      if (this.workflowAbortController!.signal.aborted) {
        resolve();
        return;
      }
      const signal = this.workflowAbortController!.signal;
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
        this.notify();
      } else if (allResolved) {
        state.status = StepStatus.READY;
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
    const state = this.steps[stepId]!;
    let retryCount = 0;
    const maxRetries = stepDef.max_retries ?? 0;

    try {
      // Main loop: handles both completion_check iterations and retries
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // If workflow was aborted (timeout), bail out — status already set by handleWorkflowTimeout
        if (this.workflowAbortController!.signal.aborted) return;

        // Run the main worker
        state.status = StepStatus.RUNNING;
        this.notify();

        const stepAbort = this.createStepAbort();
        let result: StepRunResult;
        try {
          result = await this.stepRunner.runStep(
            stepId,
            stepDef,
            this.workspaceDir,
            stepAbort,
          );
        } catch (_err) {
          if (this.workflowAbortController!.signal.aborted) return;
          this.markStepFailed(stepId, "Worker execution threw an error");
          this.handleFailurePolicy(stepId, ErrorClass.FATAL);
          return;
        }

        // Check abort after async operation
        if (this.workflowAbortController!.signal.aborted) return;

        if (result.status === "FAILED") {
          // Check if FATAL — always abort regardless of on_failure
          if (result.errorClass === ErrorClass.FATAL) {
            this.markStepFailed(stepId, "FATAL error");
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
          this.markStepFailed(
            stepId,
            `Step failed (errorClass: ${result.errorClass ?? "unknown"})`,
          );

          if (onFailure === "abort" || onFailure === "retry") {
            this.skipDependents(stepId);
          }
          return;
        }

        // Step SUCCEEDED — check for completion_check
        if (!stepDef.completion_check) {
          state.status = StepStatus.SUCCEEDED;
          state.completedAt = Date.now();
          return;
        }

        // Run completion check
        state.status = StepStatus.CHECKING;
        this.notify();

        const checkAbort = this.createStepAbort();
        let checkResult: CheckResult;
        try {
          checkResult = await this.stepRunner.runCheck(
            stepId,
            stepDef.completion_check,
            this.workspaceDir,
            checkAbort,
          );
        } catch (_err) {
          if (this.workflowAbortController!.signal.aborted) return;
          this.markStepFailed(stepId, "Completion check threw an error");
          this.handleFailurePolicy(stepId, ErrorClass.FATAL);
          return;
        }

        if (this.workflowAbortController!.signal.aborted) return;

        if (checkResult.failed) {
          this.markStepFailed(stepId, "Completion check failed");
          const onFailure = stepDef.on_failure ?? "abort";
          if (onFailure === "abort") {
            this.skipDependents(stepId);
          }
          return;
        }

        if (checkResult.complete) {
          state.status = StepStatus.SUCCEEDED;
          state.completedAt = Date.now();
          return;
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
          }
          return;
        }

        // Loop: increment iteration and re-run
        state.iteration++;
        retryCount = 0; // reset retry count for new iteration
      }
    } finally {
      this.runningCount--;
      this.notify();
    }
  }

  // -----------------------------------------------------------------------
  // Failure handling
  // -----------------------------------------------------------------------

  private markStepFailed(stepId: string, error: string): void {
    const state = this.steps[stepId]!;
    state.status = StepStatus.FAILED;
    state.completedAt = Date.now();
    state.error = error;
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
    for (const [_stepId, state] of Object.entries(this.steps)) {
      if (state.status === StepStatus.RUNNING || state.status === StepStatus.CHECKING) {
        state.status = StepStatus.CANCELLED;
        state.completedAt = Date.now();
      } else if (
        state.status === StepStatus.PENDING ||
        state.status === StepStatus.READY
      ) {
        state.status = StepStatus.SKIPPED;
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
      return WorkflowStatus.TIMED_OUT;
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

  private createStepAbort(): AbortSignal {
    // Link to workflow-level abort
    return this.workflowAbortController!.signal;
  }
}
