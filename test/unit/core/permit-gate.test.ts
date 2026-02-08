import { describe, test, expect, afterEach } from "bun:test";
import { PermitGate } from "../../../src/core/permit-gate.js";
import { ExecutionBudget } from "../../../src/core/execution-budget.js";
import { CircuitBreakerRegistry } from "../../../src/core/circuit-breaker.js";
import { BackpressureController } from "../../../src/core/backpressure.js";
import { PermitRejectionReason } from "../../../src/types/index.js";
import type { Job, PermitHandle, PermitRejection } from "../../../src/types/index.js";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    jobId: "job-1",
    type: "LLM" as const,
    priority: { value: 1, class: "INTERACTIVE" as const },
    payload: {},
    limits: { timeoutMs: 5000, maxAttempts: 3, costHint: 10 },
    context: { traceId: "t1", correlationId: "c1" },
    ...overrides,
  } as Job;
}

function isPermit(result: PermitHandle | PermitRejection): result is PermitHandle {
  return "permitId" in result;
}

function isRejection(result: PermitHandle | PermitRejection): result is PermitRejection {
  return "reason" in result;
}

describe("PermitGate", () => {
  let gate: PermitGate;
  let registry: CircuitBreakerRegistry;

  function createGate(opts?: {
    maxConcurrency?: number;
    maxRps?: number;
    maxCostBudget?: number;
    bpThresholds?: { rejectThreshold: number; deferThreshold: number; degradeThreshold: number };
    cbConfig?: { failureThreshold: number; resetTimeoutMs: number; halfOpenMaxAttempts: number };
  }) {
    const budget = new ExecutionBudget({
      maxConcurrency: opts?.maxConcurrency ?? 10,
      maxRps: opts?.maxRps ?? 100,
      maxCostBudget: opts?.maxCostBudget,
    });
    registry = new CircuitBreakerRegistry(opts?.cbConfig);
    const backpressure = new BackpressureController(
      opts?.bpThresholds ?? { rejectThreshold: 1.0, deferThreshold: 0.8, degradeThreshold: 0.5 },
    );
    gate = new PermitGate(budget, registry, backpressure);
    return { budget, registry, backpressure };
  }

  afterEach(() => {
    gate?.dispose();
    registry?.dispose();
  });

  test("issues a permit when all checks pass", () => {
    createGate();
    const job = makeJob();
    const result = gate.requestPermit(job, 0);

    expect(isPermit(result)).toBe(true);
    if (isPermit(result)) {
      expect(result.jobId).toBe("job-1");
      expect(result.attemptIndex).toBe(0);
      expect(result.abortController).toBeInstanceOf(AbortController);
      expect(result.abortController.signal.aborted).toBe(false);
      expect(result.tokensGranted.concurrency).toBe(1);
    }
  });

  test("tracks active permit count", () => {
    createGate();
    expect(gate.getActivePermitCount()).toBe(0);

    const result = gate.requestPermit(makeJob(), 0);
    expect(isPermit(result)).toBe(true);
    expect(gate.getActivePermitCount()).toBe(1);
  });

  test("rejects when backpressure is REJECT", () => {
    const { backpressure } = createGate();
    backpressure.updateMetrics({ activePermits: 200, queueDepth: 0, avgLatencyMs: 0 });

    const result = gate.requestPermit(makeJob(), 0);
    expect(isRejection(result)).toBe(true);
    if (isRejection(result)) {
      expect(result.reason).toBe(PermitRejectionReason.GLOBAL_SHED);
    }
  });

  test("rejects when circuit breaker is OPEN", () => {
    const { registry: reg } = createGate({
      cbConfig: { failureThreshold: 1, resetTimeoutMs: 60000, halfOpenMaxAttempts: 1 },
    });
    reg.getOrCreate("openai").recordFailure();

    const result = gate.requestPermit(makeJob(), 0);
    expect(isRejection(result)).toBe(true);
    if (isRejection(result)) {
      expect(result.reason).toBe(PermitRejectionReason.CIRCUIT_OPEN);
    }
  });

  test("rejects when attempts exhausted", () => {
    createGate();
    const job = makeJob();
    const result = gate.requestPermit(job, 3); // maxAttempts is 3, so index 3 is rejected
    expect(isRejection(result)).toBe(true);
    if (isRejection(result)) {
      expect(result.reason).toBe(PermitRejectionReason.BUDGET_EXHAUSTED);
    }
  });

  test("rejects when concurrency limit reached", () => {
    createGate({ maxConcurrency: 1 });
    const job1 = makeJob({ jobId: "job-1" });
    const job2 = makeJob({ jobId: "job-2" });

    const r1 = gate.requestPermit(job1, 0);
    expect(isPermit(r1)).toBe(true);

    const r2 = gate.requestPermit(job2, 0);
    expect(isRejection(r2)).toBe(true);
    if (isRejection(r2)) {
      expect(r2.reason).toBe(PermitRejectionReason.CONCURRENCY_LIMIT);
    }
  });

  test("revokePermit aborts the controller and releases budget", () => {
    createGate();
    const result = gate.requestPermit(makeJob(), 0);
    expect(isPermit(result)).toBe(true);
    if (!isPermit(result)) return;

    gate.revokePermit(result.permitId, "test revoke");
    expect(result.abortController.signal.aborted).toBe(true);
    expect(gate.getActivePermitCount()).toBe(0);
  });

  test("completePermit releases budget without aborting", () => {
    createGate();
    const result = gate.requestPermit(makeJob(), 0);
    expect(isPermit(result)).toBe(true);
    if (!isPermit(result)) return;

    gate.completePermit(result.permitId);
    expect(result.abortController.signal.aborted).toBe(false);
    expect(gate.getActivePermitCount()).toBe(0);
  });

  test("revoking non-existent permit is a no-op", () => {
    createGate();
    gate.revokePermit("nonexistent");
    expect(gate.getActivePermitCount()).toBe(0);
  });

  test("completing non-existent permit is a no-op", () => {
    createGate();
    gate.completePermit("nonexistent");
    expect(gate.getActivePermitCount()).toBe(0);
  });

  test("after completing permit, slot is freed for new permit", () => {
    createGate({ maxConcurrency: 1 });
    const r1 = gate.requestPermit(makeJob({ jobId: "job-1" }), 0);
    expect(isPermit(r1)).toBe(true);
    if (!isPermit(r1)) return;

    gate.completePermit(r1.permitId);

    const r2 = gate.requestPermit(makeJob({ jobId: "job-2" }), 0);
    expect(isPermit(r2)).toBe(true);
  });

  describe("RATE_LIMIT rejection", () => {
    test("rejects when RPS limit is exceeded", () => {
      createGate({ maxConcurrency: 100, maxRps: 3 });

      // Issue 3 permits (fills RPS window)
      for (let i = 0; i < 3; i++) {
        const r = gate.requestPermit(makeJob({ jobId: `job-rps-${i}` }), 0);
        expect(isPermit(r)).toBe(true);
      }

      // 4th should be rejected with RATE_LIMIT
      const r4 = gate.requestPermit(makeJob({ jobId: "job-rps-4" }), 0);
      expect(isRejection(r4)).toBe(true);
      if (isRejection(r4)) {
        expect(r4.reason).toBe(PermitRejectionReason.RATE_LIMIT);
      }
    });
  });

  describe("BUDGET_EXHAUSTED rejection (cost budget)", () => {
    test("rejects when cost budget would be exceeded", () => {
      createGate({ maxConcurrency: 100, maxRps: 100, maxCostBudget: 5 });

      // Each job has costHint=10, max budget is 5
      const job = makeJob({ limits: { timeoutMs: 5000, maxAttempts: 3, costHint: 10 } });
      const result = gate.requestPermit(job, 0);

      expect(isRejection(result)).toBe(true);
      if (isRejection(result)) {
        expect(result.reason).toBe(PermitRejectionReason.BUDGET_EXHAUSTED);
      }
    });
  });

  describe("BUDGET_EXHAUSTED rejection (attempts)", () => {
    test("rejects when attemptIndex equals maxAttempts", () => {
      createGate();
      const job = makeJob({ limits: { timeoutMs: 5000, maxAttempts: 2, costHint: undefined } });

      // attemptIndex=0 should pass
      const r0 = gate.requestPermit(job, 0);
      expect(isPermit(r0)).toBe(true);
      if (isPermit(r0)) gate.completePermit(r0.permitId);

      // attemptIndex=1 should pass
      const r1 = gate.requestPermit(job, 1);
      expect(isPermit(r1)).toBe(true);
      if (isPermit(r1)) gate.completePermit(r1.permitId);

      // attemptIndex=2 should be rejected (maxAttempts=2)
      const r2 = gate.requestPermit(job, 2);
      expect(isRejection(r2)).toBe(true);
      if (isRejection(r2)) {
        expect(r2.reason).toBe(PermitRejectionReason.BUDGET_EXHAUSTED);
      }
    });
  });

  describe("rejection detail text", () => {
    test("GLOBAL_SHED rejection includes descriptive detail", () => {
      const { backpressure } = createGate();
      backpressure.updateMetrics({ activePermits: 200, queueDepth: 0, avgLatencyMs: 0 });

      const result = gate.requestPermit(makeJob(), 0);
      expect(isRejection(result)).toBe(true);
      if (isRejection(result)) {
        expect(result.reason).toBe(PermitRejectionReason.GLOBAL_SHED);
        expect(result.detail).toBeDefined();
        expect(typeof result.detail).toBe("string");
        expect(result.detail!.length).toBeGreaterThan(0);
      }
    });

    test("CIRCUIT_OPEN rejection includes provider name in detail", () => {
      const { registry: reg } = createGate({
        cbConfig: { failureThreshold: 1, resetTimeoutMs: 60000, halfOpenMaxAttempts: 1 },
      });
      reg.getOrCreate("anthropic").recordFailure();

      const result = gate.requestPermit(makeJob(), 0);
      expect(isRejection(result)).toBe(true);
      if (isRejection(result)) {
        expect(result.reason).toBe(PermitRejectionReason.CIRCUIT_OPEN);
        expect(result.detail).toContain("anthropic");
      }
    });

    test("CONCURRENCY_LIMIT rejection includes detail text", () => {
      createGate({ maxConcurrency: 1 });
      const r1 = gate.requestPermit(makeJob({ jobId: "j1" }), 0);
      expect(isPermit(r1)).toBe(true);

      const r2 = gate.requestPermit(makeJob({ jobId: "j2" }), 0);
      expect(isRejection(r2)).toBe(true);
      if (isRejection(r2)) {
        expect(r2.reason).toBe(PermitRejectionReason.CONCURRENCY_LIMIT);
        expect(r2.detail).toBeDefined();
      }
    });

    test("BUDGET_EXHAUSTED (attempts) rejection includes detail text", () => {
      createGate();
      const result = gate.requestPermit(makeJob(), 3);
      expect(isRejection(result)).toBe(true);
      if (isRejection(result)) {
        expect(result.reason).toBe(PermitRejectionReason.BUDGET_EXHAUSTED);
        expect(result.detail).toBeDefined();
      }
    });
  });

  describe("dispose safety", () => {
    test("dispose aborts all active permits", () => {
      createGate({ maxConcurrency: 5 });
      const permits: PermitHandle[] = [];
      for (let i = 0; i < 5; i++) {
        const r = gate.requestPermit(makeJob({ jobId: `dispose-${i}` }), 0);
        expect(isPermit(r)).toBe(true);
        if (isPermit(r)) permits.push(r);
      }
      expect(gate.getActivePermitCount()).toBe(5);

      gate.dispose();

      expect(gate.getActivePermitCount()).toBe(0);
      for (const p of permits) {
        expect(p.abortController.signal.aborted).toBe(true);
      }
    });
  });

  describe("Permit deadline expiration", () => {
    test("permit with timeoutMs auto-revokes after deadline", async () => {
      createGate();
      const job = makeJob({ limits: { timeoutMs: 100, maxAttempts: 3, costHint: undefined } });
      const result = gate.requestPermit(job, 0);
      expect(isPermit(result)).toBe(true);
      if (!isPermit(result)) return;

      expect(gate.getActivePermitCount()).toBe(1);

      // Wait for deadline to expire
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(gate.getActivePermitCount()).toBe(0);
    });

    test("AbortSignal fires on deadline expiration", async () => {
      createGate();
      const job = makeJob({ limits: { timeoutMs: 100, maxAttempts: 3, costHint: undefined } });
      const result = gate.requestPermit(job, 0);
      expect(isPermit(result)).toBe(true);
      if (!isPermit(result)) return;

      let abortFired = false;
      result.abortController.signal.addEventListener("abort", () => {
        abortFired = true;
      });

      expect(result.abortController.signal.aborted).toBe(false);

      // Wait for deadline
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(abortFired).toBe(true);
      expect(result.abortController.signal.aborted).toBe(true);
    });

    test("permit completed before deadline does not fire abort", async () => {
      createGate();
      const job = makeJob({ limits: { timeoutMs: 200, maxAttempts: 3, costHint: undefined } });
      const result = gate.requestPermit(job, 0);
      expect(isPermit(result)).toBe(true);
      if (!isPermit(result)) return;

      let abortFired = false;
      result.abortController.signal.addEventListener("abort", () => {
        abortFired = true;
      });

      // Complete before deadline
      gate.completePermit(result.permitId);
      expect(result.abortController.signal.aborted).toBe(false);

      // Wait past the original deadline
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Should not have fired
      expect(abortFired).toBe(false);
      expect(result.abortController.signal.aborted).toBe(false);
    });
  });

  describe("PermitHandle type", () => {
    test("PermitHandle includes abortController", () => {
      createGate();
      const result = gate.requestPermit(makeJob(), 0);
      expect(isPermit(result)).toBe(true);
      if (!isPermit(result)) return;

      expect(result.abortController).toBeInstanceOf(AbortController);
      expect(result.abortController.signal).toBeDefined();
      expect(result.abortController.signal.aborted).toBe(false);
    });

    test("serializable Permit (without abortController) can be sent over IPC", () => {
      createGate();
      const result = gate.requestPermit(makeJob(), 0);
      expect(isPermit(result)).toBe(true);
      if (!isPermit(result)) return;

      // Destructure to get serializable fields
      const { abortController: _ac, ...serializablePermit } = result;

      // Serializable part should have all base Permit fields
      expect(serializablePermit.permitId).toBeDefined();
      expect(serializablePermit.jobId).toBe("job-1");
      expect(serializablePermit.deadlineAt).toBeGreaterThan(Date.now() - 1000);
      expect(serializablePermit.attemptIndex).toBe(0);
      expect(serializablePermit.tokensGranted).toBeDefined();
      expect(serializablePermit.circuitStateSnapshot).toBeDefined();

      // Should NOT have abortController
      expect("abortController" in serializablePermit).toBe(false);

      // Should be JSON-serializable
      const json = JSON.stringify(serializablePermit);
      expect(json).toBeTruthy();
      const parsed = JSON.parse(json);
      expect(parsed.permitId).toBe(serializablePermit.permitId);
    });

    test("workspaceLockToken field is supported on Permit", () => {
      createGate();
      const result = gate.requestPermit(makeJob(), 0);
      expect(isPermit(result)).toBe(true);
      if (!isPermit(result)) return;

      // workspaceLockToken is optional, should be undefined by default
      expect(result.workspaceLockToken).toBeUndefined();
    });

    test("abortController.abort propagates to signal", () => {
      createGate();
      const result = gate.requestPermit(makeJob(), 0);
      expect(isPermit(result)).toBe(true);
      if (!isPermit(result)) return;

      let abortFired = false;
      result.abortController.signal.addEventListener("abort", () => {
        abortFired = true;
      });

      result.abortController.abort("test reason");
      expect(result.abortController.signal.aborted).toBe(true);
      expect(abortFired).toBe(true);
    });

    test("each permit gets its own independent AbortController", () => {
      createGate({ maxConcurrency: 3 });
      const r1 = gate.requestPermit(makeJob({ jobId: "j1" }), 0);
      const r2 = gate.requestPermit(makeJob({ jobId: "j2" }), 0);
      expect(isPermit(r1)).toBe(true);
      expect(isPermit(r2)).toBe(true);
      if (!isPermit(r1) || !isPermit(r2)) return;

      // Aborting one should not affect the other
      r1.abortController.abort("cancel j1");
      expect(r1.abortController.signal.aborted).toBe(true);
      expect(r2.abortController.signal.aborted).toBe(false);
    });
  });
});
