import path from "node:path";

import type { StepDefinition, CompletionCheckDef } from "./types.js";
import type { StepRunner, StepRunResult, CheckResult } from "./executor.js";
import { parseDuration } from "./duration.js";
import { readFile, stat } from "node:fs/promises";
import {
  extractWorkerText,
  parseCompletionDecision,
  parseCompletionDecisionFromFile,
  type CompletionDecision,
} from "./completion-decision.js";

import { Supervisor } from "../scheduler/supervisor.js";
import type { IpcProtocol } from "../ipc/protocol.js";
import { IpcTimeoutError } from "../ipc/errors.js";

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

type ResolvedWorkerTaskDef = WorkerTaskDef & {
  workspaceRef: string;
  env?: Record<string, string>;
  timeoutMs: number;
  maxCommandTimeMs?: number;
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

  /** IPC request/response timeout for ack/permit/cancel (defaults to IpcProtocol default). */
  ipcRequestTimeoutMs?: number;
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

    this.supervisor = new Supervisor({
      coreEntryPoint: this.coreEntryPoint,
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
    const checkStartedAt = Date.now();
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

    const decision = await resolveDecision(check, workspaceDir, checkStartedAt, result);
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
  ): ResolvedWorkerTaskDef {
    const workspaceRef = def.workspace
      ? path.resolve(workspaceDir, def.workspace)
      : workspaceDir;

    const timeoutMs = def.timeout ? parseDuration(def.timeout) : DEFAULT_STEP_TIMEOUT_MS;
    const maxCommandTimeMs = def.max_command_time ? parseDuration(def.max_command_time) : undefined;

    return {
      ...def,
      workspaceRef,
      env,
      timeoutMs,
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
    task: ResolvedWorkerTaskDef,
    parentAbort: AbortSignal,
  ): Promise<WorkerResult> {
    const startedAt = Date.now();
    const ipc = await this.ensureIpc();

    // Step timeout should apply to the worker execution budget, not to Core startup.
    // We'll compute the real deadline after submit_job is acknowledged.
    const placeholderDeadlineAt = Date.now() + task.timeoutMs;
    const job = this.buildWorkerJob(workerKind, { ...task, deadlineAt: placeholderDeadlineAt });
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

      const deadlineAt = Date.now() + task.timeoutMs;
      // Update job payload budget to reflect the post-ack execution deadline.
      // (Other budget fields are preserved from the placeholder job.)
      (job.payload as any).budget.deadlineAt = deadlineAt;

      await this.requestPermitUntilGranted(ipc, job, deadlineAt, parentAbort);

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
      parentAbort.removeEventListener("abort", onParentAbort);
      if (execScoped && onExecAbort) {
        execScoped.signal.removeEventListener("abort", onExecAbort);
      }
      execScoped?.cleanup();
    }
  }

  private buildWorkerJob(
    workerKind: WorkerKind,
    task: ResolvedWorkerTaskDef & { deadlineAt: number },
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

async function resolveDecision(
  check: CompletionCheckDef,
  workspaceDir: string,
  checkStartedAt: number,
  result: WorkerResult,
): Promise<CompletionDecision> {
  if (check.decision_file) {
    const fromFile = await tryDecisionFromFile(check.decision_file, workspaceDir, checkStartedAt);
    if (fromFile !== "fail") return fromFile;
  }

  const text = extractWorkerText(result);
  return parseCompletionDecision(text);
}

async function tryDecisionFromFile(
  relPath: string,
  workspaceDir: string,
  checkStartedAt: number,
): Promise<CompletionDecision> {
  const full = resolveWithin(workspaceDir, relPath);
  const st = await stat(full).catch(() => null);
  if (!st) return "fail";
  if (st.mtimeMs + 2000 < checkStartedAt) return "fail";
  const content = await readFile(full, "utf-8").catch(() => "");
  return parseCompletionDecisionFromFile(content);
}

function resolveWithin(baseDir: string, relPath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(baseDir, relPath);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path traversal detected: ${relPath}`);
  }
  return resolved;
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
