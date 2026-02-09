import { describe, test, expect, afterEach } from "bun:test";
import { PermitGate } from "../../src/core/permit-gate.js";
import { ExecutionBudget } from "../../src/core/execution-budget.js";
import { CircuitBreakerRegistry } from "../../src/core/circuit-breaker.js";
import { BackpressureController } from "../../src/core/backpressure.js";
import { PermitRejectionReason } from "../../src/types/index.js";
import type { Job, PermitHandle, PermitRejection } from "../../src/types/index.js";

function makeJob(id: string, overrides: Partial<Job> = {}): Job {
  return {
    jobId: id,
    type: "LLM" as const,
    priority: { value: 1, class: "INTERACTIVE" as const },
    payload: {},
    limits: { timeoutMs: 5000, maxAttempts: 3, costHint: 1 },
    context: { traceId: "t1", correlationId: "c1" },
    ...overrides,
  } as Job;
}

function isPermit(result: PermitHandle | PermitRejection): result is PermitHandle {
  return "permitId" in result;
}

function isRejection(result: PermitHandle | PermitRejection): result is PermitRejection {
  return "reason" in result && !("permitId" in result);
}

describe("High concurrency stress tests", () => {
  let gate: PermitGate;
  let registry: CircuitBreakerRegistry;

  function createGate(opts: {
    maxConcurrency: number;
    maxRps: number;
    maxCostBudget?: number;
    bpThresholds?: { rejectThreshold: number; deferThreshold: number; degradeThreshold: number };
  }) {
    const budget = new ExecutionBudget({
      maxConcurrency: opts.maxConcurrency,
      maxRps: opts.maxRps,
      maxCostBudget: opts.maxCostBudget,
    });
    registry = new CircuitBreakerRegistry();
    const backpressure = new BackpressureController(
      opts.bpThresholds ?? { rejectThreshold: 1.0, deferThreshold: 0.8, degradeThreshold: 0.5 },
    );
    gate = new PermitGate(budget, registry, backpressure);
    return { budget, registry, backpressure };
  }

  afterEach(() => {
    gate?.dispose();
    registry?.dispose();
  });

  test("50 concurrent permit requests: only maxConcurrency pass", () => {
    const maxConcurrency = 10;
    createGate({ maxConcurrency, maxRps: 1000 });

    const results: Array<PermitHandle | PermitRejection> = [];
    for (let i = 0; i < 50; i++) {
      results.push(gate.requestPermit(makeJob(`job-${i}`), 0));
    }

    const granted = results.filter(isPermit);
    const rejected = results.filter(isRejection);

    expect(granted.length).toBe(maxConcurrency);
    expect(rejected.length).toBe(40);

    // All rejections should be CONCURRENCY_LIMIT
    for (const r of rejected) {
      expect(r.reason).toBe(PermitRejectionReason.CONCURRENCY_LIMIT);
    }

    // Active permit count matches
    expect(gate.getActivePermitCount()).toBe(maxConcurrency);
  });

  test("100 concurrent requests with high concurrency: all unique permit IDs", () => {
    createGate({ maxConcurrency: 100, maxRps: 1000 });

    const permits: PermitHandle[] = [];
    for (let i = 0; i < 100; i++) {
      const result = gate.requestPermit(makeJob(`job-${i}`), 0);
      expect(isPermit(result)).toBe(true);
      if (isPermit(result)) permits.push(result);
    }

    // All permit IDs should be unique
    const ids = new Set(permits.map((p) => p.permitId));
    expect(ids.size).toBe(100);

    // All job IDs should be correct
    for (let i = 0; i < 100; i++) {
      expect(permits[i]!.jobId).toBe(`job-${i}`);
    }
  });

  test("RPS limit enforcement under burst: submit 20 requests in rapid succession", () => {
    const maxRps = 5;
    createGate({ maxConcurrency: 100, maxRps });

    const results: Array<PermitHandle | PermitRejection> = [];
    // Submit 20 requests as fast as possible (within same millisecond window)
    for (let i = 0; i < 20; i++) {
      results.push(gate.requestPermit(makeJob(`job-rps-${i}`), 0));
    }

    const granted = results.filter(isPermit);
    const rejected = results.filter(isRejection);

    // Only maxRps should be granted (since all are within same 1-second window)
    expect(granted.length).toBe(maxRps);
    expect(rejected.length).toBe(15);

    // Rejections should be RATE_LIMIT
    for (const r of rejected) {
      expect(r.reason).toBe(PermitRejectionReason.RATE_LIMIT);
    }
  });

  test("backpressure REJECT blocks all permits when system overloaded", () => {
    const { backpressure } = createGate({ maxConcurrency: 100, maxRps: 1000 });

    // Simulate overload: set activePermits to max normalization value
    backpressure.updateMetrics({ activePermits: 100, queueDepth: 0, avgLatencyMs: 0 });

    const results: Array<PermitHandle | PermitRejection> = [];
    for (let i = 0; i < 10; i++) {
      results.push(gate.requestPermit(makeJob(`job-bp-${i}`), 0));
    }

    // All should be rejected with GLOBAL_SHED
    expect(results.every(isRejection)).toBe(true);
    for (const r of results) {
      if (isRejection(r)) {
        expect(r.reason).toBe(PermitRejectionReason.GLOBAL_SHED);
      }
    }
    expect(gate.getActivePermitCount()).toBe(0);
  });

  test("concurrent permit issuance and revocation do not corrupt state", () => {
    createGate({ maxConcurrency: 20, maxRps: 1000 });

    // Issue 20 permits
    const permits: PermitHandle[] = [];
    for (let i = 0; i < 20; i++) {
      const result = gate.requestPermit(makeJob(`job-rev-${i}`), 0);
      expect(isPermit(result)).toBe(true);
      if (isPermit(result)) permits.push(result);
    }
    expect(gate.getActivePermitCount()).toBe(20);

    // Revoke every other permit
    for (let i = 0; i < 20; i += 2) {
      gate.revokePermit(permits[i]!.permitId, "test revoke");
    }
    expect(gate.getActivePermitCount()).toBe(10);

    // Complete the rest
    for (let i = 1; i < 20; i += 2) {
      gate.completePermit(permits[i]!.permitId);
    }
    expect(gate.getActivePermitCount()).toBe(0);

    // Verify revoked permits have aborted controllers
    for (let i = 0; i < 20; i += 2) {
      expect(permits[i]!.abortController.signal.aborted).toBe(true);
    }
    // Completed permits should NOT be aborted
    for (let i = 1; i < 20; i += 2) {
      expect(permits[i]!.abortController.signal.aborted).toBe(false);
    }

    // Now new permits should be issuable again
    const fresh = gate.requestPermit(makeJob("job-fresh"), 0);
    expect(isPermit(fresh)).toBe(true);
    expect(gate.getActivePermitCount()).toBe(1);
  });

  test("double revoke and double complete are idempotent", () => {
    createGate({ maxConcurrency: 5, maxRps: 1000 });

    const result = gate.requestPermit(makeJob("job-double"), 0);
    expect(isPermit(result)).toBe(true);
    if (!isPermit(result)) return;

    // Double revoke
    gate.revokePermit(result.permitId, "first revoke");
    gate.revokePermit(result.permitId, "second revoke");
    expect(gate.getActivePermitCount()).toBe(0);

    // Issue another and double complete
    const r2 = gate.requestPermit(makeJob("job-double-2"), 0);
    expect(isPermit(r2)).toBe(true);
    if (!isPermit(r2)) return;

    gate.completePermit(r2.permitId);
    gate.completePermit(r2.permitId);
    expect(gate.getActivePermitCount()).toBe(0);
  });

  test("interleaved issue-revoke-issue cycles maintain correct count", () => {
    createGate({ maxConcurrency: 2, maxRps: 1000 });

    // Cycle 1: issue 2, revoke 1, issue 1 more (should succeed)
    const p1 = gate.requestPermit(makeJob("job-c1-a"), 0);
    const p2 = gate.requestPermit(makeJob("job-c1-b"), 0);
    expect(isPermit(p1)).toBe(true);
    expect(isPermit(p2)).toBe(true);
    expect(gate.getActivePermitCount()).toBe(2);

    // Third should be rejected (concurrency=2)
    const p3 = gate.requestPermit(makeJob("job-c1-c"), 0);
    expect(isRejection(p3)).toBe(true);

    // Revoke p1, now there's room
    if (isPermit(p1)) gate.revokePermit(p1.permitId, "make room");
    expect(gate.getActivePermitCount()).toBe(1);

    // Now p4 should succeed
    const p4 = gate.requestPermit(makeJob("job-c1-d"), 0);
    expect(isPermit(p4)).toBe(true);
    expect(gate.getActivePermitCount()).toBe(2);

    // Clean up
    if (isPermit(p2)) gate.completePermit(p2.permitId);
    if (isPermit(p4)) gate.completePermit(p4.permitId);
    expect(gate.getActivePermitCount()).toBe(0);
  });

  test("cost budget limits prevent over-allocation", () => {
    createGate({ maxConcurrency: 100, maxRps: 1000, maxCostBudget: 10 });

    // Each job has costHint=1, so we can issue 10 permits before budget exhausted
    const results: Array<PermitHandle | PermitRejection> = [];
    for (let i = 0; i < 15; i++) {
      results.push(gate.requestPermit(makeJob(`job-cost-${i}`, {
        limits: { timeoutMs: 5000, maxAttempts: 3, costHint: 1 },
      } as Partial<Job>), 0));
    }

    const granted = results.filter(isPermit);
    const rejected = results.filter(isRejection);

    expect(granted.length).toBe(10);
    expect(rejected.length).toBe(5);
    for (const r of rejected) {
      expect(r.reason).toBe(PermitRejectionReason.BUDGET_EXHAUSTED);
    }
  });

  test("circuit breaker OPEN rejects all requests regardless of other limits", () => {
    const { registry: reg } = createGate({
      maxConcurrency: 100,
      maxRps: 1000,
    });

    // Open a circuit breaker for "LLM" provider (matches makeJob's type: "LLM")
    const cb = reg.getOrCreate("LLM");
    // Need failureThreshold failures to open. Default is usually 5.
    // Force it open by recording many failures
    for (let i = 0; i < 10; i++) {
      cb.recordFailure();
    }

    const results: Array<PermitHandle | PermitRejection> = [];
    for (let i = 0; i < 5; i++) {
      results.push(gate.requestPermit(makeJob(`job-cb-${i}`), 0));
    }

    // All should be rejected with CIRCUIT_OPEN
    expect(results.every(isRejection)).toBe(true);
    for (const r of results) {
      if (isRejection(r)) {
        expect(r.reason).toBe(PermitRejectionReason.CIRCUIT_OPEN);
      }
    }
  });
});
