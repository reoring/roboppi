/**
 * Unit tests: ActivityTracker
 */
import { describe, test, expect } from "bun:test";
import { ActivityTracker } from "../../src/workflow/sentinel/activity-tracker.js";
import type { ExecEvent } from "../../src/tui/exec-event.js";

describe("ActivityTracker", () => {
  test("register() creates initial timestamps", () => {
    const tracker = new ActivityTracker();
    const startTs = 1000;

    tracker.register("step-1", startTs);
    const activity = tracker.get("step-1");

    expect(activity).toBeDefined();
    expect(activity!.stepId).toBe("step-1");
    expect(activity!.lastWorkerOutputTs).toBe(startTs);
    expect(activity!.lastStepPhaseTs).toBe(startTs);
    expect(activity!.lastStepStateTs).toBe(startTs);
  });

  test("onEvent(worker_event) updates lastWorkerOutputTs", () => {
    const tracker = new ActivityTracker();
    tracker.register("step-1", 1000);

    const event: ExecEvent = {
      type: "worker_event",
      stepId: "step-1",
      ts: 2000,
      event: { type: "stdout", data: "hello" },
    };
    tracker.onEvent(event);

    const activity = tracker.get("step-1")!;
    expect(activity.lastWorkerOutputTs).toBe(2000);
    // Other timestamps should remain at initial value
    expect(activity.lastStepPhaseTs).toBe(1000);
    expect(activity.lastStepStateTs).toBe(1000);
  });

  test("onEvent(step_phase) updates lastStepPhaseTs", () => {
    const tracker = new ActivityTracker();
    tracker.register("step-1", 1000);

    const event: ExecEvent = {
      type: "step_phase",
      stepId: "step-1",
      phase: "executing",
      at: 3000,
    };
    tracker.onEvent(event);

    const activity = tracker.get("step-1")!;
    expect(activity.lastStepPhaseTs).toBe(3000);
    expect(activity.lastWorkerOutputTs).toBe(1000);
  });

  test("onEvent(step_state) updates lastStepStateTs", () => {
    const tracker = new ActivityTracker();
    tracker.register("step-1", 1000);

    const beforeTs = Date.now();
    const event: ExecEvent = {
      type: "step_state",
      stepId: "step-1",
      status: "RUNNING" as any,
      iteration: 1,
      maxIterations: 5,
    };
    tracker.onEvent(event);
    const afterTs = Date.now();

    const activity = tracker.get("step-1")!;
    // step_state uses Date.now() internally
    expect(activity.lastStepStateTs).toBeGreaterThanOrEqual(beforeTs);
    expect(activity.lastStepStateTs).toBeLessThanOrEqual(afterTs);
    expect(activity.lastWorkerOutputTs).toBe(1000);
  });

  test("unregister() removes step", () => {
    const tracker = new ActivityTracker();
    tracker.register("step-1", 1000);
    expect(tracker.get("step-1")).toBeDefined();

    tracker.unregister("step-1");
    expect(tracker.get("step-1")).toBeUndefined();
  });

  test("get() returns undefined for unregistered steps", () => {
    const tracker = new ActivityTracker();
    expect(tracker.get("nonexistent")).toBeUndefined();
  });

  test("hasReceivedWorkerEvent is false after register", () => {
    const tracker = new ActivityTracker();
    tracker.register("step-1", 1000);

    const activity = tracker.get("step-1");
    expect(activity).toBeDefined();
    expect(activity!.hasReceivedWorkerEvent).toBe(false);
  });

  test("hasReceivedWorkerEvent becomes true after worker_event", () => {
    const tracker = new ActivityTracker();
    tracker.register("step-1", 1000);

    tracker.onEvent({
      type: "worker_event",
      stepId: "step-1",
      ts: 2000,
      event: { type: "stdout", data: "output" },
    } as any);

    const activity = tracker.get("step-1");
    expect(activity!.hasReceivedWorkerEvent).toBe(true);
  });

  test("hasReceivedWorkerEvent remains false for step_phase and step_state events", () => {
    const tracker = new ActivityTracker();
    tracker.register("step-1", 1000);

    tracker.onEvent({
      type: "step_phase",
      stepId: "step-1",
      at: 2000,
      phase: "executing",
    } as any);

    tracker.onEvent({
      type: "step_state",
      stepId: "step-1",
      status: "RUNNING",
    } as any);

    const activity = tracker.get("step-1");
    expect(activity!.hasReceivedWorkerEvent).toBe(false);
  });
});
