import type { Job, Permit, PermitRejectionReason } from "../types/index.js";

export interface ExecutionBudgetConfig {
  maxConcurrency: number;
  maxRps: number;
  maxCostBudget?: number;
}

/** Ring buffer for O(1) sliding-window RPS tracking. */
class RpsRingBuffer {
  private readonly buffer: number[];
  private head = 0;   // next write position
  private count = 0;  // number of valid entries
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity + 1; // +1 so we can distinguish full from empty
    this.buffer = new Array(this.capacity).fill(0);
  }

  /** Evict entries older than windowStart and return the current count. */
  countInWindow(windowStart: number): number {
    // Advance past expired entries from the tail
    const tail = (this.head - this.count + this.capacity) % this.capacity;
    let evicted = 0;
    for (let i = 0; i < this.count; i++) {
      const idx = (tail + i) % this.capacity;
      if (this.buffer[idx]! > windowStart) break;
      evicted++;
    }
    this.count -= evicted;
    return this.count;
  }

  /** Add a timestamp to the ring buffer. */
  push(timestamp: number): void {
    this.buffer[this.head] = timestamp;
    this.head = (this.head + 1) % this.capacity;
    this.count++;
  }
}

export class ExecutionBudget {
  private activeSlots = 0;
  private cumulativeCost = 0;
  private readonly rpsRing: RpsRingBuffer;

  constructor(private readonly config: ExecutionBudgetConfig) {
    this.rpsRing = new RpsRingBuffer(config.maxRps);
  }

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
    const count = this.rpsRing.countInWindow(windowStart);
    if (count >= this.config.maxRps) {
      return false;
    }
    this.rpsRing.push(now);
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
    const recentCount = this.rpsRing.countInWindow(windowStart);
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
    const rpsCount = this.rpsRing.countInWindow(windowStart);
    if (rpsCount >= this.config.maxRps) {
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
    this.rpsRing.push(now);
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
