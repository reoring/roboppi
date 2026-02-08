import { describe, test, expect } from "bun:test";
import {
  InFlightRegistry,
  DeduplicationPolicy,
} from "../../../src/scheduler/inflight-registry.js";
import { generateId } from "../../../src/types/index.js";

describe("InFlightRegistry", () => {
  test("register new key returns proceed", () => {
    const registry = new InFlightRegistry();
    const result = registry.register("key-1", generateId(), DeduplicationPolicy.COALESCE);
    expect(result.action).toBe("proceed");
  });

  test("lookup returns jobId for registered key", () => {
    const registry = new InFlightRegistry();
    const jobId = generateId();
    registry.register("key-1", jobId, DeduplicationPolicy.COALESCE);
    expect(registry.lookup("key-1")).toBe(jobId);
  });

  test("lookup returns undefined for unregistered key", () => {
    const registry = new InFlightRegistry();
    expect(registry.lookup("nonexistent")).toBeUndefined();
  });

  test("isInFlight returns correct state", () => {
    const registry = new InFlightRegistry();
    const jobId = generateId();
    expect(registry.isInFlight("key-1")).toBe(false);
    registry.register("key-1", jobId, DeduplicationPolicy.COALESCE);
    expect(registry.isInFlight("key-1")).toBe(true);
  });

  test("deregister removes the entry", () => {
    const registry = new InFlightRegistry();
    const jobId = generateId();
    registry.register("key-1", jobId, DeduplicationPolicy.COALESCE);
    registry.deregister("key-1");
    expect(registry.isInFlight("key-1")).toBe(false);
    expect(registry.lookup("key-1")).toBeUndefined();
  });

  // COALESCE policy tests
  describe("COALESCE policy", () => {
    test("returns coalesce with existing jobId on duplicate", () => {
      const registry = new InFlightRegistry();
      const existingJobId = generateId();
      const newJobId = generateId();

      registry.register("key-1", existingJobId, DeduplicationPolicy.COALESCE);
      const result = registry.register("key-1", newJobId, DeduplicationPolicy.COALESCE);

      expect(result.action).toBe("coalesce");
      expect(result).toHaveProperty("existingJobId", existingJobId);
    });

    test("existing job remains in registry after coalesce", () => {
      const registry = new InFlightRegistry();
      const existingJobId = generateId();
      const newJobId = generateId();

      registry.register("key-1", existingJobId, DeduplicationPolicy.COALESCE);
      registry.register("key-1", newJobId, DeduplicationPolicy.COALESCE);

      // Original job is still the one registered
      expect(registry.lookup("key-1")).toBe(existingJobId);
    });
  });

  // LATEST_WINS policy tests
  describe("LATEST_WINS policy", () => {
    test("returns proceed with cancelJobId on duplicate", () => {
      const registry = new InFlightRegistry();
      const existingJobId = generateId();
      const newJobId = generateId();

      registry.register("key-1", existingJobId, DeduplicationPolicy.LATEST_WINS);
      const result = registry.register("key-1", newJobId, DeduplicationPolicy.LATEST_WINS);

      expect(result.action).toBe("proceed");
      expect(result).toHaveProperty("cancelJobId", existingJobId);
    });

    test("replaces old entry with new job in registry", () => {
      const registry = new InFlightRegistry();
      const existingJobId = generateId();
      const newJobId = generateId();

      registry.register("key-1", existingJobId, DeduplicationPolicy.LATEST_WINS);
      registry.register("key-1", newJobId, DeduplicationPolicy.LATEST_WINS);

      // New job replaced the old one
      expect(registry.lookup("key-1")).toBe(newJobId);
    });
  });

  // REJECT policy tests
  describe("REJECT policy", () => {
    test("returns reject with existing jobId on duplicate", () => {
      const registry = new InFlightRegistry();
      const existingJobId = generateId();
      const newJobId = generateId();

      registry.register("key-1", existingJobId, DeduplicationPolicy.REJECT);
      const result = registry.register("key-1", newJobId, DeduplicationPolicy.REJECT);

      expect(result.action).toBe("reject");
      expect(result).toHaveProperty("existingJobId", existingJobId);
    });

    test("existing job remains in registry after reject", () => {
      const registry = new InFlightRegistry();
      const existingJobId = generateId();
      const newJobId = generateId();

      registry.register("key-1", existingJobId, DeduplicationPolicy.REJECT);
      registry.register("key-1", newJobId, DeduplicationPolicy.REJECT);

      expect(registry.lookup("key-1")).toBe(existingJobId);
    });
  });

  test("different keys are independent", () => {
    const registry = new InFlightRegistry();
    const jobA = generateId();
    const jobB = generateId();

    registry.register("key-a", jobA, DeduplicationPolicy.COALESCE);
    const result = registry.register("key-b", jobB, DeduplicationPolicy.COALESCE);

    expect(result.action).toBe("proceed");
    expect(registry.lookup("key-a")).toBe(jobA);
    expect(registry.lookup("key-b")).toBe(jobB);
  });

  test("deregister then re-register proceeds normally", () => {
    const registry = new InFlightRegistry();
    const jobId1 = generateId();
    const jobId2 = generateId();

    registry.register("key-1", jobId1, DeduplicationPolicy.REJECT);
    registry.deregister("key-1");

    const result = registry.register("key-1", jobId2, DeduplicationPolicy.REJECT);
    expect(result.action).toBe("proceed");
    expect(registry.lookup("key-1")).toBe(jobId2);
  });
});
