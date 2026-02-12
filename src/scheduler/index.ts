import type { Job, ErrorClass, UUID, EscalationEvent } from "../types/index.js";
import { generateId } from "../types/index.js";
import type { IpcProtocol } from "../ipc/index.js";
import type { PermitRejection, Permit } from "../types/index.js";
import { JobQueue } from "./job-queue.js";
import { InFlightRegistry, DeduplicationPolicy } from "./inflight-registry.js";
import { RetryPolicy } from "./retry-policy.js";
import type { RetryPolicyConfig } from "./retry-policy.js";
import { DeadLetterQueue } from "./dlq.js";
import { Supervisor } from "./supervisor.js";
import type { SupervisorConfig } from "./supervisor.js";

export { JobQueue } from "./job-queue.js";
export { InFlightRegistry, DeduplicationPolicy } from "./inflight-registry.js";
export { RetryPolicy } from "./retry-policy.js";
export type { RetryPolicyConfig } from "./retry-policy.js";
export { DeadLetterQueue } from "./dlq.js";
export type { DlqEntry } from "./dlq.js";
export { HealthChecker } from "./health-check.js";
export type { HealthCheckerConfig } from "./health-check.js";
export { Supervisor } from "./supervisor.js";
export type { SupervisorConfig } from "./supervisor.js";

export interface SchedulerConfig {
  supervisor?: Partial<SupervisorConfig>;
  retry?: Partial<RetryPolicyConfig>;
  defaultPolicy?: DeduplicationPolicy;
  drainTimeoutMs?: number;
  metricsIntervalMs?: number;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 5000;
const DEFAULT_METRICS_INTERVAL_MS = 5000;

interface InFlightJobInfo {
  job: Job;
  attemptIndex: number;
  processing?: boolean;
  enqueuedAt: number;
  /** Tracks consecutive permit rejections / IPC failures for exponential backoff. Reset on success. */
  backoffCount: number;
}

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 30_000;

/** Full-jitter exponential backoff: random(0, min(cap, base * 2^count)). */
export function computeBackoffDelay(count: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, count));
  return Math.floor(Math.random() * ceiling);
}

export class Scheduler {
  private readonly queue: JobQueue;
  private readonly inflight: InFlightRegistry;
  private readonly retryPolicy: RetryPolicy;
  private readonly dlq: DeadLetterQueue;
  private readonly supervisor: Supervisor;
  private readonly defaultPolicy: DeduplicationPolicy;
  private readonly drainTimeoutMs: number;
  private readonly metricsIntervalMs: number;
  private readonly jobInfo = new Map<UUID, InFlightJobInfo>();

  private ipc: IpcProtocol | null = null;
  private running = false;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private mutexQueue: Array<() => void> = [];
  private mutexLocked = false;
  private escalationCallback: ((event: EscalationEvent) => void) | null = null;

  // Event-driven notification mechanism
  private notifyResolve: (() => void) | null = null;

  constructor(config?: SchedulerConfig) {
    this.queue = new JobQueue();
    this.inflight = new InFlightRegistry();
    this.retryPolicy = new RetryPolicy(config?.retry);
    this.dlq = new DeadLetterQueue();
    this.supervisor = new Supervisor(config?.supervisor);
    this.defaultPolicy = config?.defaultPolicy ?? DeduplicationPolicy.REJECT;
    this.drainTimeoutMs = config?.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.metricsIntervalMs = config?.metricsIntervalMs ?? DEFAULT_METRICS_INTERVAL_MS;
  }

  getQueue(): JobQueue {
    return this.queue;
  }

  getInFlight(): InFlightRegistry {
    return this.inflight;
  }

  getDlq(): DeadLetterQueue {
    return this.dlq;
  }

  getSupervisor(): Supervisor {
    return this.supervisor;
  }

  onEscalation(callback: (event: EscalationEvent) => void): void {
    this.escalationCallback = callback;
  }

  private async acquireMutex(): Promise<void> {
    if (!this.mutexLocked) {
      this.mutexLocked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.mutexQueue.push(resolve);
    });
  }

  private releaseMutex(): void {
    const next = this.mutexQueue.shift();
    if (next) {
      next();
    } else {
      this.mutexLocked = false;
    }
  }

  /** Wake the process loop to check for queued jobs. */
  private notify(): void {
    if (this.notifyResolve !== null) {
      const r = this.notifyResolve;
      this.notifyResolve = null;
      r();
    }
  }

  /** Wait until notify() is called or the scheduler is stopped. */
  private waitForNotification(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.notifyResolve = resolve;
    });
  }

  async submitJob(job: Job, policy?: DeduplicationPolicy): Promise<{ accepted: boolean; reason?: string; cancelJobId?: string }> {
    await this.acquireMutex();
    try {
      const effectivePolicy = policy ?? this.defaultPolicy;

      if (job.key) {
        const result = this.inflight.register(job.key, job.jobId, effectivePolicy);

        switch (result.action) {
          case "reject":
            return { accepted: false, reason: `Duplicate key: ${job.key} (existing: ${result.existingJobId})` };

          case "coalesce":
            return { accepted: false, reason: `Coalesced with existing job: ${result.existingJobId}` };

          case "proceed": {
            this.queue.enqueue(job);
            this.jobInfo.set(job.jobId, { job, attemptIndex: 0, enqueuedAt: Date.now(), backoffCount: 0 });
            this.notify();
            const cancelJobId = "cancelJobId" in result ? result.cancelJobId : undefined;
            if (cancelJobId) {
              return { accepted: true, cancelJobId };
            }
            return { accepted: true };
          }
        }
      }

      this.queue.enqueue(job);
      this.jobInfo.set(job.jobId, { job, attemptIndex: 0, enqueuedAt: Date.now(), backoffCount: 0 });
      this.notify();
      return { accepted: true };
    } finally {
      this.releaseMutex();
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.ipc = await this.supervisor.spawnCore();
    this.wireIpcHandlers();
    this.startProcessLoop();
    this.startMetricsReporting();
  }

  async shutdown(): Promise<void> {
    this.running = false;

    // Stop metrics reporting
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = null;
    }

    // Wake the process loop so it can exit
    this.notify();

    // Wait for in-flight jobs to complete within drainTimeoutMs
    if (this.hasInFlightJobs()) {
      await this.drainInFlightJobs();
    }

    await this.supervisor.killCore();
    this.ipc = null;
  }

  private hasInFlightJobs(): boolean {
    for (const info of this.jobInfo.values()) {
      if (info.processing) return true;
    }
    return false;
  }

  private drainInFlightJobs(): Promise<void> {
    return new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.hasInFlightJobs()) {
          clearInterval(checkInterval);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);

      const timeout = setTimeout(() => {
        clearInterval(checkInterval);
        // Move remaining in-flight (processing) jobs to DLQ
        for (const [jobId, info] of this.jobInfo) {
          if (info.processing) {
            this.dlq.push(
              info.job,
              "Drain timeout: job still in-flight at shutdown",
              undefined,
              info.attemptIndex + 1,
            );
            if (info.job.key) {
              this.inflight.deregister(info.job.key);
            }
            this.jobInfo.delete(jobId);
          }
        }
        resolve();
      }, this.drainTimeoutMs);
    });
  }

  private startMetricsReporting(): void {
    this.metricsTimer = setInterval(() => {
      this.reportQueueMetrics();
    }, this.metricsIntervalMs);
  }

  private reportQueueMetrics(): void {
    if (!this.ipc || !this.running) return;

    const queueDepth = this.queue.size();
    const backlogCount = this.jobInfo.size;

    // Find the oldest job age
    let oldestJobAgeMs = 0;
    const now = Date.now();
    for (const info of this.jobInfo.values()) {
      const age = now - info.enqueuedAt;
      if (age > oldestJobAgeMs) {
        oldestJobAgeMs = age;
      }
    }

    const requestId = generateId();
    this.ipc.sendReportQueueMetrics(requestId, queueDepth, oldestJobAgeMs, backlogCount)
      .catch(() => {
        // Silently ignore metrics send failures
      });
  }

  private wireIpcHandlers(): void {
    if (!this.ipc) return;

    // Handle permit_granted: Core approved the permit request
    this.ipc.onMessage("permit_granted", (msg) => {
      const permit = msg.permit as Omit<Permit, "abortController">;
      const info = this.jobInfo.get(permit.jobId);
      if (info) {
        info.processing = true;
      }
    });

    // Handle permit_rejected: Core denied the permit request
    this.ipc.onMessage("permit_rejected", (msg) => {
      const rejection = msg.rejection as PermitRejection;
      // Find the job that was rejected — we need to look through pending requests
      // The requestId correlates via waitForResponse, but unsolicited rejections
      // need to be handled here for jobs waiting in the pipeline
      // For now, the primary flow uses waitForResponse for correlation.
      // This handler catches any unsolicited rejections.
      void rejection;
    });

    // Handle job_completed: Core finished processing a job
    this.ipc.onMessage("job_completed", (msg) => {
      this.handleJobCompleted(
        msg.jobId,
        msg.outcome,
        msg.errorClass,
      );
    });

    // Handle job_cancelled: Core cancelled a job
    this.ipc.onMessage("job_cancelled", (msg) => {
      const info = this.jobInfo.get(msg.jobId);
      if (info) {
        if (info.job.key) {
          this.inflight.deregister(info.job.key);
        }
        this.jobInfo.delete(msg.jobId);
      }
    });

    // Handle escalation events from Core
    this.ipc.onMessage("escalation", (msg) => {
      this.escalationCallback?.(msg.event);
    });
  }

  private startProcessLoop(): void {
    void this.processLoop();
  }

  private async processLoop(): Promise<void> {
    while (this.running) {
      if (this.queue.isEmpty()) {
        await this.waitForNotification();
        if (!this.running) break;
      }
      await this.processNext();
    }
  }

  private async processNext(): Promise<void> {
    await this.acquireMutex();
    let job: Job | undefined;
    let info: InFlightJobInfo | undefined;
    let ipc: IpcProtocol;
    try {
      if (!this.ipc || this.queue.isEmpty()) return;

      job = this.queue.dequeue();
      if (!job) return;

      info = this.jobInfo.get(job.jobId);
      ipc = this.ipc;
    } finally {
      this.releaseMutex();
    }

    if (!job) return;

    const attemptIndex = info?.attemptIndex ?? 0;

    // Send submit_job to Core, then request_permit, following the design doc flow
    const submitRequestId = generateId();
    const permitRequestId = generateId();

    // Register waiters before sending to avoid missing fast responses.
    const submitWait = ipc!.waitForResponse(submitRequestId);

    ipc!.sendSubmitJob(submitRequestId, job)
      .then(() => submitWait)
      .then(() => {
        // Ack received, now request a permit
        const permitWait = ipc!.waitForResponse(permitRequestId);
        return ipc!.sendRequestPermit(permitRequestId, job!, attemptIndex)
          .then(() => permitWait);
      })
      .then((response) => {
        const msg = response as Record<string, unknown>;
        if (msg["type"] === "permit_rejected") {
          // Permit was rejected — re-enqueue with exponential backoff + jitter
          const rejection = msg["rejection"] as PermitRejection;
          if (info) {
            info.processing = false;
            const delay = computeBackoffDelay(info.backoffCount);
            info.backoffCount++;
            setTimeout(() => {
              if (this.running) {
                this.queue.enqueue(job!);
                this.notify();
              }
            }, delay);
          } else {
            // No info — fallback to base delay
            setTimeout(() => {
              if (this.running) {
                this.queue.enqueue(job!);
                this.notify();
              }
            }, BACKOFF_BASE_MS);
          }
          void rejection;
        } else {
          // permit_granted — reset backoff on success
          if (info) {
            info.backoffCount = 0;
          }
        }
        // If permit_granted, the job is now being processed by Core.
        // The job_completed handler will be called when Core finishes.
      })
      .catch((_err) => {
        // IPC failure — re-enqueue with exponential backoff + jitter
        if (info) {
          const delay = computeBackoffDelay(info.backoffCount);
          info.backoffCount++;
          setTimeout(() => {
            if (this.running) {
              this.queue.enqueue(job!);
              this.notify();
            }
          }, delay);
        } else {
          setTimeout(() => {
            if (this.running) {
              this.queue.enqueue(job!);
              this.notify();
            }
          }, BACKOFF_BASE_MS);
        }
      });
  }

  handleJobCompleted(
    jobId: UUID,
    outcome: "succeeded" | "failed" | "cancelled",
    errorClass?: ErrorClass,
  ): void {
    const info = this.jobInfo.get(jobId);
    if (!info) return;

    // Mark as not processing to prevent concurrent modifications
    info.processing = false;

    // Deregister from inflight
    if (info.job.key) {
      this.inflight.deregister(info.job.key);
    }

    if (outcome === "succeeded" || outcome === "cancelled") {
      this.jobInfo.delete(jobId);
      return;
    }

    // Handle failure: check retry policy
    if (errorClass) {
      const decision = this.retryPolicy.shouldRetry(errorClass, info.attemptIndex);
      if (decision.retry) {
        info.attemptIndex++;
        // Re-enqueue after delay
        setTimeout(() => {
          if (this.running) {
            this.queue.enqueue(info.job);
            this.notify();
          }
        }, decision.delayMs);
        return;
      }
    }

    // No retry: send to DLQ
    this.dlq.push(
      info.job,
      `Job failed with outcome=${outcome}, errorClass=${errorClass ?? "unknown"}`,
      errorClass,
      info.attemptIndex + 1,
    );
    this.jobInfo.delete(jobId);
  }
}
