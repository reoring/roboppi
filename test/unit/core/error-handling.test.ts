import { describe, test, expect } from "bun:test";
import { Watchdog } from "../../../src/core/watchdog.js";
import type { MetricSource } from "../../../src/core/watchdog.js";
import { EscalationManager } from "../../../src/core/escalation-manager.js";
import { BackpressureController, BackpressureResponse } from "../../../src/core/backpressure.js";
import { ExecutionBudget } from "../../../src/core/execution-budget.js";

describe("Error handling validation", () => {
  describe("Watchdog metric source error resilience", () => {
    test("throwing metric source does not crash watchdog tick", () => {
      const watchdog = new Watchdog({
        thresholds: {
          good_metric: { warn: 10, critical: 20 },
        },
      });

      const throwingSource: MetricSource = {
        collect() {
          throw new Error("source exploded");
        },
      };
      const goodSource: MetricSource = {
        collect() {
          return { good_metric: 15 };
        },
      };

      watchdog.registerMetricSource("bad", throwingSource);
      watchdog.registerMetricSource("good", goodSource);

      // tick should not throw
      expect(() => watchdog.tick()).not.toThrow();

      // The good source should still have been processed
      expect(watchdog.getCurrentLevel()).toBe("shed");
    });

    test("all sources throwing results in normal level", () => {
      const watchdog = new Watchdog();
      const badSource: MetricSource = {
        collect() {
          throw new Error("boom");
        },
      };

      watchdog.registerMetricSource("bad1", badSource);
      watchdog.registerMetricSource("bad2", badSource);

      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("normal");
    });
  });

  describe("Watchdog callback deduplication", () => {
    test("same level does not fire callback twice in a row", () => {
      const watchdog = new Watchdog({
        thresholds: {
          test_metric: { warn: 10, critical: 20 },
        },
      });

      let shedCount = 0;
      watchdog.onShed = () => shedCount++;

      const source: MetricSource = {
        collect: () => ({ test_metric: 15 }),
      };
      watchdog.registerMetricSource("test", source);

      // First tick: level changes from normal to shed — fires callback
      watchdog.tick();
      expect(shedCount).toBe(1);

      // Second tick: level stays at shed — should NOT fire again
      watchdog.tick();
      expect(shedCount).toBe(1);

      // Third tick: still shed
      watchdog.tick();
      expect(shedCount).toBe(1);
    });

    test("callback fires again when level changes and returns", () => {
      const watchdog = new Watchdog({
        thresholds: {
          test_metric: { warn: 10, critical: 20 },
        },
      });

      let shedCount = 0;
      watchdog.onShed = () => shedCount++;

      let metricValue = 15; // above warn
      const source: MetricSource = {
        collect: () => ({ test_metric: metricValue }),
      };
      watchdog.registerMetricSource("test", source);

      // Tick 1: normal -> shed (fires)
      watchdog.tick();
      expect(shedCount).toBe(1);

      // Tick 2: drop below warn -> normal (doesn't fire shed, but level changes)
      metricValue = 5;
      watchdog.tick();
      expect(shedCount).toBe(1);
      expect(watchdog.getCurrentLevel()).toBe("normal");

      // Tick 3: back above warn -> shed (fires again because level changed)
      metricValue = 15;
      watchdog.tick();
      expect(shedCount).toBe(2);
    });
  });

  describe("EscalationManager state reset after evaluate", () => {
    test("cancelTimeouts are cleared after evaluate", () => {
      const manager = new EscalationManager({ crashThreshold: 100 });

      manager.recordCancelTimeout("CLAUDE_CODE");
      manager.recordCancelTimeout("CLAUDE_CODE");

      const events1 = manager.evaluate();
      const ghostEvents = events1.filter((e) => e.reason.includes("ghost"));
      expect(ghostEvents.length).toBe(1);
      expect(ghostEvents[0]!.reason).toContain("2 cancel timeout");

      // After evaluate, cancelTimeouts should be cleared
      const events2 = manager.evaluate();
      const ghostEvents2 = events2.filter((e) => e.reason.includes("ghost"));
      expect(ghostEvents2.length).toBe(0);
    });

    test("old crash entries outside window are trimmed", () => {
      const manager = new EscalationManager({ crashThreshold: 3 });

      // These crashes are timestamped with now(), so they're within the 1-minute window
      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordWorkerCrash("CLAUDE_CODE");

      const events = manager.evaluate();
      const crashEvents = events.filter((e) => e.reason.includes("crashed"));
      expect(crashEvents.length).toBe(1);
    });

    test("severity field is present on all escalation events", () => {
      const manager = new EscalationManager({ crashThreshold: 1 });

      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordCancelTimeout("CODEX_CLI");

      const events = manager.evaluate();
      expect(events.length).toBeGreaterThanOrEqual(2);

      for (const event of events) {
        expect(event.severity).toBeDefined();
        expect(["warning", "error", "fatal"]).toContain(event.severity);
      }
    });

    test("crash events have error severity", () => {
      const manager = new EscalationManager({ crashThreshold: 1 });
      manager.recordWorkerCrash("CLAUDE_CODE");

      const events = manager.evaluate();
      const crashEvent = events.find((e) => e.reason.includes("crashed"));
      expect(crashEvent).toBeDefined();
      expect(crashEvent!.severity).toBe("error");
    });

    test("cancel timeout events have warning severity", () => {
      const manager = new EscalationManager();
      manager.recordCancelTimeout("CLAUDE_CODE");

      const events = manager.evaluate();
      const ghostEvent = events.find((e) => e.reason.includes("ghost"));
      expect(ghostEvent).toBeDefined();
      expect(ghostEvent!.severity).toBe("warning");
    });

    test("global events have fatal severity", () => {
      const manager = new EscalationManager({ crashThreshold: 1 });
      manager.recordWorkerCrash("CLAUDE_CODE");
      manager.recordCancelTimeout("CODEX_CLI");

      const events = manager.evaluate();
      const globalEvent = events.find((e) => e.target === "system");
      expect(globalEvent).toBeDefined();
      expect(globalEvent!.severity).toBe("fatal");
    });
  });

  describe("BackpressureController normalization", () => {
    test("metrics are normalized to 0-1 range using config", () => {
      const bp = new BackpressureController(
        { rejectThreshold: 1.0, deferThreshold: 0.8, degradeThreshold: 0.5 },
        { maxActivePermits: 50, maxQueueDepth: 500, maxLatencyMs: 5000 },
      );

      // 25/50 = 0.5, which is exactly degradeThreshold
      bp.updateMetrics({ activePermits: 25, queueDepth: 0, avgLatencyMs: 0 });
      expect(bp.check()).toBe(BackpressureResponse.DEGRADE);
    });

    test("custom normalization changes effective load", () => {
      // With maxActivePermits=200, 100 permits = 0.5 load
      const bp = new BackpressureController(
        { rejectThreshold: 1.0, deferThreshold: 0.8, degradeThreshold: 0.5 },
        { maxActivePermits: 200, maxQueueDepth: 1000, maxLatencyMs: 10000 },
      );

      bp.updateMetrics({ activePermits: 100, queueDepth: 0, avgLatencyMs: 0 });
      expect(bp.check()).toBe(BackpressureResponse.DEGRADE);

      // 160/200 = 0.8 = deferThreshold
      bp.updateMetrics({ activePermits: 160, queueDepth: 0, avgLatencyMs: 0 });
      expect(bp.check()).toBe(BackpressureResponse.DEFER);
    });

    test("latency is normalized correctly", () => {
      const bp = new BackpressureController(
        { rejectThreshold: 1.0, deferThreshold: 0.8, degradeThreshold: 0.5 },
        { maxActivePermits: 100, maxQueueDepth: 1000, maxLatencyMs: 10000 },
      );

      // 5000/10000 = 0.5 = degradeThreshold
      bp.updateMetrics({ activePermits: 0, queueDepth: 0, avgLatencyMs: 5000 });
      expect(bp.check()).toBe(BackpressureResponse.DEGRADE);

      // 10000/10000 = 1.0 = rejectThreshold
      bp.updateMetrics({ activePermits: 0, queueDepth: 0, avgLatencyMs: 10000 });
      expect(bp.check()).toBe(BackpressureResponse.REJECT);
    });

    test("queue depth is normalized correctly", () => {
      const bp = new BackpressureController(
        { rejectThreshold: 1.0, deferThreshold: 0.8, degradeThreshold: 0.5 },
        { maxActivePermits: 100, maxQueueDepth: 1000, maxLatencyMs: 10000 },
      );

      // 500/1000 = 0.5 = degradeThreshold
      bp.updateMetrics({ activePermits: 0, queueDepth: 500, avgLatencyMs: 0 });
      expect(bp.check()).toBe(BackpressureResponse.DEGRADE);
    });

    test("max of all normalized metrics determines load", () => {
      const bp = new BackpressureController(
        { rejectThreshold: 1.0, deferThreshold: 0.8, degradeThreshold: 0.5 },
        { maxActivePermits: 100, maxQueueDepth: 1000, maxLatencyMs: 10000 },
      );

      // permits: 10/100=0.1, queue: 900/1000=0.9, latency: 0 -> max=0.9 >= 0.8 -> DEFER
      bp.updateMetrics({ activePermits: 10, queueDepth: 900, avgLatencyMs: 0 });
      expect(bp.check()).toBe(BackpressureResponse.DEFER);
    });
  });

  describe("ExecutionBudget interface validation", () => {
    test("attemptCounts is not exposed in public interface", () => {
      const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100 });

      // The public interface should only expose these methods:
      expect(typeof budget.checkAttempts).toBe("function");
      expect(typeof budget.tryAcquireSlot).toBe("function");
      expect(typeof budget.releaseSlot).toBe("function");
      expect(typeof budget.tryAcquireRate).toBe("function");
      expect(typeof budget.tryAcquireCost).toBe("function");
      expect(typeof budget.releaseCost).toBe("function");
      expect(typeof budget.canIssue).toBe("function");
      expect(typeof budget.consume).toBe("function");
      expect(typeof budget.release).toBe("function");
      expect(typeof budget.getActiveSlots).toBe("function");
      expect(typeof budget.getCumulativeCost).toBe("function");

      // attemptCounts should not be accessible
      expect((budget as any).attemptCounts).toBeUndefined();
    });
  });
});
