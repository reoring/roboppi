/**
 * Unit tests: TelemetrySink
 */
import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TelemetrySink } from "../../src/workflow/sentinel/telemetry-sink.js";
import type { ExecEventSink, ExecEvent } from "../../src/tui/exec-event.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "sink-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Wait for async fire-and-forget writes to settle */
function settle(ms = 200): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("TelemetrySink", () => {
  test("events forwarded to inner sink", async () => {
    await withTempDir(async (dir) => {
      const collected: ExecEvent[] = [];
      const inner: ExecEventSink = { emit: (ev) => collected.push(ev) };

      const sink = new TelemetrySink(inner, dir, {
        eventsFile: "events.jsonl",
        stateFile: "state.json",
        includeWorkerOutput: false,
      });

      const event: ExecEvent = {
        type: "workflow_started",
        workflowId: "wf-1",
        name: "test",
        workspaceDir: "/tmp/test",
        supervised: false,
        startedAt: 1000,
      };

      sink.emit(event);

      expect(collected).toHaveLength(1);
      expect(collected[0]!.type).toBe("workflow_started");
    });
  });

  test("worker_event redacted (no content when includeWorkerOutput=false)", async () => {
    await withTempDir(async (dir) => {
      const inner: ExecEventSink = { emit: () => {} };
      const sink = new TelemetrySink(inner, dir, {
        eventsFile: "events.jsonl",
        stateFile: "state.json",
        includeWorkerOutput: false,
      });

      const event: ExecEvent = {
        type: "worker_event",
        stepId: "step-1",
        ts: 2000,
        event: { type: "stdout", data: "secret output data" },
      };

      sink.emit(event);
      await settle();

      const content = await readFile(path.join(dir, "events.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      const parsed = JSON.parse(lines[0]!);

      expect(parsed.type).toBe("worker_event");
      expect(parsed.eventKind).toBe("stdout");
      expect(parsed.byteLength).toBe("secret output data".length);
      // Content should NOT be included
      expect(parsed.event).toBeUndefined();
    });
  });

  test("worker_event includes content when includeWorkerOutput=true", async () => {
    await withTempDir(async (dir) => {
      const inner: ExecEventSink = { emit: () => {} };
      const sink = new TelemetrySink(inner, dir, {
        eventsFile: "events.jsonl",
        stateFile: "state.json",
        includeWorkerOutput: true,
      });

      const event: ExecEvent = {
        type: "worker_event",
        stepId: "step-1",
        ts: 2000,
        event: { type: "stdout", data: "visible output" },
      };

      sink.emit(event);
      await settle();

      const content = await readFile(path.join(dir, "events.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      const parsed = JSON.parse(lines[0]!);

      expect(parsed.type).toBe("worker_event");
      expect(parsed.event).toBeDefined();
      expect(parsed.event.type).toBe("stdout");
      expect(parsed.event.data).toBe("visible output");
    });
  });

  test("events.jsonl written in JSONL format", async () => {
    await withTempDir(async (dir) => {
      const inner: ExecEventSink = { emit: () => {} };
      const sink = new TelemetrySink(inner, dir, {
        eventsFile: "events.jsonl",
        stateFile: "state.json",
        includeWorkerOutput: false,
      });

      // Emit events sequentially with settle between each to avoid race
      sink.emit({
        type: "workflow_started",
        workflowId: "wf-1",
        name: "test",
        workspaceDir: "/tmp/test",
        supervised: false,
        startedAt: 1000,
      });
      await settle();

      sink.emit({
        type: "step_state",
        stepId: "step-1",
        status: "RUNNING" as any,
        iteration: 1,
        maxIterations: 5,
        startedAt: 1100,
      });
      await settle();

      sink.emit({
        type: "workflow_finished",
        status: "SUCCEEDED" as any,
        completedAt: 2000,
      });
      await settle();

      const content = await readFile(path.join(dir, "events.jsonl"), "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBe(3);

      // Each line should be valid JSON
      const event1 = JSON.parse(lines[0]!);
      const event2 = JSON.parse(lines[1]!);
      const event3 = JSON.parse(lines[2]!);

      expect(event1.type).toBe("workflow_started");
      expect(event2.type).toBe("step_state");
      expect(event3.type).toBe("workflow_finished");
    });
  });

  test("state.json updated with workflow state", async () => {
    await withTempDir(async (dir) => {
      const inner: ExecEventSink = { emit: () => {} };
      const sink = new TelemetrySink(inner, dir, {
        eventsFile: "events.jsonl",
        stateFile: "state.json",
        includeWorkerOutput: false,
      });

      sink.emit({
        type: "workflow_started",
        workflowId: "wf-1",
        name: "test-wf",
        workspaceDir: "/tmp/test",
        supervised: false,
        startedAt: 1000,
      });
      await settle();

      sink.emit({
        type: "step_state",
        stepId: "step-1",
        status: "RUNNING" as any,
        iteration: 1,
        maxIterations: 5,
        startedAt: 1100,
      });
      await settle();

      await sink.flush();
      const stateContent = await readFile(path.join(dir, "state.json"), "utf-8");
      const state = JSON.parse(stateContent);

      expect(state.workflowId).toBe("wf-1");
      expect(state.name).toBe("test-wf");
      expect(state.status).toBe("RUNNING");
      expect(state.steps["step-1"]).toBeDefined();
      expect(state.steps["step-1"].status).toBe("RUNNING");
      expect(state.steps["step-1"].iteration).toBe(1);
    });
  });
});
