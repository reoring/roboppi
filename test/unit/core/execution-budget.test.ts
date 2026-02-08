import { describe, test, expect } from "bun:test";
import { ExecutionBudget } from "../../../src/core/execution-budget.js";
import { PermitRejectionReason } from "../../../src/types/index.js";
import type { Job, Permit } from "../../../src/types/index.js";

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

function makePermit(overrides: Partial<Permit> = {}): Permit {
  return {
    permitId: "permit-1",
    jobId: "job-1",
    deadlineAt: Date.now() + 5000,
    attemptIndex: 0,
    tokensGranted: { concurrency: 1, rps: 1, costBudget: 10 },
    circuitStateSnapshot: {},
    ...overrides,
  };
}

describe("ExecutionBudget", () => {
  describe("checkAttempts", () => {
    test("allows attempt when below max", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100 });
      expect(budget.checkAttempts("job-1", 0, 3)).toBe(true);
      expect(budget.checkAttempts("job-1", 2, 3)).toBe(true);
    });

    test("rejects attempt at or above max", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100 });
      expect(budget.checkAttempts("job-1", 3, 3)).toBe(false);
      expect(budget.checkAttempts("job-1", 5, 3)).toBe(false);
    });
  });

  describe("concurrency slots", () => {
    test("tryAcquireSlot succeeds up to maxConcurrency", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 2, maxRps: 100 });
      expect(budget.tryAcquireSlot()).toBe(true);
      expect(budget.tryAcquireSlot()).toBe(true);
      expect(budget.tryAcquireSlot()).toBe(false);
    });

    test("releaseSlot frees a slot", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 1, maxRps: 100 });
      expect(budget.tryAcquireSlot()).toBe(true);
      expect(budget.tryAcquireSlot()).toBe(false);
      budget.releaseSlot();
      expect(budget.tryAcquireSlot()).toBe(true);
    });

    test("releaseSlot does not go below zero", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 1, maxRps: 100 });
      budget.releaseSlot();
      expect(budget.getActiveSlots()).toBe(0);
    });
  });

  describe("RPS limits", () => {
    test("tryAcquireRate succeeds within limit", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 100, maxRps: 3 });
      expect(budget.tryAcquireRate()).toBe(true);
      expect(budget.tryAcquireRate()).toBe(true);
      expect(budget.tryAcquireRate()).toBe(true);
      expect(budget.tryAcquireRate()).toBe(false);
    });
  });

  describe("cost tracking", () => {
    test("tryAcquireCost succeeds within budget", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100, maxCostBudget: 100 });
      expect(budget.tryAcquireCost(50)).toBe(true);
      expect(budget.tryAcquireCost(50)).toBe(true);
      expect(budget.tryAcquireCost(1)).toBe(false);
    });

    test("tryAcquireCost always succeeds when no budget set", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100 });
      expect(budget.tryAcquireCost(999999)).toBe(true);
    });

    test("releaseCost frees cost", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100, maxCostBudget: 100 });
      budget.tryAcquireCost(80);
      budget.releaseCost(50);
      expect(budget.tryAcquireCost(60)).toBe(true);
    });
  });

  describe("canIssue", () => {
    test("allows when all checks pass", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100 });
      const job = makeJob();
      const result = budget.canIssue(job, 0);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test("rejects when attempts exhausted", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100 });
      const job = makeJob();
      const result = budget.canIssue(job, 3);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(PermitRejectionReason.BUDGET_EXHAUSTED);
    });

    test("rejects when concurrency full", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 1, maxRps: 100 });
      budget.tryAcquireSlot();
      const job = makeJob();
      const result = budget.canIssue(job, 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(PermitRejectionReason.CONCURRENCY_LIMIT);
    });

    test("rejects when cost budget exceeded", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100, maxCostBudget: 5 });
      const job = makeJob(); // costHint=10
      const result = budget.canIssue(job, 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(PermitRejectionReason.BUDGET_EXHAUSTED);
    });
  });

  describe("consume and release", () => {
    test("consume increments slots and cost", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100, maxCostBudget: 100 });
      const permit = makePermit();
      budget.consume(permit);
      expect(budget.getActiveSlots()).toBe(1);
      expect(budget.getCumulativeCost()).toBe(10);
    });

    test("release decrements slots and cost", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100, maxCostBudget: 100 });
      const permit = makePermit();
      budget.consume(permit);
      budget.release(permit);
      expect(budget.getActiveSlots()).toBe(0);
      expect(budget.getCumulativeCost()).toBe(0);
    });
  });

  describe("cost budget exhaustion", () => {
    test("negative cost throws error", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100, maxCostBudget: 100 });
      expect(() => budget.tryAcquireCost(-1)).toThrow("cost must be non-negative");
      expect(() => budget.tryAcquireCost(-0.001)).toThrow("cost must be non-negative");
    });

    test("zero cost is allowed", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100, maxCostBudget: 100 });
      expect(budget.tryAcquireCost(0)).toBe(true);
      expect(budget.getCumulativeCost()).toBe(0);
    });

    test("cumulative cost exceeding limit rejects", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100, maxCostBudget: 50 });

      expect(budget.tryAcquireCost(30)).toBe(true);
      expect(budget.tryAcquireCost(20)).toBe(true);
      // Now at 50, which is the limit
      expect(budget.tryAcquireCost(1)).toBe(false);
    });

    test("multiple permits sharing cost budget: first exhausts, second rejected", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100, maxCostBudget: 20 });

      // First permit takes all budget
      const permit1 = makePermit({ permitId: "p1", tokensGranted: { concurrency: 1, rps: 1, costBudget: 20 } });
      budget.consume(permit1);
      expect(budget.getCumulativeCost()).toBe(20);

      // Second job's canIssue should be rejected due to cost
      const job2 = makeJob({ jobId: "job-2", limits: { timeoutMs: 5000, maxAttempts: 3, costHint: 5 } });
      const result = budget.canIssue(job2, 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(PermitRejectionReason.BUDGET_EXHAUSTED);

      // Release first permit, second should be allowed now
      budget.release(permit1);
      const result2 = budget.canIssue(job2, 0);
      expect(result2.allowed).toBe(true);
    });

    test("zero cost budget allows nothing with costHint", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100, maxCostBudget: 0 });

      // Any cost > 0 is rejected
      expect(budget.tryAcquireCost(1)).toBe(false);
      expect(budget.tryAcquireCost(0.001)).toBe(false);

      // But zero cost is fine
      expect(budget.tryAcquireCost(0)).toBe(true);

      // canIssue with costHint > 0 is rejected
      const job = makeJob({ limits: { timeoutMs: 5000, maxAttempts: 3, costHint: 1 } });
      const result = budget.canIssue(job, 0);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe(PermitRejectionReason.BUDGET_EXHAUSTED);
    });

    test("undefined cost budget allows everything", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100 });

      // No maxCostBudget set — any cost is accepted
      expect(budget.tryAcquireCost(999999)).toBe(true);
      expect(budget.tryAcquireCost(1000000)).toBe(true);

      // canIssue also allows regardless of costHint
      const job = makeJob({ limits: { timeoutMs: 5000, maxAttempts: 3, costHint: 999 } });
      const result = budget.canIssue(job, 0);
      expect(result.allowed).toBe(true);
    });

    test("releaseCost does not go below zero", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100, maxCostBudget: 100 });

      budget.tryAcquireCost(10);
      budget.releaseCost(20); // Release more than acquired
      expect(budget.getCumulativeCost()).toBe(0);
    });
  });
});
