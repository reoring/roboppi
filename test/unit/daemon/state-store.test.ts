import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonStateStore, defaultTriggerState } from "../../../src/daemon/state-store.js";
import type { DaemonState, ExecutionRecord, TriggerState } from "../../../src/daemon/types.js";
import { WorkflowStatus, StepStatus } from "../../../src/workflow/types.js";
import type { WorkflowState } from "../../../src/workflow/types.js";

function makeWorkflowState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    workflowId: "wf-1",
    name: "test-workflow",
    status: WorkflowStatus.SUCCEEDED,
    steps: {
      step1: {
        status: StepStatus.SUCCEEDED,
        iteration: 1,
        maxIterations: 3,
        startedAt: 1000,
        completedAt: 2000,
      },
    },
    startedAt: 1000,
    completedAt: 2000,
    ...overrides,
  };
}

function makeExecutionRecord(
  triggerId: string,
  completedAt: number,
): ExecutionRecord {
  return {
    triggerId,
    event: {
      sourceId: "cron-1",
      timestamp: completedAt - 1000,
      payload: { type: "cron", schedule: "* * * * *", firedAt: completedAt - 1000 },
    },
    workflowResult: makeWorkflowState(),
    startedAt: completedAt - 1000,
    completedAt,
  };
}

describe("DaemonStateStore", () => {
  let stateDir: string;
  let store: DaemonStateStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "daemon-state-"));
    store = new DaemonStateStore(stateDir);
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Daemon state
  // -------------------------------------------------------------------------

  describe("getDaemonState / saveDaemonState", () => {
    it("returns null when no state exists", async () => {
      const state = await store.getDaemonState();
      expect(state).toBeNull();
    });

    it("saves and loads daemon state", async () => {
      const ds: DaemonState = {
        pid: 12345,
        startedAt: Date.now(),
        configName: "my-daemon",
        status: "running",
      };
      await store.saveDaemonState(ds);
      const loaded = await store.getDaemonState();
      expect(loaded).toEqual(ds);
    });
  });

  // -------------------------------------------------------------------------
  // Trigger state
  // -------------------------------------------------------------------------

  describe("getTriggerState / saveTriggerState", () => {
    it("returns default state for unknown trigger", async () => {
      const state = await store.getTriggerState("unknown-trigger");
      expect(state).toEqual(defaultTriggerState());
    });

    it("saves and loads trigger state", async () => {
      const ts: TriggerState = {
        enabled: true,
        lastFiredAt: 100000,
        cooldownUntil: 200000,
        executionCount: 5,
        consecutiveFailures: 1,
      };
      await store.saveTriggerState("t1", ts);
      const loaded = await store.getTriggerState("t1");
      expect(loaded).toEqual(ts);
    });

    it("handles multiple triggers independently", async () => {
      const ts1: TriggerState = { ...defaultTriggerState(), executionCount: 1 };
      const ts2: TriggerState = { ...defaultTriggerState(), executionCount: 2 };
      await store.saveTriggerState("t1", ts1);
      await store.saveTriggerState("t2", ts2);
      expect(await store.getTriggerState("t1")).toEqual(ts1);
      expect(await store.getTriggerState("t2")).toEqual(ts2);
    });
  });

  // -------------------------------------------------------------------------
  // Last result
  // -------------------------------------------------------------------------

  describe("getLastResult / saveLastResult", () => {
    it("returns null when no result exists", async () => {
      const result = await store.getLastResult("t1");
      expect(result).toBeNull();
    });

    it("saves and loads last result", async () => {
      const wfState = makeWorkflowState();
      await store.saveLastResult("t1", wfState);
      const loaded = await store.getLastResult("t1");
      expect(loaded).toEqual(wfState);
    });
  });

  // -------------------------------------------------------------------------
  // Execution history
  // -------------------------------------------------------------------------

  describe("recordExecution / getHistory", () => {
    it("returns empty array when no history exists", async () => {
      const history = await store.getHistory("t1", 10);
      expect(history).toEqual([]);
    });

    it("records and retrieves execution history", async () => {
      const record = makeExecutionRecord("t1", 5000);
      await store.recordExecution(record);
      const history = await store.getHistory("t1", 10);
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual(record);
    });

    it("returns latest N records sorted newest first", async () => {
      const r1 = makeExecutionRecord("t1", 1000);
      const r2 = makeExecutionRecord("t1", 2000);
      const r3 = makeExecutionRecord("t1", 3000);
      await store.recordExecution(r1);
      await store.recordExecution(r2);
      await store.recordExecution(r3);

      const history = await store.getHistory("t1", 2);
      expect(history).toHaveLength(2);
      expect(history[0]!.completedAt).toBe(3000);
      expect(history[1]!.completedAt).toBe(2000);
    });

    it("keeps history per trigger isolated", async () => {
      await store.recordExecution(makeExecutionRecord("t1", 1000));
      await store.recordExecution(makeExecutionRecord("t2", 2000));

      expect(await store.getHistory("t1", 10)).toHaveLength(1);
      expect(await store.getHistory("t2", 10)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe("edge cases", () => {
    it("works with a non-existent state_dir (creates it)", async () => {
      const newDir = join(stateDir, "deeply", "nested", "state");
      const newStore = new DaemonStateStore(newDir);
      const ds: DaemonState = {
        pid: 1,
        startedAt: 0,
        configName: "test",
        status: "running",
      };
      await newStore.saveDaemonState(ds);
      const loaded = await newStore.getDaemonState();
      expect(loaded).toEqual(ds);
    });
  });
});
