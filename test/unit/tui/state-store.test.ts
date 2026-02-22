import { describe, test, expect } from "bun:test";
import { TuiStateStore } from "../../../src/tui/state-store.js";
import type { ExecEvent } from "../../../src/tui/exec-event.js";
import { WorkflowStatus, StepStatus } from "../../../src/workflow/types.js";
import { WorkerStatus } from "../../../src/types/worker-result.js";

describe("TuiStateStore", () => {
  test("initializes with default state", () => {
    const store = new TuiStateStore();
    expect(store.state.steps.size).toBe(0);
    expect(store.state.stepOrder).toEqual([]);
    expect(store.state.followMode).toBe("running");
    expect(store.state.selectedTab).toBe("overview");
    expect(store.state.coreLogs.length).toBe(0);
    expect(store.state.warnings.length).toBe(0);
    expect(store.dirty).toBe(false);
  });

  test("handles workflow_started event", () => {
    const store = new TuiStateStore();
    const event: ExecEvent = {
      type: "workflow_started",
      workflowId: "wf-1",
      name: "test-workflow",
      workspaceDir: "/tmp/ws",
      supervised: true,
      startedAt: 1000,
      definitionSummary: {
        steps: ["step-a", "step-b"],
        concurrency: 2,
        timeout: "30m",
      },
    };

    store.emit(event);

    expect(store.state.workflowId).toBe("wf-1");
    expect(store.state.name).toBe("test-workflow");
    expect(store.state.workspaceDir).toBe("/tmp/ws");
    expect(store.state.supervised).toBe(true);
    expect(store.state.startedAt).toBe(1000);
    expect(store.state.status).toBe("RUNNING");
    expect(store.state.steps.size).toBe(2);
    expect(store.state.stepOrder).toEqual(["step-a", "step-b"]);
    expect(store.state.steps.get("step-a")?.status).toBe("PENDING");
    expect(store.state.steps.get("step-b")?.status).toBe("PENDING");
  });

  test("handles workflow_finished event", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "workflow_started",
      workflowId: "wf-1",
      name: "test",
      workspaceDir: "/tmp",
      supervised: false,
      startedAt: 1000,
    });
    store.emit({
      type: "workflow_finished",
      status: WorkflowStatus.SUCCEEDED,
      completedAt: 2000,
    });

    expect(store.state.status).toBe(WorkflowStatus.SUCCEEDED);
    expect(store.state.finishedAt).toBe(2000);
  });

  test("handles step_state event (create + update)", () => {
    const store = new TuiStateStore();

    // First event creates the step
    store.emit({
      type: "step_state",
      stepId: "s1",
      status: StepStatus.RUNNING,
      iteration: 1,
      maxIterations: 3,
      startedAt: 1000,
    });

    const step = store.state.steps.get("s1")!;
    expect(step.status).toBe("RUNNING");
    expect(step.iteration).toBe(1);
    expect(step.maxIterations).toBe(3);
    expect(step.startedAt).toBe(1000);

    // Second event updates it
    store.emit({
      type: "step_state",
      stepId: "s1",
      status: StepStatus.SUCCEEDED,
      iteration: 2,
      maxIterations: 3,
      completedAt: 2000,
    });

    expect(step.status).toBe("SUCCEEDED");
    expect(step.iteration).toBe(2);
    expect(step.completedAt).toBe(2000);
    // startedAt should still be set from before
    expect(step.startedAt).toBe(1000);
  });

  test("handles step_phase event", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "step_phase",
      stepId: "s1",
      phase: "executing",
      at: 1000,
    });

    const step = store.state.steps.get("s1")!;
    expect(step.phase).toBe("executing");
  });

  test("handles worker_event stdout", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1000,
      event: { type: "stdout", data: "hello world" },
    });

    const step = store.state.steps.get("s1")!;
    expect(step.logs.stdout.lines()).toEqual(["hello world"]);
  });

  test("handles worker_event stderr", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1000,
      event: { type: "stderr", data: "error msg" },
    });

    const step = store.state.steps.get("s1")!;
    expect(step.logs.stderr.lines()).toEqual(["error msg"]);
  });

  test("handles worker_event progress", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1500,
      event: { type: "progress", message: "50% done", percent: 50 },
    });

    const step = store.state.steps.get("s1")!;
    expect(step.logs.progress.lines()).toEqual(["50% done"]);
    expect(step.progress).toEqual({
      ts: 1500,
      message: "50% done",
      percent: 50,
    });
  });

  test("handles worker_event patch", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1000,
      event: { type: "patch", filePath: "src/foo.ts", diff: "+line1" },
    });

    const step = store.state.steps.get("s1")!;
    expect(step.patches.order.length).toBe(1);
    const patchId = step.patches.order[0]!;
    const entry = step.patches.byId.get(patchId)!;
    expect(entry.stepId).toBe("s1");
    expect(entry.filePath).toBe("src/foo.ts");
    expect(entry.diff).toBe("+line1");
    expect(step.patches.byFilePath.get("src/foo.ts")).toEqual([patchId]);
  });

  test("handles worker_result event", () => {
    const store = new TuiStateStore();
    const result = {
      status: WorkerStatus.SUCCEEDED,
      artifacts: [],
      observations: [],
      cost: { wallTimeMs: 500 },
      durationMs: 500,
    };
    store.emit({
      type: "worker_result",
      stepId: "s1",
      ts: 2000,
      result,
    });

    const step = store.state.steps.get("s1")!;
    expect(step.result).toBe(result);
  });

  test("handles core_log event", () => {
    const store = new TuiStateStore();
    store.emit({ type: "core_log", ts: 1000, line: "core started" });
    store.emit({ type: "core_log", ts: 1001, line: "permit issued" });

    expect(store.state.coreLogs.lines()).toEqual([
      "core started",
      "permit issued",
    ]);
  });

  test("handles warning event", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "warning",
      ts: 1000,
      message: "high latency detected",
    });

    expect(store.state.warnings.lines()).toEqual(["high latency detected"]);
  });

  test("sets dirty flag on emit", () => {
    const store = new TuiStateStore();
    expect(store.dirty).toBe(false);

    store.emit({ type: "core_log", ts: 1000, line: "test" });
    expect(store.dirty).toBe(true);

    // Consumer resets dirty
    store.dirty = false;
    expect(store.dirty).toBe(false);

    store.emit({ type: "warning", ts: 1001, message: "warn" });
    expect(store.dirty).toBe(true);
  });

  test("creates placeholder step for unknown stepId", () => {
    const store = new TuiStateStore();
    const step = store.getOrCreateStep("unknown-step");

    expect(step.stepId).toBe("unknown-step");
    expect(step.status).toBe("PENDING");
    expect(step.iteration).toBe(0);
    expect(step.maxIterations).toBe(1);
    expect(store.state.stepOrder).toContain("unknown-step");
  });

  test("patch index tracks byId, order, byFilePath correctly", () => {
    const store = new TuiStateStore();

    // Two patches to same file
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1000,
      event: { type: "patch", filePath: "src/a.ts", diff: "+first" },
    });
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1001,
      event: { type: "patch", filePath: "src/a.ts", diff: "+second" },
    });

    // One patch to a different file
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1002,
      event: { type: "patch", filePath: "src/b.ts", diff: "+other" },
    });

    const step = store.state.steps.get("s1")!;
    expect(step.patches.order.length).toBe(3);
    expect(step.patches.byId.size).toBe(3);

    // byFilePath should group correctly
    const aPatches = step.patches.byFilePath.get("src/a.ts")!;
    expect(aPatches.length).toBe(2);
    const bPatches = step.patches.byFilePath.get("src/b.ts")!;
    expect(bPatches.length).toBe(1);

    // Verify ordering matches insertion
    expect(step.patches.order[0]).toBe(aPatches[0]!);
    expect(step.patches.order[1]).toBe(aPatches[1]!);
    expect(step.patches.order[2]).toBe(bPatches[0]!);

    // Verify entries have correct data
    const firstEntry = step.patches.byId.get(aPatches[0]!)!;
    expect(firstEntry.diff).toBe("+first");
    const secondEntry = step.patches.byId.get(aPatches[1]!)!;
    expect(secondEntry.diff).toBe("+second");
  });

  test("accepts supervised option in constructor", () => {
    const store = new TuiStateStore({ supervised: true });
    expect(store.state.supervised).toBe(true);
  });
});
