import { describe, test, expect } from "bun:test";
import { BackpressureController, BackpressureResponse } from "../../../src/core/backpressure.js";

describe("BackpressureController", () => {
  // Thresholds are now in 0-1 range matching normalized load
  const thresholds = {
    rejectThreshold: 1.0,
    deferThreshold: 0.8,
    degradeThreshold: 0.5,
  };

  // Normalization config: determines how raw metrics map to 0-1 range
  const normalization = {
    maxActivePermits: 100,
    maxQueueDepth: 1000,
    maxLatencyMs: 10000,
  };

  test("returns ACCEPT when load is low", () => {
    const bp = new BackpressureController(thresholds, normalization);
    bp.updateMetrics({ activePermits: 10, queueDepth: 5, avgLatencyMs: 100 });
    expect(bp.check()).toBe(BackpressureResponse.ACCEPT);
  });

  test("returns DEGRADE when load reaches degradeThreshold", () => {
    const bp = new BackpressureController(thresholds, normalization);
    // 55/100 = 0.55 >= 0.5 degradeThreshold
    bp.updateMetrics({ activePermits: 55, queueDepth: 0, avgLatencyMs: 0 });
    expect(bp.check()).toBe(BackpressureResponse.DEGRADE);
  });

  test("returns DEFER when load reaches deferThreshold", () => {
    const bp = new BackpressureController(thresholds, normalization);
    // 85/100 = 0.85 >= 0.8 deferThreshold
    bp.updateMetrics({ activePermits: 85, queueDepth: 0, avgLatencyMs: 0 });
    expect(bp.check()).toBe(BackpressureResponse.DEFER);
  });

  test("returns REJECT when load reaches rejectThreshold", () => {
    const bp = new BackpressureController(thresholds, normalization);
    // 100/100 = 1.0 >= 1.0 rejectThreshold
    bp.updateMetrics({ activePermits: 100, queueDepth: 0, avgLatencyMs: 0 });
    expect(bp.check()).toBe(BackpressureResponse.REJECT);
  });

  test("high latency triggers higher response levels", () => {
    const bp = new BackpressureController(thresholds, normalization);
    // 10000/10000 = 1.0 >= 1.0 rejectThreshold
    bp.updateMetrics({ activePermits: 0, queueDepth: 0, avgLatencyMs: 10000 });
    expect(bp.check()).toBe(BackpressureResponse.REJECT);
  });

  test("high queue depth triggers higher response levels", () => {
    const bp = new BackpressureController(thresholds, normalization);
    // 1000/1000 = 1.0 >= 1.0 rejectThreshold
    bp.updateMetrics({ activePermits: 0, queueDepth: 1000, avgLatencyMs: 0 });
    expect(bp.check()).toBe(BackpressureResponse.REJECT);
  });

  test("getMetrics returns current metrics", () => {
    const bp = new BackpressureController(thresholds, normalization);
    const metrics = { activePermits: 42, queueDepth: 7, avgLatencyMs: 150 };
    bp.updateMetrics(metrics);
    expect(bp.getMetrics()).toEqual(metrics);
  });

  test("getMetrics returns a copy, not a reference", () => {
    const bp = new BackpressureController(thresholds, normalization);
    const metrics = { activePermits: 1, queueDepth: 1, avgLatencyMs: 1 };
    bp.updateMetrics(metrics);
    const result = bp.getMetrics();
    result.activePermits = 999;
    expect(bp.getMetrics().activePermits).toBe(1);
  });

  test("default metrics return ACCEPT", () => {
    const bp = new BackpressureController(thresholds, normalization);
    expect(bp.check()).toBe(BackpressureResponse.ACCEPT);
  });
});
