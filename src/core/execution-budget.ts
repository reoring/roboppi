import type { Job, Permit, PermitRejectionReason } from "../types/index.js";

export interface ExecutionBudgetConfig {
  maxConcurrency: number;
  maxRps: number;
  maxCostBudget?: number;
}

export class ExecutionBudget {
  private activeSlots = 0;
  private cumulativeCost = 0;
  private rpsTimestamps: number[] = [];

  constructor(private readonly config: ExecutionBudgetConfig) {}

  checkAttempts(_jobId: string, attemptIndex: number, maxAttempts: number): boolean {
    return attemptIndex < maxAttempts;
  }

  tryAcquireSlot(): boolean {
    if (this.activeSlots >= this.config.maxConcurrency) {
      return false;
    }
    this.activeSlots++;
    return true;
  }

  releaseSlot(): void {
    if (this.activeSlots > 0) {
      this.activeSlots--;
    }
  }

  tryAcquireRate(): boolean {
    const now = Date.now();
    const windowStart = now - 1000;
    this.rpsTimestamps = this.rpsTimestamps.filter((t) => t > windowStart);
    if (this.rpsTimestamps.length >= this.config.maxRps) {
      return false;
    }
    this.rpsTimestamps.push(now);
    return true;
  }

  tryAcquireCost(cost: number): boolean {
    if (cost < 0) {
      throw new Error("cost must be non-negative");
    }
    if (this.config.maxCostBudget === undefined) {
      return true;
    }
    if (this.cumulativeCost + cost > this.config.maxCostBudget) {
      return false;
    }
    this.cumulativeCost += cost;
    return true;
  }

  releaseCost(cost: number): void {
    this.cumulativeCost = Math.max(0, this.cumulativeCost - cost);
  }

  canIssue(
    job: Job,
    attemptIndex: number,
  ): { allowed: boolean; reason?: PermitRejectionReason } {
    if (!this.checkAttempts(job.jobId, attemptIndex, job.limits.maxAttempts)) {
      return { allowed: false, reason: "BUDGET_EXHAUSTED" as PermitRejectionReason };
    }
    if (this.activeSlots >= this.config.maxConcurrency) {
      return { allowed: false, reason: "CONCURRENCY_LIMIT" as PermitRejectionReason };
    }
    // Check RPS without consuming
    const now = Date.now();
    const windowStart = now - 1000;
    const recentCount = this.rpsTimestamps.filter((t) => t > windowStart).length;
    if (recentCount >= this.config.maxRps) {
      return { allowed: false, reason: "RATE_LIMIT" as PermitRejectionReason };
    }
    if (
      job.limits.costHint !== undefined &&
      this.config.maxCostBudget !== undefined &&
      this.cumulativeCost + job.limits.costHint > this.config.maxCostBudget
    ) {
      return { allowed: false, reason: "BUDGET_EXHAUSTED" as PermitRejectionReason };
    }
    return { allowed: true };
  }

  consume(permit: Permit): boolean {
    // Re-validate RPS before consuming (atomic check-and-consume)
    const now = Date.now();
    const windowStart = now - 1000;
    this.rpsTimestamps = this.rpsTimestamps.filter((t) => t > windowStart);
    if (this.rpsTimestamps.length >= this.config.maxRps) {
      return false;
    }

    // Re-validate cost before consuming
    if (
      permit.tokensGranted.costBudget !== undefined &&
      this.config.maxCostBudget !== undefined &&
      this.cumulativeCost + permit.tokensGranted.costBudget > this.config.maxCostBudget
    ) {
      return false;
    }

    // All checks passed — commit the resource consumption
    this.activeSlots++;
    this.rpsTimestamps.push(now);
    if (permit.tokensGranted.costBudget !== undefined) {
      this.cumulativeCost += permit.tokensGranted.costBudget;
    }
    return true;
  }

  release(permit: Permit): void {
    if (this.activeSlots > 0) {
      this.activeSlots--;
    }
    if (permit.tokensGranted.costBudget !== undefined) {
      this.cumulativeCost = Math.max(0, this.cumulativeCost - permit.tokensGranted.costBudget);
    }
  }

  getActiveSlots(): number {
    return this.activeSlots;
  }

  getCumulativeCost(): number {
    return this.cumulativeCost;
  }
}
