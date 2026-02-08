import type { UUID, Job, PermitRejection } from "../types/index.js";
import type { PermitHandle } from "../types/index.js";
import { PermitRejectionReason, CircuitState } from "../types/index.js";
import { generateId, now } from "../types/index.js";
import { BackpressureResponse } from "./backpressure.js";
import type { BackpressureController } from "./backpressure.js";
import type { CircuitBreakerRegistry } from "./circuit-breaker.js";
import type { ExecutionBudget } from "./execution-budget.js";

export class PermitGate {
  private activePermits = new Map<UUID, PermitHandle>();
  private deadlineTimers = new Map<UUID, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly budget: ExecutionBudget,
    private readonly circuitBreakers: CircuitBreakerRegistry,
    private readonly backpressure: BackpressureController,
  ) {}

  requestPermit(
    job: Job,
    attemptIndex: number,
  ): PermitHandle | PermitRejection {
    // 1. Check backpressure
    const bpResponse = this.backpressure.check();
    if (bpResponse === BackpressureResponse.REJECT) {
      return { reason: PermitRejectionReason.GLOBAL_SHED, detail: "Backpressure: system overloaded" };
    }
    if (bpResponse === BackpressureResponse.DEFER) {
      return { reason: PermitRejectionReason.DEFERRED, detail: "Backpressure: system busy, retry later" };
    }

    // 2. Check circuit breakers
    const cbSnapshot = this.circuitBreakers.getSnapshot();
    for (const [provider, state] of Object.entries(cbSnapshot)) {
      if (state === CircuitState.OPEN) {
        return {
          reason: PermitRejectionReason.CIRCUIT_OPEN,
          detail: `Circuit breaker open for provider: ${provider}`,
        };
      }
    }

    // 3. Check execution budget
    const budgetCheck = this.budget.canIssue(job, attemptIndex);
    if (!budgetCheck.allowed) {
      return { reason: budgetCheck.reason!, detail: "Execution budget check failed" };
    }

    // 4. All checks passed — create permit
    const abortController = new AbortController();
    const permitId = generateId();
    const deadlineAt = now() + job.limits.timeoutMs;

    // DEGRADE: issue permit with reduced tokens
    const isDegraded = bpResponse === BackpressureResponse.DEGRADE;

    const permit: PermitHandle = {
      permitId,
      jobId: job.jobId,
      deadlineAt,
      attemptIndex,
      abortController,
      tokensGranted: {
        concurrency: isDegraded ? 1 : 1,
        rps: isDegraded ? 1 : 1,
        costBudget: job.limits.costHint,
      },
      circuitStateSnapshot: cbSnapshot,
    };

    // Consume budget resources (atomic re-validation)
    if (!this.budget.consume(permit)) {
      return { reason: PermitRejectionReason.RATE_LIMIT, detail: "Budget consume failed (race)" };
    }
    this.activePermits.set(permitId, permit);

    // Set deadline timer
    const timer = setTimeout(() => {
      this.revokePermit(permitId, "Deadline exceeded");
    }, job.limits.timeoutMs);
    this.deadlineTimers.set(permitId, timer);

    return permit;
  }

  revokePermit(permitId: UUID, reason?: string): void {
    const permit = this.activePermits.get(permitId);
    if (!permit) return;

    if (!permit.abortController.signal.aborted) {
      permit.abortController.abort(reason ?? "Permit revoked");
    }

    this.budget.release(permit);
    this.activePermits.delete(permitId);

    const timer = this.deadlineTimers.get(permitId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.deadlineTimers.delete(permitId);
    }
  }

  completePermit(permitId: UUID): void {
    const permit = this.activePermits.get(permitId);
    if (!permit) return;

    this.budget.release(permit);
    this.activePermits.delete(permitId);

    const timer = this.deadlineTimers.get(permitId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.deadlineTimers.delete(permitId);
    }
  }

  getActivePermitCount(): number {
    return this.activePermits.size;
  }

  getActivePermit(permitId: UUID): PermitHandle | undefined {
    return this.activePermits.get(permitId);
  }

  dispose(): void {
    for (const timer of this.deadlineTimers.values()) {
      clearTimeout(timer);
    }
    this.deadlineTimers.clear();
    for (const permit of this.activePermits.values()) {
      if (!permit.abortController.signal.aborted) {
        permit.abortController.abort("PermitGate disposed");
      }
    }
    this.activePermits.clear();
  }
}
