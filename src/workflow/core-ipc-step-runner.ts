import type { StepDefinition, CompletionCheckDef } from "./types.js";
import type { StepRunner, StepRunResult, CheckResult } from "./executor.js";
import {
  extractWorkerText,
  interpolateCompletionCheckId,
  resolveCompletionDecision,
  COMPLETION_CHECK_ID_ENV,
} from "./completion-decision.js";
import { resolveTaskLike, type ResolvedWorkerTaskDef } from "./resolve-worker-task.js";

import { Supervisor } from "../scheduler/supervisor.js";
import type { IpcProtocol } from "../ipc/protocol.js";
import { IpcTimeoutError } from "../ipc/errors.js";

import type {
  Job,
  JobCompletedMessage,
  JobEventMessage,
  PermitGrantedMessage,
  PermitRejectedMessage,
  WorkerResult,
  PermitRejection,
  UUID,
  WorkerTaskJobPayload,
} from "../types/index.js";
import {
  OutputMode,
  WorkerStatus,
  JobType,
  PriorityClass,
  PermitRejectionReason,
  generateId,
  ErrorClass,
} from "../types/index.js";
import type { ExecEventSink } from "../tui/exec-event.js";
import { NoopExecEventSink } from "../tui/noop-sink.js";

function isPermitGranted(
  msg: PermitGrantedMessage | PermitRejectedMessage,
): msg is PermitGrantedMessage {
  return msg.type === "permit_granted";
}

export interface CoreIpcStepRunnerOptions {
  verbose?: boolean;
  coreEntryPoint?: string;
  /** For tests or embedding: use an existing IPC connection instead of spawning Core. */
  ipc?: IpcProtocol;

  /** IPC request/response timeout for ack/permit/cancel (defaults to IpcProtocol default). */
  ipcRequestTimeoutMs?: number;

  /**
   * If true, capture Core's stderr as line events (ExecEvent: core_log).
   * When enabled, Core stderr is NOT forwarded directly to this process's stderr.
   */
  captureCoreStderr?: boolean;

  /** Optional event sink for TUI instrumentation. */
  sink?: ExecEventSink;

  /** When true, use OutputMode.STREAM so workers emit incremental events over IPC. */
  tuiEnabled?: boolean;
}

export class CoreIpcStepRunner implements StepRunner {
  private readonly supervisor: Supervisor;
  private readonly coreEntryPoint: string;
  private readonly verbose: boolean;
  private readonly ownsCoreProcess: boolean;
  private readonly sink: ExecEventSink;
  private readonly tuiEnabled: boolean;

  private ipc: IpcProtocol | null = null;
  private readonly waiters = new Map<UUID, { resolve: (m: JobCompletedMessage) => void }>();
  private readonly jobStepMap = new Map<UUID, string>();

  constructor(options: CoreIpcStepRunnerOptions = {}) {
    this.verbose = options.verbose ?? false;
    this.coreEntryPoint = options.coreEntryPoint ?? "src/index.ts";
    this.sink = options.sink ?? new NoopExecEventSink();
    this.tuiEnabled = options.tuiEnabled ?? false;

    const captureCoreStderr = options.captureCoreStderr ?? false;

    this.supervisor = new Supervisor({
      coreEntryPoint: this.coreEntryPoint,
      ...(captureCoreStderr
        ? {
            onCoreStderrLine: (line: string) => {
              this.sink.emit({
                type: "core_log",
                ts: Date.now(),
                line,
              });
            },
          }
        : {}),
      ...(options.ipcRequestTimeoutMs !== undefined
        ? { ipc: { requestTimeoutMs: options.ipcRequestTimeoutMs } }
        : {}),
    });

    this.ownsCoreProcess = options.ipc === undefined;
    if (options.ipc) {
      this.ipc = options.ipc;
      this.ipc.onMessage("job_completed", (msg) => {
        this.onJobCompleted(msg as JobCompletedMessage);
      });
      this.ipc.onMessage("job_event", (msg) => {
        this.onJobEvent(msg as JobEventMessage);
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.ownsCoreProcess) {
      await this.supervisor.killCore();
    }
    this.ipc = null;
    this.waiters.clear();
    this.jobStepMap.clear();
  }

  async runStep(
    stepId: string,
    step: StepDefinition,
    workspaceDir: string,
    abortSignal: AbortSignal,
    env?: Record<string, string>,
  ): Promise<StepRunResult> {
    const task = resolveTaskLike(step, workspaceDir, env);

    const result = await this.runWorkerTask(stepId, task, abortSignal);

    if (result.status === WorkerStatus.SUCCEEDED) {
      return {
        status: "SUCCEEDED",
        artifacts: result.artifacts,
        observations: result.observations,
        cost: result.cost,
      };
    }

    if (result.status === WorkerStatus.CANCELLED) {
      return { status: "FAILED", errorClass: ErrorClass.NON_RETRYABLE };
    }

    return {
      status: "FAILED",
      errorClass: result.errorClass ?? ErrorClass.RETRYABLE_TRANSIENT,
      artifacts: result.artifacts,
      observations: result.observations,
      cost: result.cost,
    };
  }

  async runCheck(
    stepId: string,
    check: CompletionCheckDef,
    workspaceDir: string,
    abortSignal: AbortSignal,
    env?: Record<string, string>,
  ): Promise<CheckResult> {
    const checkStartedAt = Date.now();
    const checkId = generateId();

    const checkEnv = {
      ...(env ?? {}),
      [COMPLETION_CHECK_ID_ENV]: checkId,
    };

    const baseTask = resolveTaskLike(check, workspaceDir, checkEnv);
    const task = {
      ...baseTask,
      instructions: interpolateCompletionCheckId(baseTask.instructions, checkId),
    };
    const result = await this.runWorkerTask(stepId, task, abortSignal);

    if (check.worker === "CUSTOM") {
      // Shell completion check semantics:
      // - exit 0 => complete
      // - exit 1 => incomplete
      // - other => failed
      if (result.status === WorkerStatus.SUCCEEDED) {
        return { complete: true, failed: false };
      }
      if (result.exitCode === 1) {
        return { complete: false, failed: false };
      }
      return {
        complete: false,
        failed: true,
        errorClass: result.errorClass ?? ErrorClass.NON_RETRYABLE,
        reason: summarizeWorkerFailure(result),
      };
    }

    if (result.status !== WorkerStatus.SUCCEEDED) {
      return {
        complete: false,
        failed: true,
        errorClass: result.errorClass ?? ErrorClass.NON_RETRYABLE,
        reason: summarizeWorkerFailure(result),
      };
    }

    const decision = await resolveCompletionDecision(
      check,
      workspaceDir,
      checkStartedAt,
      checkId,
      extractWorkerText(result),
    );

    if (this.verbose) {
      process.stderr.write(
        `\x1b[36m[check:${stepId}]\x1b[0m completion decision: ` +
          `${decision.decision} source=${decision.source}` +
          `${decision.reason ? ` reason=${decision.reason}` : ""}` +
          `${decision.checkIdMatch !== undefined ? ` check_id_match=${decision.checkIdMatch}` : ""}` +
          `\n`,
      );
    }

    if (decision.decision === "complete") return { complete: true, failed: false };
    if (decision.decision === "incomplete") {
      return {
        complete: false,
        failed: false,
        decisionSource: decision.source,
        decisionCheckIdMatch: decision.checkIdMatch,
        ...(decision.reasons ? { reasons: decision.reasons } : {}),
        ...(decision.fingerprints ? { fingerprints: decision.fingerprints } : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
      };
    }

    return {
      complete: false,
      failed: false,
      errorClass: ErrorClass.RETRYABLE_TRANSIENT,
      reason: decision.reason ?? "could not parse completion decision",
      decisionSource: decision.source,
      decisionCheckIdMatch: decision.checkIdMatch,
      ...(decision.reasons ? { reasons: decision.reasons } : {}),
      ...(decision.fingerprints ? { fingerprints: decision.fingerprints } : {}),
    };
  }

  private async ensureIpc(): Promise<IpcProtocol> {
    if (this.ipc) return this.ipc;
    const ipc = await this.supervisor.spawnCore();
    ipc.onMessage("job_completed", (msg) => {
      this.onJobCompleted(msg as JobCompletedMessage);
    });
    ipc.onMessage("job_event", (msg) => {
      this.onJobEvent(msg as JobEventMessage);
    });
    this.ipc = ipc;
    return ipc;
  }

  private onJobCompleted(msg: JobCompletedMessage): void {
    const waiter = this.waiters.get(msg.jobId);
    if (waiter) {
      this.waiters.delete(msg.jobId);
      waiter.resolve(msg);
      return;
    }
    // No waiter means the caller already returned (abort / timeout).
    // Drop the message — the waiter cleanup in runWorkerTask's finally
    // block guarantees no legitimate waiter is missing.
    if (this.verbose) {
      process.stderr.write(
        `[ipc] dropped late job_completed: jobId=${msg.jobId} outcome=${msg.outcome}\n`,
      );
    }
  }

  private onJobEvent(msg: JobEventMessage): void {
    const stepId = this.jobStepMap.get(msg.jobId);
    if (!stepId) return; // unknown job, ignore
    this.sink.emit({
      type: "worker_event",
      stepId,
      ts: msg.ts,
      event: msg.event,
    });
  }

  private waitForJobCompleted(jobId: UUID): Promise<JobCompletedMessage> {
    return new Promise<JobCompletedMessage>((resolve) => {
      this.waiters.set(jobId, { resolve });
    });
  }

  private async runWorkerTask(
    stepId: string,
    task: ResolvedWorkerTaskDef,
    parentAbort: AbortSignal,
  ): Promise<WorkerResult> {
    const startedAt = Date.now();
    const ipc = await this.ensureIpc();

    // Step timeout should apply to the worker execution budget, not to Core startup.
    // We'll compute the real deadline after submit_job is acknowledged.
    const placeholderDeadlineAt = Date.now() + task.timeoutMs;
    const job = this.buildWorkerJob({ ...task, deadlineAt: placeholderDeadlineAt });
    this.jobStepMap.set(job.jobId, stepId);
    const completionPromise = this.waitForJobCompleted(job.jobId);

    const cancelReason = `step:${stepId} aborted`;
    let cancelIssued = false;
    const issueCancel = async () => {
      if (cancelIssued) return;
      cancelIssued = true;
      await this.cancelJob(ipc, job.jobId, cancelReason);
    };

    const onParentAbort = () => {
      issueCancel().catch(() => {});
    };
    if (parentAbort.aborted) {
      onParentAbort();
    } else {
      parentAbort.addEventListener("abort", onParentAbort, { once: true });
    }

    let submitted = false;
    let execScoped: { signal: AbortSignal; cleanup: () => void } | null = null;
    let onExecAbort: (() => void) | null = null;

    try {
      await this.submitJob(ipc, job, parentAbort);
      submitted = true;
      this.sink.emit({ type: "step_phase", stepId, phase: "submitting_job", at: Date.now() });

      const deadlineAt = Date.now() + task.timeoutMs;
      // Update job payload budget to reflect the post-ack execution deadline.
      // (Other budget fields are preserved from the placeholder job.)
      const payload = job.payload as { budget: { deadlineAt: number } };
      payload.budget.deadlineAt = deadlineAt;

      this.sink.emit({ type: "step_phase", stepId, phase: "waiting_permit", at: Date.now() });
      await this.requestPermitUntilGranted(ipc, job, deadlineAt, parentAbort);
      this.sink.emit({ type: "step_phase", stepId, phase: "executing", at: Date.now() });

      execScoped = createScopedAbort(parentAbort, deadlineAt);
      onExecAbort = () => {
        issueCancel().catch(() => {});
      };
      if (execScoped.signal.aborted) {
        onExecAbort();
      } else {
        execScoped.signal.addEventListener("abort", onExecAbort, { once: true });
      }

      // Wait for completion, but respect abort.
      let completed: JobCompletedMessage | null = await Promise.race([
        completionPromise,
        waitForAbort(execScoped.signal).then(() => null),
      ]);

      if (completed === null) {
        await issueCancel().catch(() => {});
        completed = await Promise.race([
          completionPromise,
          sleep(5000).then(() => null),
        ]);
      }

      const result = completed?.result
        ?? (completed ? toFallbackWorkerResult(completed) : cancelledWorkerResult(Date.now() - startedAt));

      // Ensure a reasonable wallTime even for synthetic results.
      if ((result.cost?.wallTimeMs ?? 0) === 0) {
        const wallTimeMs = Date.now() - startedAt;
        result.cost = { ...(result.cost ?? { wallTimeMs: 0 }), wallTimeMs };
        if (result.durationMs === 0) result.durationMs = wallTimeMs;
      }

      this.sink.emit({ type: "worker_result", stepId, ts: Date.now(), result });

      if (this.verbose) {
        const text = extractWorkerText(result);
        if (text.trim()) {
          process.stderr.write(`\x1b[36m[step:${stepId}]\x1b[0m worker result (truncated):\n`);
          process.stderr.write(text.trim().slice(0, 4000) + (text.length > 4000 ? "\n[truncated]\n" : "\n"));
        }
      }

      return result;
    } catch (err: unknown) {
      if (parentAbort.aborted || execScoped?.signal.aborted) {
        return cancelledWorkerResult(Date.now() - startedAt);
      }

      if (this.verbose) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`\x1b[36m[step:${stepId}]\x1b[0m Core IPC error: ${msg}\n`);
      }

      if (submitted) {
        await this.cancelJob(ipc, job.jobId, `step:${stepId} failed`).catch(() => {});
      }

      const wallTimeMs = Date.now() - startedAt;
      let errorClass: ErrorClass = ErrorClass.RETRYABLE_TRANSIENT;
      if (err instanceof PermitRejectedFatalError) {
        errorClass = mapPermitRejectionToErrorClass(err.rejection);
      }

      return {
        status: WorkerStatus.FAILED,
        artifacts: [],
        observations: [
          {
            summary: `Core IPC step failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        cost: { wallTimeMs },
        durationMs: wallTimeMs,
        errorClass,
      };
    } finally {
      this.sink.emit({ type: "step_phase", stepId, phase: "finalizing", at: Date.now() });
      parentAbort.removeEventListener("abort", onParentAbort);
      if (execScoped && onExecAbort) {
        execScoped.signal.removeEventListener("abort", onExecAbort);
      }
      execScoped?.cleanup();
      // Clean up waiter and jobStepMap to prevent Map leak when we return
      // without receiving a job_completed (e.g. abort, timeout, IPC error).
      this.waiters.delete(job.jobId);
      this.jobStepMap.delete(job.jobId);
    }
  }

  private buildWorkerJob(
    task: ResolvedWorkerTaskDef & { deadlineAt: number },
  ): Job {
    const jobId = generateId();
    const payload: WorkerTaskJobPayload = {
      workerTaskId: generateId(),
      workerKind: task.workerKind,
      workspaceRef: task.workspaceRef,
      instructions: task.instructions,
      ...(task.model ? { model: task.model } : {}),
      capabilities: task.capabilities,
      outputMode: this.tuiEnabled ? OutputMode.STREAM : OutputMode.BATCH,
      budget: {
        deadlineAt: task.deadlineAt,
        ...(task.maxSteps !== undefined ? { maxSteps: task.maxSteps } : {}),
        ...(task.maxCommandTimeMs !== undefined ? { maxCommandTimeMs: task.maxCommandTimeMs } : {}),
      },
      ...(task.env ? { env: task.env } : {}),
    };

    return {
      jobId,
      type: JobType.WORKER_TASK,
      priority: { value: 1, class: PriorityClass.INTERACTIVE },
      payload,
      limits: {
        timeoutMs: Math.max(1, task.deadlineAt - Date.now()),
        maxAttempts: 1,
      },
      context: {
        traceId: generateId(),
        correlationId: generateId(),
      },
    };
  }

  private async submitJob(ipc: IpcProtocol, job: Job, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new StepAbortedError();
    const requestId = generateId();
    const wait = ipc.waitForResponse(requestId);
    await ipc.sendSubmitJob(requestId, job);
    try {
      await Promise.race([
        wait.then(() => undefined),
        waitForAbort(signal).then(() => {
          throw new StepAbortedError();
        }),
      ]);
    } catch (err) {
      throw enrichIpcError(err, {
        op: "submit_job",
        requestId,
        jobId: job.jobId,
      });
    }
  }

  private async requestPermitUntilGranted(
    ipc: IpcProtocol,
    job: Job,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<void> {
    let backoff = 0;

    while (true) {
      if (signal.aborted) throw new StepAbortedError();

      // Bail out if the step deadline has already been exceeded while
      // waiting for a permit.  Without this check the loop would
      // continue indefinitely when permits are slow to arrive.
      if (Date.now() >= deadlineAt) {
        throw new Error(
          `Step deadline exceeded while waiting for permit (jobId=${job.jobId})`,
        );
      }

      // Keep Core-side permit deadline aligned with the step deadline.
      job.limits.timeoutMs = Math.max(1, deadlineAt - Date.now());

      const requestId = generateId();
      const wait = ipc.waitForResponse(requestId) as Promise<PermitGrantedMessage | PermitRejectedMessage>;
      await ipc.sendRequestPermit(requestId, job, 0);

      let response: PermitGrantedMessage | PermitRejectedMessage;
      try {
        response = await Promise.race([
          wait,
          waitForAbort(signal).then(() => {
            throw new StepAbortedError();
          }),
        ]);
      } catch (err) {
        throw enrichIpcError(err, {
          op: "request_permit",
          requestId,
          jobId: job.jobId,
          backoff,
        });
      }

      if (isPermitGranted(response)) return;

      const rejection = response.rejection as PermitRejection;
      if (
        rejection.reason === PermitRejectionReason.BUDGET_EXHAUSTED ||
        rejection.reason === PermitRejectionReason.FATAL_MODE ||
        rejection.reason === PermitRejectionReason.DUPLICATE_PERMIT
      ) {
        throw new PermitRejectedFatalError(rejection);
      }

      backoff++;
      await sleep(fullJitterBackoffMs(backoff), signal);
    }
  }

  private async cancelJob(ipc: IpcProtocol, jobId: UUID, reason: string): Promise<void> {
    const requestId = generateId();
    const wait = ipc.waitForResponse(requestId);
    await ipc.sendCancelJob(requestId, jobId, reason);
    await wait.catch((err) => {
      // Best-effort: cancellation is advisory. Still log timeout context for debugging.
      if (err instanceof IpcTimeoutError) {
        try {
          process.stderr.write(`[ipc] cancel_job timeout: jobId=${jobId} requestId=${requestId} timeoutMs=${err.timeoutMs}\n`);
        } catch {
          // ignore
        }
      }
    });
  }
}

function summarizeWorkerFailure(result: WorkerResult): string {
  const parts: string[] = [];
  if (result.exitCode !== undefined) parts.push(`exitCode=${result.exitCode}`);
  if (result.errorClass) parts.push(`errorClass=${result.errorClass}`);

  const text = extractWorkerText(result).trim();
  if (text) {
    const oneLine = text.replace(/\s+/g, " ").trim();
    parts.push(oneLine.slice(0, 300));
  }

  return parts.join(" ");
}

function toFallbackWorkerResult(msg: JobCompletedMessage | null | undefined): WorkerResult {
  const outcome = msg?.outcome ?? "failed";
  const status = outcome === "succeeded"
    ? WorkerStatus.SUCCEEDED
    : outcome === "cancelled"
      ? WorkerStatus.CANCELLED
      : WorkerStatus.FAILED;

  return {
    status,
    artifacts: [],
    observations: [],
    cost: { wallTimeMs: 0 },
    durationMs: 0,
    ...(msg?.errorClass ? { errorClass: msg.errorClass } : {}),
  };
}

class StepAbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "StepAbortedError";
  }
}

class PermitRejectedFatalError extends Error {
  readonly rejection: PermitRejection;

  constructor(rejection: PermitRejection) {
    const detail = rejection.detail ? ` (${rejection.detail})` : "";
    super(`permit_rejected: ${rejection.reason}${detail}`);
    this.name = "PermitRejectedFatalError";
    this.rejection = rejection;
  }
}

function mapPermitRejectionToErrorClass(rejection: PermitRejection): ErrorClass {
  switch (rejection.reason) {
    case PermitRejectionReason.FATAL_MODE:
      return ErrorClass.FATAL;
    case PermitRejectionReason.BUDGET_EXHAUSTED:
    case PermitRejectionReason.DUPLICATE_PERMIT:
      return ErrorClass.NON_RETRYABLE;
    case PermitRejectionReason.RATE_LIMIT:
      return ErrorClass.RETRYABLE_RATE_LIMIT;
    case PermitRejectionReason.CIRCUIT_OPEN:
      return ErrorClass.RETRYABLE_SERVICE;
    case PermitRejectionReason.GLOBAL_SHED:
    case PermitRejectionReason.CONCURRENCY_LIMIT:
    case PermitRejectionReason.DEFERRED:
    case PermitRejectionReason.QUEUE_STALL:
      return ErrorClass.RETRYABLE_TRANSIENT;
  }
  return ErrorClass.RETRYABLE_TRANSIENT;
}

function cancelledWorkerResult(wallTimeMs: number): WorkerResult {
  return {
    status: WorkerStatus.CANCELLED,
    artifacts: [],
    observations: [],
    cost: { wallTimeMs },
    durationMs: wallTimeMs,
    errorClass: ErrorClass.RETRYABLE_TRANSIENT,
  };
}

function fullJitterBackoffMs(count: number): number {
  const base = 100;
  const cap = 2000;
  const ceiling = Math.min(cap, base * Math.pow(2, Math.max(0, count - 1)));
  return Math.floor(Math.random() * ceiling);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function enrichIpcError(
  err: unknown,
  ctx: { op: string; requestId: string; jobId: string; backoff?: number },
): Error {
  if (err instanceof IpcTimeoutError) {
    const extra = ctx.backoff !== undefined ? ` backoff=${ctx.backoff}` : "";
    return new Error(
      `Core IPC ${ctx.op} timed out after ${err.timeoutMs}ms (jobId=${ctx.jobId} requestId=${ctx.requestId}${extra})`,
    );
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function createScopedAbort(parent: AbortSignal, deadlineAt: number): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onAbort = () => {
    ctrl.abort();
  };

  if (parent.aborted) {
    ctrl.abort();
  } else {
    parent.addEventListener("abort", onAbort, { once: true });
  }

  const remaining = deadlineAt - Date.now();
  if (Number.isFinite(remaining) && remaining > 0) {
    timer = setTimeout(() => ctrl.abort(), remaining);
  } else if (!ctrl.signal.aborted) {
    ctrl.abort();
  }

  const cleanup = () => {
    parent.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
  };

  return { signal: ctrl.signal, cleanup };
}
