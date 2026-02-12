import path from "node:path";

import type { StepDefinition, CompletionCheckDef } from "./types.js";
import type { StepRunner, StepRunResult, CheckResult } from "./executor.js";
import { parseDuration } from "./duration.js";
import { extractWorkerText, parseCompletionDecision } from "./completion-decision.js";

import { Supervisor } from "../scheduler/supervisor.js";
import type { IpcProtocol } from "../ipc/protocol.js";

import type {
  Job,
  JobCompletedMessage,
  PermitGrantedMessage,
  PermitRejectedMessage,
  WorkerResult,
  PermitRejection,
  UUID,
} from "../types/index.js";
import {
  WorkerKind,
  WorkerCapability,
  OutputMode,
  WorkerStatus,
  JobType,
  PriorityClass,
  PermitRejectionReason,
  generateId,
  ErrorClass,
} from "../types/index.js";

type StepWorker = StepDefinition["worker"];

type WorkerTaskDef = {
  workspace?: string;
  instructions: string;
  capabilities: StepDefinition["capabilities"];
  timeout?: StepDefinition["timeout"];
  max_steps?: StepDefinition["max_steps"];
  max_command_time?: StepDefinition["max_command_time"];
  model?: StepDefinition["model"];
};

const DEFAULT_STEP_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function toWorkerKind(worker: StepWorker): WorkerKind {
  switch (worker) {
    case "CUSTOM":
      return WorkerKind.CUSTOM;
    case "OPENCODE":
      return WorkerKind.OPENCODE;
    case "CLAUDE_CODE":
      return WorkerKind.CLAUDE_CODE;
    case "CODEX_CLI":
      return WorkerKind.CODEX_CLI;
  }
}

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
}

export class CoreIpcStepRunner implements StepRunner {
  private readonly supervisor: Supervisor;
  private readonly coreEntryPoint: string;
  private readonly verbose: boolean;
  private readonly ownsCoreProcess: boolean;

  private ipc: IpcProtocol | null = null;
  private readonly waiters = new Map<UUID, { resolve: (m: JobCompletedMessage) => void }>();
  private readonly buffered = new Map<UUID, JobCompletedMessage>();

  constructor(options: CoreIpcStepRunnerOptions = {}) {
    this.verbose = options.verbose ?? false;
    this.coreEntryPoint = options.coreEntryPoint ?? "src/index.ts";
    this.supervisor = new Supervisor({ coreEntryPoint: this.coreEntryPoint });

    this.ownsCoreProcess = options.ipc === undefined;
    if (options.ipc) {
      this.ipc = options.ipc;
      this.ipc.onMessage("job_completed", (msg) => {
        this.onJobCompleted(msg as JobCompletedMessage);
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.ownsCoreProcess) {
      await this.supervisor.killCore();
    }
    this.ipc = null;
    this.waiters.clear();
    this.buffered.clear();
  }

  async runStep(
    stepId: string,
    step: StepDefinition,
    workspaceDir: string,
    abortSignal: AbortSignal,
    env?: Record<string, string>,
  ): Promise<StepRunResult> {
    const workerKind = toWorkerKind(step.worker);
    const task = this.buildWorkerTaskDef(step, workspaceDir, env);

    const result = await this.runWorkerTask(stepId, workerKind, task, abortSignal);

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
    const workerKind = toWorkerKind(check.worker);
    const task = this.buildWorkerTaskDef(check, workspaceDir, env);
    const result = await this.runWorkerTask(stepId, workerKind, task, abortSignal);

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

    const text = extractWorkerText(result);
    const decision = parseCompletionDecision(text);
    if (decision === "complete") return { complete: true, failed: false };
    if (decision === "incomplete") return { complete: false, failed: false };
    return {
      complete: false,
      failed: true,
      errorClass: ErrorClass.NON_RETRYABLE,
      reason: "could not parse completion decision (expected COMPLETE/INCOMPLETE marker)",
    };
  }

  private buildWorkerTaskDef(
    def: WorkerTaskDef,
    workspaceDir: string,
    env?: Record<string, string>,
  ): WorkerTaskDef & { workspaceRef: string; env?: Record<string, string>; deadlineAt: number; maxCommandTimeMs?: number } {
    const workspaceRef = def.workspace
      ? path.resolve(workspaceDir, def.workspace)
      : workspaceDir;

    const timeoutMs = def.timeout ? parseDuration(def.timeout) : DEFAULT_STEP_TIMEOUT_MS;
    const deadlineAt = Date.now() + timeoutMs;
    const maxCommandTimeMs = def.max_command_time ? parseDuration(def.max_command_time) : undefined;

    return {
      ...def,
      workspaceRef,
      env,
      deadlineAt,
      ...(maxCommandTimeMs !== undefined ? { maxCommandTimeMs } : {}),
    };
  }

  private async ensureIpc(): Promise<IpcProtocol> {
    if (this.ipc) return this.ipc;
    const ipc = await this.supervisor.spawnCore();
    ipc.onMessage("job_completed", (msg) => {
      this.onJobCompleted(msg as JobCompletedMessage);
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
    this.buffered.set(msg.jobId, msg);
  }

  private waitForJobCompleted(jobId: UUID): Promise<JobCompletedMessage> {
    const buffered = this.buffered.get(jobId);
    if (buffered) {
      this.buffered.delete(jobId);
      return Promise.resolve(buffered);
    }

    return new Promise<JobCompletedMessage>((resolve) => {
      this.waiters.set(jobId, { resolve });
    });
  }

  private async runWorkerTask(
    stepId: string,
    workerKind: WorkerKind,
    task: WorkerTaskDef & { workspaceRef: string; env?: Record<string, string>; deadlineAt: number; maxCommandTimeMs?: number },
    parentAbort: AbortSignal,
  ): Promise<WorkerResult> {
    const scoped = createScopedAbort(parentAbort, task.deadlineAt);
    const startedAt = Date.now();
    const ipc = await this.ensureIpc();

    const job = this.buildWorkerJob(workerKind, task);
    const completionPromise = this.waitForJobCompleted(job.jobId);

    const cancelReason = `step:${stepId} aborted`;
    let cancelIssued = false;
    const issueCancel = async () => {
      if (cancelIssued) return;
      cancelIssued = true;
      await this.cancelJob(ipc, job.jobId, cancelReason);
    };

    const onAbort = () => {
      issueCancel().catch(() => {});
    };
    if (scoped.signal.aborted) {
      onAbort();
    } else {
      scoped.signal.addEventListener("abort", onAbort, { once: true });
    }

    let submitted = false;

    try {
      await this.submitJob(ipc, job, scoped.signal);
      submitted = true;
      await this.requestPermitUntilGranted(ipc, job, task.deadlineAt, scoped.signal);

      // Wait for completion, but respect abort.
      let completed: JobCompletedMessage | null = await Promise.race([
        completionPromise,
        waitForAbort(scoped.signal).then(() => null),
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

      if (this.verbose) {
        const text = extractWorkerText(result);
        if (text.trim()) {
          process.stderr.write(`\x1b[36m[step:${stepId}]\x1b[0m worker result (truncated):\n`);
          process.stderr.write(text.trim().slice(0, 4000) + (text.length > 4000 ? "\n[truncated]\n" : "\n"));
        }
      }

      return result;
    } catch (err: unknown) {
      if (scoped.signal.aborted) {
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
      scoped.cleanup();
      scoped.signal.removeEventListener("abort", onAbort);
    }
  }

  private buildWorkerJob(
    workerKind: WorkerKind,
    task: WorkerTaskDef & { workspaceRef: string; env?: Record<string, string>; deadlineAt: number; maxCommandTimeMs?: number },
  ): Job {
    const jobId = generateId();
    const payload = {
      workerTaskId: generateId(),
      workerKind,
      workspaceRef: task.workspaceRef,
      instructions: task.instructions,
      ...(task.model ? { model: task.model } : {}),
      capabilities: task.capabilities.map((c) => WorkerCapability[c]),
      outputMode: OutputMode.BATCH,
      budget: {
        deadlineAt: task.deadlineAt,
        ...(task.max_steps !== undefined ? { maxSteps: task.max_steps } : {}),
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
    await Promise.race([
      wait.then(() => undefined),
      waitForAbort(signal).then(() => {
        throw new StepAbortedError();
      }),
    ]);
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

      // Keep Core-side permit deadline aligned with the step deadline.
      job.limits.timeoutMs = Math.max(1, deadlineAt - Date.now());

      const requestId = generateId();
      const wait = ipc.waitForResponse(requestId) as Promise<PermitGrantedMessage | PermitRejectedMessage>;
      await ipc.sendRequestPermit(requestId, job, 0);

      const response = await Promise.race([
        wait,
        waitForAbort(signal).then(() => {
          throw new StepAbortedError();
        }),
      ]);

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
    await wait.catch(() => {});
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
