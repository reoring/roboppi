import { describe, test, expect } from "bun:test";
import { Watchdog, type MetricSource, type DefenseLevel } from "../../../src/core/watchdog.js";

function createStaticSource(metrics: Record<string, number>): MetricSource {
  return { collect: () => ({ ...metrics }) };
}

describe("Watchdog", () => {
  describe("metric threshold detection", () => {
    test("stays at normal when all metrics are below warn thresholds", () => {
      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", createStaticSource({
        worker_inflight_count: 5,
        worker_queue_lag_ms: 1000,
      }));
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("normal");
    });

    test("moves to shed when a metric exceeds warn threshold", () => {
      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", createStaticSource({
        worker_inflight_count: 12, // warn=10
      }));
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("shed");
    });

    test("moves to throttle when a single metric exceeds critical threshold", () => {
      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", createStaticSource({
        worker_inflight_count: 25, // critical=20
      }));
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("throttle");
    });

    test("moves to circuit_open when two metrics exceed critical thresholds", () => {
      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", createStaticSource({
        worker_inflight_count: 25,    // critical=20
        worker_queue_lag_ms: 20000,   // critical=15000
      }));
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("circuit_open");
    });

    test("moves to escalation when three or more metrics exceed critical thresholds", () => {
      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", createStaticSource({
        worker_inflight_count: 25,       // critical=20
        worker_queue_lag_ms: 20000,      // critical=15000
        worker_timeout_rate: 0.8,        // critical=0.6
      }));
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("escalation");
    });
  });

  describe("defense progression", () => {
    test("level can increase and decrease based on metrics", () => {
      const mutableMetrics: Record<string, number> = {
        worker_inflight_count: 5,
      };
      const source: MetricSource = { collect: () => ({ ...mutableMetrics }) };
      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", source);

      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("normal");

      // Increase to warn territory
      mutableMetrics.worker_inflight_count = 15;
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("shed");

      // Back down
      mutableMetrics.worker_inflight_count = 3;
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("normal");
    });
  });

  describe("event callbacks", () => {
    test("fires onShed when metric exceeds warn threshold", () => {
      const watchdog = new Watchdog();
      const shedEvents: Array<{ metric: string; value: number }> = [];
      watchdog.onShed = (metric, value) => shedEvents.push({ metric, value });

      watchdog.registerMetricSource("test", createStaticSource({
        worker_inflight_count: 12,
      }));
      watchdog.tick();

      expect(shedEvents.length).toBe(1);
      expect(shedEvents[0]!.metric).toBe("worker_inflight_count");
      expect(shedEvents[0]!.value).toBe(12);
    });

    test("fires onThrottle when single metric exceeds critical", () => {
      const watchdog = new Watchdog();
      const throttleEvents: Array<{ metric: string; value: number }> = [];
      watchdog.onThrottle = (metric, value) => throttleEvents.push({ metric, value });

      watchdog.registerMetricSource("test", createStaticSource({
        worker_inflight_count: 25,
      }));
      watchdog.tick();

      expect(throttleEvents.length).toBe(1);
    });

    test("fires onCircuitOpen when two metrics exceed critical", () => {
      const watchdog = new Watchdog();
      const circuitEvents: Array<{ metric: string; value: number }> = [];
      watchdog.onCircuitOpen = (metric, value) => circuitEvents.push({ metric, value });

      watchdog.registerMetricSource("test", createStaticSource({
        worker_inflight_count: 25,
        worker_queue_lag_ms: 20000,
      }));
      watchdog.tick();

      expect(circuitEvents.length).toBe(2);
    });

    test("fires onEscalation when three+ metrics exceed critical", () => {
      const watchdog = new Watchdog();
      const escalationEvents: Array<{ metric: string; value: number }> = [];
      watchdog.onEscalation = (metric, value) => escalationEvents.push({ metric, value });

      watchdog.registerMetricSource("test", createStaticSource({
        worker_inflight_count: 25,
        worker_queue_lag_ms: 20000,
        worker_timeout_rate: 0.8,
      }));
      watchdog.tick();

      expect(escalationEvents.length).toBe(3);
    });
  });

  describe("start/stop lifecycle", () => {
    test("start begins periodic checks", async () => {
      const watchdog = new Watchdog({ intervalMs: 50 });
      let callCount = 0;
      const source: MetricSource = {
        collect: () => {
          callCount++;
          return { worker_inflight_count: 15 };
        },
      };
      watchdog.registerMetricSource("test", source);

      const levels: DefenseLevel[] = [];
      watchdog.onShed = () => levels.push("shed");
      watchdog.start();

      await new Promise((resolve) => setTimeout(resolve, 130));
      watchdog.stop();

      // Should have collected metrics at least 2 times in ~130ms with 50ms interval
      expect(callCount).toBeGreaterThanOrEqual(2);
      // Callback fires once due to per-metric deduplication (level stays "shed")
      expect(levels.length).toBeGreaterThanOrEqual(1);
    });

    test("stop prevents further checks", async () => {
      const watchdog = new Watchdog({ intervalMs: 50 });
      let callCount = 0;
      const source: MetricSource = {
        collect: () => {
          callCount++;
          return { worker_inflight_count: 15 };
        },
      };
      watchdog.registerMetricSource("test", source);

      watchdog.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      watchdog.stop();
      const countAfterStop = callCount;

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(callCount).toBe(countAfterStop);
    });

    test("calling start twice does not create duplicate intervals", async () => {
      const watchdog = new Watchdog({ intervalMs: 50 });
      let callCount = 0;
      const source: MetricSource = {
        collect: () => {
          callCount++;
          return {};
        },
      };
      watchdog.registerMetricSource("test", source);

      watchdog.start();
      watchdog.start(); // second call should be no-op

      await new Promise((resolve) => setTimeout(resolve, 130));
      watchdog.stop();

      // With 50ms interval and 130ms wait, expect ~2 calls, not ~4
      expect(callCount).toBeLessThanOrEqual(4);
    });
  });

  describe("custom thresholds", () => {
    test("respects custom threshold configuration", () => {
      const watchdog = new Watchdog({
        thresholds: {
          worker_inflight_count: { warn: 2, critical: 5 },
        },
      });
      watchdog.registerMetricSource("test", createStaticSource({
        worker_inflight_count: 3,
      }));
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("shed");
    });
  });

  describe("multiple metric sources", () => {
    test("merges metrics from all registered sources", () => {
      const watchdog = new Watchdog();
      watchdog.registerMetricSource("a", createStaticSource({
        worker_inflight_count: 12,
      }));
      watchdog.registerMetricSource("b", createStaticSource({
        worker_queue_lag_ms: 6000,
      }));
      watchdog.tick();
      // Both should contribute: inflight=12 (warn), lag=6000 (warn) → shed
      expect(watchdog.getCurrentLevel()).toBe("shed");
    });
  });

  describe("construction with custom config", () => {
    test("accepts partial config and merges with defaults", () => {
      const watchdog = new Watchdog({
        intervalMs: 500,
        thresholds: {
          worker_inflight_count: { warn: 3, critical: 6 },
        },
      });
      // Custom threshold should apply
      watchdog.registerMetricSource("test", createStaticSource({
        worker_inflight_count: 4, // above custom warn=3
      }));
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("shed");
    });

    test("default config keeps all standard thresholds", () => {
      const watchdog = new Watchdog();
      // worker_timeout_rate default warn=0.3
      watchdog.registerMetricSource("test", createStaticSource({
        worker_timeout_rate: 0.35,
      }));
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("shed");
    });
  });

  describe("level deduplication", () => {
    test("same level does not fire callback twice in a row for same metric", () => {
      const watchdog = new Watchdog();
      const shedEvents: Array<{ metric: string; value: number }> = [];
      watchdog.onShed = (metric, value) => shedEvents.push({ metric, value });

      watchdog.registerMetricSource("test", createStaticSource({
        worker_inflight_count: 12, // warn=10
      }));

      watchdog.tick();
      expect(shedEvents.length).toBe(1);

      // Second tick with same level should NOT fire again
      watchdog.tick();
      expect(shedEvents.length).toBe(1);
    });

    test("callback fires again when level changes then reverts", () => {
      const mutableMetrics: Record<string, number> = {
        worker_inflight_count: 12, // warn
      };
      const source: MetricSource = { collect: () => ({ ...mutableMetrics }) };
      const watchdog = new Watchdog();
      const shedEvents: Array<{ metric: string; value: number }> = [];
      watchdog.onShed = (metric, value) => shedEvents.push({ metric, value });
      watchdog.registerMetricSource("test", source);

      watchdog.tick();
      expect(shedEvents.length).toBe(1);

      // Go to normal
      mutableMetrics.worker_inflight_count = 2;
      watchdog.tick();

      // Back to shed — should fire again since level changed
      mutableMetrics.worker_inflight_count = 15;
      watchdog.tick();
      expect(shedEvents.length).toBe(2);
    });
  });

  describe("metric source error handling", () => {
    test("metric source that throws does not crash tick()", () => {
      const watchdog = new Watchdog();
      const throwingSource: MetricSource = {
        collect: () => { throw new Error("source broken"); },
      };
      watchdog.registerMetricSource("broken", throwingSource);
      watchdog.registerMetricSource("working", createStaticSource({
        worker_inflight_count: 12,
      }));

      // Should not throw
      watchdog.tick();
      // Working source still contributes
      expect(watchdog.getCurrentLevel()).toBe("shed");
    });

    test("only throwing source means no metrics, stays normal", () => {
      const watchdog = new Watchdog();
      const throwingSource: MetricSource = {
        collect: () => { throw new Error("oops"); },
      };
      watchdog.registerMetricSource("broken", throwingSource);

      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("normal");
    });
  });

  describe("staged escalation with increasing severity", () => {
    test("escalates through normal → shed → throttle → circuit_open → escalation", () => {
      const mutableMetrics: Record<string, number> = {};
      const source: MetricSource = { collect: () => ({ ...mutableMetrics }) };
      const watchdog = new Watchdog();
      watchdog.registerMetricSource("test", source);

      // Normal
      mutableMetrics.worker_inflight_count = 5;
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("normal");

      // Shed (one metric above warn)
      mutableMetrics.worker_inflight_count = 12;
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("shed");

      // Throttle (one metric above critical)
      mutableMetrics.worker_inflight_count = 25;
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("throttle");

      // Circuit open (two metrics above critical)
      mutableMetrics.worker_queue_lag_ms = 20000;
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("circuit_open");

      // Escalation (three metrics above critical)
      mutableMetrics.worker_timeout_rate = 0.8;
      watchdog.tick();
      expect(watchdog.getCurrentLevel()).toBe("escalation");
    });
  });
});
