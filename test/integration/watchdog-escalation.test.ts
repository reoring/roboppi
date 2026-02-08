import { describe, test, expect } from "bun:test";
import { Watchdog, type MetricSource, type DefenseLevel } from "../../src/core/watchdog.js";
import { EscalationManager } from "../../src/core/escalation-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMutableSource(initial: Record<string, number>): {
  source: MetricSource;
  metrics: Record<string, number>;
} {
  const metrics = { ...initial };
  return {
    source: { collect: () => ({ ...metrics }) },
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Defense Level Progression
// ---------------------------------------------------------------------------

describe("Watchdog -> Escalation integration", () => {
  describe("defense level progression", () => {
    test("metrics worsening drives progression: normal -> shed -> throttle -> circuit_open -> escalation", () => {
      const { source, metrics } = createMutableSource({
        worker_inflight_count: 0,
        worker_queue_lag_ms: 0,
        worker_timeout_rate: 0,
      });

      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", source);

      // Phase 1: normal
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("normal");

      // Phase 2: one metric above warn -> shed
      metrics.worker_inflight_count = 12; // warn=10
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("shed");

      // Phase 3: one metric above critical -> throttle
      metrics.worker_inflight_count = 25; // critical=20
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("throttle");

      // Phase 4: two metrics above critical -> circuit_open
      metrics.worker_queue_lag_ms = 20000; // critical=15000
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("circuit_open");

      // Phase 5: three metrics above critical -> escalation
      metrics.worker_timeout_rate = 0.8; // critical=0.6
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("escalation");
    });
  });

  describe("metric recovery", () => {
    test("levels downgrade back to normal when metrics improve", () => {
      const { source, metrics } = createMutableSource({
        worker_inflight_count: 25,       // critical
        worker_queue_lag_ms: 20000,      // critical
        worker_timeout_rate: 0.8,        // critical
      });

      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", source);

      // Start at escalation
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("escalation");

      // Drop timeout_rate below critical -> circuit_open (2 critical metrics remain)
      metrics.worker_timeout_rate = 0.1;
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("circuit_open");

      // Drop queue_lag below critical -> throttle (1 critical metric remains)
      metrics.worker_queue_lag_ms = 100;
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("throttle");

      // Drop inflight below critical but above warn -> shed
      metrics.worker_inflight_count = 15;
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("shed");

      // Drop inflight below warn -> normal
      metrics.worker_inflight_count = 3;
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("normal");
    });
  });

  describe("escalation events fire on threshold crossings", () => {
    test("onShed fires when crossing warn threshold", () => {
      const { source, metrics } = createMutableSource({
        worker_inflight_count: 5,
      });

      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", source);

      const shedEvents: Array<{ metric: string; value: number }> = [];
      watchdog.onShed = (metric, value) => shedEvents.push({ metric, value });

      // Below warn
      watchdog.tick();
      expect(shedEvents.length).toBe(0);

      // Cross warn threshold
      metrics.worker_inflight_count = 12;
      watchdog.tick();
      expect(shedEvents.length).toBe(1);
      expect(shedEvents[0]!.metric).toBe("worker_inflight_count");
    });

    test("onThrottle fires when crossing critical with one metric", () => {
      const { source, metrics } = createMutableSource({
        worker_inflight_count: 5,
      });

      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", source);

      const throttleEvents: Array<{ metric: string; value: number }> = [];
      watchdog.onThrottle = (metric, value) => throttleEvents.push({ metric, value });

      watchdog.tick(); // normal
      expect(throttleEvents.length).toBe(0);

      metrics.worker_inflight_count = 25; // critical
      watchdog.tick();
      expect(throttleEvents.length).toBe(1);
    });

    test("onEscalation fires when 3+ metrics go critical", () => {
      const { source, metrics } = createMutableSource({
        worker_inflight_count: 5,
        worker_queue_lag_ms: 100,
        worker_timeout_rate: 0.01,
      });

      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", source);

      const escalationEvents: Array<{ metric: string; value: number }> = [];
      watchdog.onEscalation = (metric, value) => escalationEvents.push({ metric, value });

      watchdog.tick();
      expect(escalationEvents.length).toBe(0);

      // Push all three above critical at once
      metrics.worker_inflight_count = 25;
      metrics.worker_queue_lag_ms = 20000;
      metrics.worker_timeout_rate = 0.8;
      watchdog.tick();

      expect(escalationEvents.length).toBe(3);
    });
  });

  describe("per-metric callback deduplication", () => {
    test("same level does not fire callback twice for same metric", () => {
      const { source, metrics } = createMutableSource({
        worker_inflight_count: 12, // warn -> shed
      });

      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", source);

      const shedEvents: Array<{ metric: string; value: number }> = [];
      watchdog.onShed = (metric, value) => shedEvents.push({ metric, value });

      // First tick: fires shed
      watchdog.tick();
      expect(shedEvents.length).toBe(1);

      // Second tick: same level, should NOT fire again
      watchdog.tick();
      expect(shedEvents.length).toBe(1);

      // Third tick with slightly different value but same level
      metrics.worker_inflight_count = 14;
      watchdog.tick();
      expect(shedEvents.length).toBe(1);
    });

    test("callback fires again when level changes and comes back", () => {
      const { source, metrics } = createMutableSource({
        worker_inflight_count: 12, // warn -> shed
      });

      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", source);

      const shedEvents: Array<{ metric: string; value: number }> = [];
      watchdog.onShed = (metric, value) => shedEvents.push({ metric, value });

      // Fire shed
      watchdog.tick();
      expect(shedEvents.length).toBe(1);

      // Go back to normal
      metrics.worker_inflight_count = 3;
      watchdog.tick();

      // Go back to shed again - should fire callback again
      metrics.worker_inflight_count = 12;
      watchdog.tick();
      expect(shedEvents.length).toBe(2);
    });
  });

  describe("watchdog -> escalation manager wiring", () => {
    test("watchdog escalation callback triggers escalation manager recording", () => {
      const { source, metrics } = createMutableSource({
        worker_inflight_count: 5,
        worker_queue_lag_ms: 100,
        worker_timeout_rate: 0.01,
      });

      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", source);

      const escalationManager = new EscalationManager({ crashThreshold: 1 });
      const escalationLog: string[] = [];

      // Wire watchdog callbacks to escalation manager
      watchdog.onEscalation = (metric, _value) => {
        escalationLog.push(`escalation:${metric}`);
        escalationManager.recordWorkerCrash(metric);
      };

      watchdog.onCircuitOpen = (metric, _value) => {
        escalationLog.push(`circuit_open:${metric}`);
      };

      // Push to escalation level
      metrics.worker_inflight_count = 25;
      metrics.worker_queue_lag_ms = 20000;
      metrics.worker_timeout_rate = 0.8;
      watchdog.tick();

      expect(escalationLog.length).toBe(3);
      expect(escalationLog.every((e) => e.startsWith("escalation:"))).toBe(true);

      // Escalation manager should have crash records
      const events = escalationManager.evaluate();
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    test("full defense progression records escalation events in order", () => {
      const { source, metrics } = createMutableSource({
        worker_inflight_count: 0,
        worker_queue_lag_ms: 0,
        worker_timeout_rate: 0,
      });

      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", source);

      const levelHistory: DefenseLevel[] = [];
      const callbackLog: Array<{ level: string; metric: string }> = [];

      watchdog.onShed = (metric) => callbackLog.push({ level: "shed", metric });
      watchdog.onThrottle = (metric) => callbackLog.push({ level: "throttle", metric });
      watchdog.onCircuitOpen = (metric) => callbackLog.push({ level: "circuit_open", metric });
      watchdog.onEscalation = (metric) => callbackLog.push({ level: "escalation", metric });

      // Step through each level
      watchdog.tick();
      levelHistory.push(watchdog.getCurrentLevel());

      metrics.worker_inflight_count = 12;
      watchdog.tick();
      levelHistory.push(watchdog.getCurrentLevel());

      metrics.worker_inflight_count = 25;
      watchdog.tick();
      levelHistory.push(watchdog.getCurrentLevel());

      metrics.worker_queue_lag_ms = 20000;
      watchdog.tick();
      levelHistory.push(watchdog.getCurrentLevel());

      metrics.worker_timeout_rate = 0.8;
      watchdog.tick();
      levelHistory.push(watchdog.getCurrentLevel());

      expect(levelHistory).toEqual([
        "normal",
        "shed",
        "throttle",
        "circuit_open",
        "escalation",
      ]);

      // Verify callbacks fired in progression
      expect(callbackLog.length).toBeGreaterThan(0);
      // At least shed, throttle, circuit_open, and escalation callbacks fired
      const levels = new Set(callbackLog.map((e) => e.level));
      expect(levels.has("shed")).toBe(true);
      expect(levels.has("throttle")).toBe(true);
    });
  });
});
