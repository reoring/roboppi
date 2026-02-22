import type {
  Job,
  PermitHandle,
  PermitRejection,
  EscalationEvent,
  UUID,
} from "../types/index.js";
import { JobType, ErrorClass, PermitRejectionReason, now, isWorkerTaskJobPayload } from "../types/index.js";
import { WorkerStatus } from "../types/index.js";
import type { IpcProtocol } from "../ipc/protocol.js";
import { CancellationManager } from "./cancellation.js";
import { ExecutionBudget } from "./execution-budget.js";
import type { ExecutionBudgetConfig } from "./execution-budget.js";
import { BackpressureController } from "./backpressure.js";
import type { BackpressureThresholds } from "./backpressure.js";
import { CircuitBreakerRegistry } from "./circuit-breaker.js";
import type { CircuitBreakerConfig } from "./circuit-breaker.js";
import { PermitGate } from "./permit-gate.js";
import { Watchdog } from "./watchdog.js";
import type { WatchdogConfig } from "./watchdog.js";
import { EscalationManager } from "./escalation-manager.js";
import type { EscalationManagerConfig } from "./escalation-manager.js";
import { ObservabilityProvider } from "./observability.js";
import type { LogLevel } from "./observability.js";
import { WorkerDelegationGateway } from "../worker/worker-gateway.js";

export interface AgentCoreConfig {
  budget?: ExecutionBudgetConfig;
  backpressure?: BackpressureThresholds;
  circuitBreaker?: CircuitBreakerConfig;
  watchdog?: Partial<WatchdogConfig>;
  escalation?: Partial<EscalationManagerConfig>;
  logLevel?: LogLevel;
}

const DEFAULT_BUDGET: ExecutionBudgetConfig = {
  maxConcurrency: 10,
  maxRps: 50,
};

const DEFAULT_BACKPRESSURE: BackpressureThresholds = {
  rejectThreshold: 1.0,
  deferThreshold: 0.75,
  degradeThreshold: 0.5,
};

function isPermitRejection(result: PermitHandle | PermitRejection): result is PermitRejection {
  return "reason" in result && !("permitId" in result);
}

export class AgentCore {
  private readonly protocol: IpcProtocol;
  private readonly cancellation: CancellationManager;
  private readonly budget: ExecutionBudget;
  private readonly backpressure: BackpressureController;
  private readonly circuitBreakers: CircuitBreakerRegistry;
  private readonly permitGate: PermitGate;
  private readonly watchdog: Watchdog;
  private readonly escalation: EscalationManager;
  private readonly observability: ObservabilityProvider;
  private readonly workerGateway: WorkerDelegationGateway;

  private readonly jobs = new Map<UUID, Job>();
  private readonly activePermitsByJob = new Map<UUID, UUID>(); // jobId → permitId
  private started = false;

  constructor(protocol: IpcProtocol, config?: AgentCoreConfig, observability?: ObservabilityProvider) {
    this.protocol = protocol;

    // Initialize core components
    this.cancellation = new CancellationManager();
    this.budget = new ExecutionBudget(config?.budget ?? DEFAULT_BUDGET);
    this.backpressure = new BackpressureController(config?.backpressure ?? DEFAULT_BACKPRESSURE);
    this.circuitBreakers = new CircuitBreakerRegistry(config?.circuitBreaker);
    this.permitGate = new PermitGate(this.budget, this.circuitBreakers, this.backpressure);
    this.watchdog = new Watchdog(config?.watchdog);
    this.escalation = new EscalationManager(config?.escalation);
    this.observability = observability ?? new ObservabilityProvider(config?.logLevel);
    this.workerGateway = new WorkerDelegationGateway();

    const logger = this.observability.createLogger("AgentCore");

    // Wire escalation manager → IPC
    this.escalation.onEscalation((event: EscalationEvent) => {
      this.protocol.sendEscalation(event).catch((err: unknown) => {
        logger.error("Failed to send escalation over IPC", { error: err });
      });
    });

    // Wire watchdog → escalation manager
    this.watchdog.onEscalation = (_metric: string, _value: number) => {
      this.escalation.evaluate();
    };

    // Register IPC handlers
    this.protocol.onMessage("submit_job", (msg) => {
      const { job, requestId } = msg;
      this.jobs.set(job.jobId, job);
      logger.info("Job submitted", { jobId: job.jobId, type: job.type });
      this.protocol.sendAck(requestId, job.jobId).catch((err: unknown) => {
        logger.error("Failed to send ack", { error: err });
      });
    });

    this.protocol.onMessage("cancel_job", (msg) => {
      const { jobId, reason, requestId } = msg;
      const job = this.jobs.get(jobId);
      if (!job) {
        this.protocol.sendError("JOB_NOT_FOUND", `Job ${jobId} not found`, requestId).catch((err: unknown) => {
          logger.error("Failed to send error", { error: err });
        });
        return;
      }

      // If the job has an active permit, revoke it so the worker task's abort signal fires.
      const permitId = this.activePermitsByJob.get(jobId);
      if (permitId !== undefined) {
        this.permitGate.revokePermit(permitId, reason);
      } else {
        // Job hasn't started (no active permit). Remove it from the registry.
        this.jobs.delete(jobId);
      }

      logger.info("Job cancellation requested", {
        jobId,
        reason,
        activePermit: permitId !== undefined,
      });
      this.protocol.sendJobCancelled(jobId, reason, requestId).catch((err: unknown) => {
        logger.error("Failed to send job_cancelled", { error: err });
      });
    });

    this.protocol.onMessage("request_permit", (msg) => {
      const { job, attemptIndex, requestId } = msg;
      // Ensure the job is registered
      if (!this.jobs.has(job.jobId)) {
        this.jobs.set(job.jobId, job);
      }

      // Fix 2: Prevent duplicate permits for the same job
      const existingPermitId = this.activePermitsByJob.get(job.jobId);
      if (existingPermitId !== undefined) {
        logger.info("Permit rejected: duplicate", { jobId: job.jobId, existingPermitId });
        this.protocol.sendPermitRejected(requestId, {
          reason: PermitRejectionReason.DUPLICATE_PERMIT,
          detail: `Job ${job.jobId} already has active permit ${existingPermitId}`,
        }).catch((err: unknown) => {
          logger.error("Failed to send permit_rejected", { error: err });
        });
        return;
      }

      const result = this.permitGate.requestPermit(job, attemptIndex);

      if (isPermitRejection(result)) {
        logger.info("Permit rejected", { jobId: job.jobId, reason: result.reason });
        this.protocol.sendPermitRejected(requestId, result).catch((err: unknown) => {
          logger.error("Failed to send permit_rejected", { error: err });
        });
        return;
      }

      // Permit granted
      const permit = result;
      this.cancellation.createController(permit.permitId, job.jobId);
      this.activePermitsByJob.set(job.jobId, permit.permitId);

      // Send the serializable permit (without abortController)
      const { abortController: _ac, ...serializablePermit } = permit as PermitHandle;
      logger.info("Permit granted", { jobId: job.jobId, permitId: permit.permitId });
      this.protocol.sendPermitGranted(requestId, serializablePermit).catch((err: unknown) => {
        logger.error("Failed to send permit_granted", { error: err });
      });

      // For WORKER_TASK jobs, delegate to worker gateway
      if (job.type === JobType.WORKER_TASK) {
        this.executeWorkerTask(job, permit, logger);
      }
    });

    this.protocol.onMessage("report_queue_metrics", (msg) => {
      this.backpressure.updateMetrics({
        activePermits: this.permitGate.getActivePermitCount(),
        queueDepth: msg.queueDepth,
        avgLatencyMs: msg.oldestJobAgeMs,
      });
      logger.debug("Queue metrics updated", {
        queueDepth: msg.queueDepth,
        backlogCount: msg.backlogCount,
      });
    });

    this.protocol.onMessage("heartbeat", (_msg) => {
      this.protocol.sendHeartbeatAck(now()).catch((err: unknown) => {
        logger.error("Failed to send heartbeat_ack", { error: err });
      });
    });
  }

  /** Start IPC processing and the watchdog. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.protocol.start();
    this.watchdog.start();
  }

  /** Gracefully shut down: cancel all permits, kill all workers, stop watchdog, close IPC. */
  async shutdown(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    const logger = this.observability.createLogger("AgentCore.shutdown");
    logger.info("Shutdown initiated");

    // Cancel all active permits
    this.permitGate.dispose();

    // Kill all active workers
    await this.workerGateway.cancelAll();

    // Stop watchdog
    this.watchdog.stop();

    // Dispose circuit breakers
    this.circuitBreakers.dispose();

    // Close IPC
    await this.protocol.stop();

    logger.info("Shutdown complete");
  }

  /** Expose the worker gateway for adapter registration. */
  getWorkerGateway(): WorkerDelegationGateway {
    return this.workerGateway;
  }

  /** Expose observability for external use. */
  getObservability(): ObservabilityProvider {
    return this.observability;
  }

  /** Expose watchdog for metric source registration. */
  getWatchdog(): Watchdog {
    return this.watchdog;
  }

  private executeWorkerTask(
    job: Job,
    permit: PermitHandle,
    logger: ReturnType<ObservabilityProvider["createLogger"]>,
  ): void {
    if (!isWorkerTaskJobPayload(job.payload)) {
      logger.error("Invalid WORKER_TASK payload", { jobId: job.jobId });
      this.permitGate.completePermit(permit.permitId);
      this.cancellation.removeController(permit.permitId);
      this.activePermitsByJob.delete(job.jobId);
      this.jobs.delete(job.jobId);
      this.protocol
        .sendJobCompleted(job.jobId, "failed", undefined, ErrorClass.NON_RETRYABLE)
        .catch((err: unknown) => {
          logger.error("Failed to send job_completed for invalid payload", { error: err });
        });
      return;
    }

    const payload = job.payload;

    const workerTask = {
      workerTaskId: payload.workerTaskId,
      workerKind: payload.workerKind,
      workspaceRef: payload.workspaceRef,
      instructions: payload.instructions,
      ...(payload.model ? { model: payload.model } : {}),
      capabilities: payload.capabilities,
      outputMode: payload.outputMode,
      budget: payload.budget,
      ...(payload.env ? { env: payload.env } : {}),
      abortSignal: permit.abortController.signal,
    };

    // Run asynchronously — don't block the IPC handler
    this.workerGateway
      .delegateTask(workerTask as Parameters<WorkerDelegationGateway["delegateTask"]>[0], permit)
      .then((result) => {
        this.permitGate.completePermit(permit.permitId);
        this.cancellation.removeController(permit.permitId);
        this.activePermitsByJob.delete(job.jobId);
        this.jobs.delete(job.jobId);

        const outcome = result.status === WorkerStatus.SUCCEEDED
          ? "succeeded" as const
          : result.status === WorkerStatus.CANCELLED
            ? "cancelled" as const
            : "failed" as const;

        return this.protocol.sendJobCompleted(
          job.jobId,
          outcome,
          result,
          result.errorClass,
        );
      })
      .catch((err: unknown) => {
        this.permitGate.completePermit(permit.permitId);
        this.cancellation.removeController(permit.permitId);
        this.activePermitsByJob.delete(job.jobId);
        this.jobs.delete(job.jobId);

        logger.error("Worker task failed", { jobId: job.jobId, error: err });

        return this.protocol.sendJobCompleted(
          job.jobId,
          "failed",
          undefined,
          ErrorClass.NON_RETRYABLE,
        );
      })
      .catch((sendErr: unknown) => {
        logger.error("Failed to send job_completed", { error: sendErr });
      });
  }
}
