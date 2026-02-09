import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TriggerEngine, WorkflowQueuedError } from "../../../src/daemon/trigger-engine.js";
import { DaemonStateStore } from "../../../src/daemon/state-store.js";
import type {
  DaemonConfig,
  DaemonEvent,
  TriggerDef,
} from "../../../src/daemon/types.js";
import { WorkflowStatus } from "../../../src/workflow/types.js";
import type { WorkflowState } from "../../../src/workflow/types.js";

function makeConfig(triggers: Record<string, TriggerDef>): DaemonConfig {
  return {
    name: "test-daemon",
    version: "1",
    workspace: "/tmp/workspace",
    events: {
      "cron-1": { type: "cron", schedule: "* * * * *" },
      "webhook-1": { type: "webhook", path: "/hook", port: 3000 },
    },
    triggers,
  };
}

function makeEvent(
  sourceId: string,
  timestamp: number,
): DaemonEvent {
  return {
    sourceId,
    timestamp,
    payload: {
      type: "cron",
      schedule: "* * * * *",
      firedAt: timestamp,
    },
  };
}

function makeWebhookEvent(
  sourceId: string,
  timestamp: number,
  body: unknown,
): DaemonEvent {
  return {
    sourceId,
    timestamp,
    payload: {
      type: "webhook",
      method: "POST",
      path: "/hook",
      headers: {},
      body,
    },
  };
}

function makeSuccessResult(): WorkflowState {
  return {
    workflowId: "wf-1",
    name: "test-workflow",
    status: WorkflowStatus.SUCCEEDED,
    steps: {},
    startedAt: Date.now(),
    completedAt: Date.now(),
  };
}

function makeFailedResult(): WorkflowState {
  return {
    workflowId: "wf-1",
    name: "test-workflow",
    status: WorkflowStatus.FAILED,
    steps: {},
    startedAt: Date.now(),
    completedAt: Date.now(),
  };
}

describe("TriggerEngine", () => {
  let stateDir: string;
  let store: DaemonStateStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "trigger-engine-"));
    store = new DaemonStateStore(stateDir);
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Basic event matching
  // -------------------------------------------------------------------------

  describe("event matching", () => {
    it("returns empty when no triggers match the event source", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml" },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(makeEvent("unknown-source", Date.now()));
      expect(actions).toHaveLength(0);
    });

    it("executes a trigger when event source matches", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml" },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(makeEvent("cron-1", Date.now()));
      expect(actions).toHaveLength(1);
      expect(actions[0]!.action).toBe("executed");
    });

    it("matches multiple triggers for the same event", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf1.yaml" },
        t2: { on: "cron-1", workflow: "wf2.yaml" },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(makeEvent("cron-1", Date.now()));
      expect(actions).toHaveLength(2);
      expect(actions[0]!.action).toBe("executed");
      expect(actions[1]!.action).toBe("executed");
    });
  });

  // -------------------------------------------------------------------------
  // Disabled triggers
  // -------------------------------------------------------------------------

  describe("disabled triggers", () => {
    it("skips trigger when enabled is false in definition", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml", enabled: false },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(makeEvent("cron-1", Date.now()));
      expect(actions).toHaveLength(1);
      expect(actions[0]!.action).toBe("disabled");
    });

    it("skips trigger when disabled in state", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml" },
      });
      await store.saveTriggerState("t1", {
        enabled: false,
        lastFiredAt: null,
        cooldownUntil: null,
        executionCount: 0,
        consecutiveFailures: 0,
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(makeEvent("cron-1", Date.now()));
      expect(actions).toHaveLength(1);
      expect(actions[0]!.action).toBe("disabled");
    });
  });

  // -------------------------------------------------------------------------
  // Filter matching
  // -------------------------------------------------------------------------

  describe("filter matching", () => {
    it("filters by string equality on payload field", async () => {
      const config = makeConfig({
        t1: {
          on: "webhook-1",
          workflow: "wf.yaml",
          filter: { "payload.type": "webhook" },
        },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(
        makeWebhookEvent("webhook-1", Date.now(), { action: "opened" }),
      );
      expect(actions).toHaveLength(1);
      expect(actions[0]!.action).toBe("executed");
    });

    it("rejects when filter does not match", async () => {
      const config = makeConfig({
        t1: {
          on: "webhook-1",
          workflow: "wf.yaml",
          filter: { "payload.type": "cron" },
        },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(
        makeWebhookEvent("webhook-1", Date.now(), {}),
      );
      expect(actions).toHaveLength(1);
      expect(actions[0]!.action).toBe("filtered");
    });

    it("supports pattern regex filter", async () => {
      const config = makeConfig({
        t1: {
          on: "webhook-1",
          workflow: "wf.yaml",
          filter: { "payload.body.branch": { pattern: "^main$|^develop$" } },
        },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());

      const matchActions = await engine.handleEvent(
        makeWebhookEvent("webhook-1", Date.now(), { branch: "main" }),
      );
      expect(matchActions[0]!.action).toBe("executed");

      const noMatchActions = await engine.handleEvent(
        makeWebhookEvent("webhook-1", Date.now(), { branch: "feature/foo" }),
      );
      expect(noMatchActions[0]!.action).toBe("filtered");
    });

    it("supports in-list filter", async () => {
      const config = makeConfig({
        t1: {
          on: "webhook-1",
          workflow: "wf.yaml",
          filter: { "payload.body.action": { in: ["opened", "synchronize"] } },
        },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());

      const matchActions = await engine.handleEvent(
        makeWebhookEvent("webhook-1", Date.now(), { action: "opened" }),
      );
      expect(matchActions[0]!.action).toBe("executed");

      const noMatchActions = await engine.handleEvent(
        makeWebhookEvent("webhook-1", Date.now(), { action: "closed" }),
      );
      expect(noMatchActions[0]!.action).toBe("filtered");
    });

    it("supports nested dot-notation for webhook body", async () => {
      const config = makeConfig({
        t1: {
          on: "webhook-1",
          workflow: "wf.yaml",
          filter: { "payload.body.pull_request.base.ref": "main" },
        },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(
        makeWebhookEvent("webhook-1", Date.now(), {
          pull_request: { base: { ref: "main" } },
        }),
      );
      expect(actions[0]!.action).toBe("executed");
    });
  });

  // -------------------------------------------------------------------------
  // Debounce
  // -------------------------------------------------------------------------

  describe("debounce", () => {
    it("allows first event (no lastFiredAt)", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml", debounce: "10s" },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(makeEvent("cron-1", Date.now()));
      expect(actions[0]!.action).toBe("executed");
    });

    it("debounces event within window", async () => {
      const now = Date.now();
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml", debounce: "10s" },
      });
      // Simulate a previous fire
      await store.saveTriggerState("t1", {
        enabled: true,
        lastFiredAt: now - 5000, // 5s ago
        cooldownUntil: null,
        executionCount: 1,
        consecutiveFailures: 0,
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(makeEvent("cron-1", now));
      expect(actions[0]!.action).toBe("debounced");
    });

    it("allows event after debounce window expires", async () => {
      const now = Date.now();
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml", debounce: "10s" },
      });
      await store.saveTriggerState("t1", {
        enabled: true,
        lastFiredAt: now - 15000, // 15s ago
        cooldownUntil: null,
        executionCount: 1,
        consecutiveFailures: 0,
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(makeEvent("cron-1", now));
      expect(actions[0]!.action).toBe("executed");
    });
  });

  // -------------------------------------------------------------------------
  // Cooldown
  // -------------------------------------------------------------------------

  describe("cooldown", () => {
    it("blocks execution during cooldown period", async () => {
      const now = Date.now();
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml", cooldown: "30s" },
      });
      await store.saveTriggerState("t1", {
        enabled: true,
        lastFiredAt: now - 10000,
        cooldownUntil: now + 20000, // cooldown active for 20 more seconds
        executionCount: 1,
        consecutiveFailures: 0,
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(makeEvent("cron-1", now));
      expect(actions[0]!.action).toBe("cooldown");
    });

    it("sets cooldown after successful execution", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml", cooldown: "30s" },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      await engine.handleEvent(makeEvent("cron-1", Date.now()));
      const state = await store.getTriggerState("t1");
      expect(state.cooldownUntil).not.toBeNull();
      expect(state.cooldownUntil!).toBeGreaterThan(Date.now());
    });

    it("does not set cooldown on failed execution", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml", cooldown: "30s" },
      });
      const engine = new TriggerEngine(config, store, async () => makeFailedResult());
      await engine.handleEvent(makeEvent("cron-1", Date.now()));
      const state = await store.getTriggerState("t1");
      expect(state.cooldownUntil).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // State updates
  // -------------------------------------------------------------------------

  describe("state updates", () => {
    it("increments executionCount on each execution", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml" },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      await engine.handleEvent(makeEvent("cron-1", 1000));
      await engine.handleEvent(makeEvent("cron-1", 2000));
      const state = await store.getTriggerState("t1");
      expect(state.executionCount).toBe(2);
    });

    it("resets consecutiveFailures on success", async () => {
      await store.saveTriggerState("t1", {
        enabled: true,
        lastFiredAt: null,
        cooldownUntil: null,
        executionCount: 5,
        consecutiveFailures: 3,
      });
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml" },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      await engine.handleEvent(makeEvent("cron-1", Date.now()));
      const state = await store.getTriggerState("t1");
      expect(state.consecutiveFailures).toBe(0);
    });

    it("increments consecutiveFailures on failure", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml" },
      });
      const engine = new TriggerEngine(config, store, async () => makeFailedResult());
      await engine.handleEvent(makeEvent("cron-1", 1000));
      await engine.handleEvent(makeEvent("cron-1", 2000));
      const state = await store.getTriggerState("t1");
      expect(state.consecutiveFailures).toBe(2);
    });

    it("updates lastFiredAt with event timestamp", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml" },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      await engine.handleEvent(makeEvent("cron-1", 42000));
      const state = await store.getTriggerState("t1");
      expect(state.lastFiredAt).toBe(42000);
    });

    it("records execution history", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml" },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      await engine.handleEvent(makeEvent("cron-1", Date.now()));
      const history = await store.getHistory("t1", 10);
      expect(history).toHaveLength(1);
      expect(history[0]!.triggerId).toBe("t1");
    });

    it("saves last result", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml" },
      });
      const wfResult = makeSuccessResult();
      const engine = new TriggerEngine(config, store, async () => wfResult);
      await engine.handleEvent(makeEvent("cron-1", Date.now()));
      const lastResult = await store.getLastResult("t1");
      expect(lastResult).not.toBeNull();
      expect(lastResult!.status).toBe(WorkflowStatus.SUCCEEDED);
    });
  });

  // -------------------------------------------------------------------------
  // Failure handling
  // -------------------------------------------------------------------------

  describe("failure handling", () => {
    it("pauses trigger after max_retries consecutive failures", async () => {
      const config = makeConfig({
        t1: {
          on: "cron-1",
          workflow: "wf.yaml",
          on_workflow_failure: "pause_trigger",
          max_retries: 2,
        },
      });
      const engine = new TriggerEngine(config, store, async () => makeFailedResult());

      await engine.handleEvent(makeEvent("cron-1", 1000));
      let state = await store.getTriggerState("t1");
      expect(state.enabled).toBe(true);

      await engine.handleEvent(makeEvent("cron-1", 2000));
      state = await store.getTriggerState("t1");
      expect(state.enabled).toBe(false);
    });

    it("handles execution error as failed workflow", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml" },
      });
      const engine = new TriggerEngine(config, store, async () => {
        throw new Error("execution failed");
      });
      const actions = await engine.handleEvent(makeEvent("cron-1", Date.now()));
      expect(actions[0]!.action).toBe("executed");
      if (actions[0]!.action === "executed") {
        expect(actions[0]!.result.status).toBe(WorkflowStatus.FAILED);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Workflow queueing (WorkflowQueuedError)
  // -------------------------------------------------------------------------

  describe("workflow queueing", () => {
    it("returns queued action when onExecute throws WorkflowQueuedError", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml" },
      });
      const engine = new TriggerEngine(config, store, async () => {
        throw new WorkflowQueuedError();
      });
      const actions = await engine.handleEvent(makeEvent("cron-1", Date.now()));
      expect(actions).toHaveLength(1);
      expect(actions[0]!.action).toBe("queued");
      if (actions[0]!.action === "queued") {
        expect(actions[0]!.triggerId).toBe("t1");
      }
    });

    it("does not update trigger state when workflow is queued", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml" },
      });
      const engine = new TriggerEngine(config, store, async () => {
        throw new WorkflowQueuedError();
      });
      await engine.handleEvent(makeEvent("cron-1", 5000));
      const state = await store.getTriggerState("t1");
      // State should be at defaults (no updates applied)
      expect(state.executionCount).toBe(0);
      expect(state.lastFiredAt).toBeNull();
    });

    it("still treats non-queued errors as failed workflow", async () => {
      const config = makeConfig({
        t1: { on: "cron-1", workflow: "wf.yaml" },
      });
      const engine = new TriggerEngine(config, store, async () => {
        throw new Error("some other error");
      });
      const actions = await engine.handleEvent(makeEvent("cron-1", Date.now()));
      expect(actions).toHaveLength(1);
      expect(actions[0]!.action).toBe("executed");
      if (actions[0]!.action === "executed") {
        expect(actions[0]!.result.status).toBe(WorkflowStatus.FAILED);
      }
    });
  });

  // -------------------------------------------------------------------------
  // ReDoS protection
  // -------------------------------------------------------------------------

  describe("ReDoS protection", () => {
    it("rejects patterns exceeding max length", async () => {
      const longPattern = "a".repeat(1001);
      const config = makeConfig({
        t1: {
          on: "webhook-1",
          workflow: "wf.yaml",
          filter: { "payload.body.value": { pattern: longPattern } },
        },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(
        makeWebhookEvent("webhook-1", Date.now(), { value: "test" }),
      );
      expect(actions[0]!.action).toBe("filtered");
    });

    it("rejects nested quantifier patterns like (a+)+", async () => {
      const config = makeConfig({
        t1: {
          on: "webhook-1",
          workflow: "wf.yaml",
          filter: { "payload.body.value": { pattern: "(a+)+" } },
        },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(
        makeWebhookEvent("webhook-1", Date.now(), { value: "aaa" }),
      );
      expect(actions[0]!.action).toBe("filtered");
    });

    it("rejects overlapping alternation patterns like (a|a)*", async () => {
      const config = makeConfig({
        t1: {
          on: "webhook-1",
          workflow: "wf.yaml",
          filter: { "payload.body.value": { pattern: "(a|a)*" } },
        },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(
        makeWebhookEvent("webhook-1", Date.now(), { value: "aaa" }),
      );
      expect(actions[0]!.action).toBe("filtered");
    });

    it("rejects invalid regex patterns gracefully", async () => {
      const config = makeConfig({
        t1: {
          on: "webhook-1",
          workflow: "wf.yaml",
          filter: { "payload.body.value": { pattern: "[invalid" } },
        },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(
        makeWebhookEvent("webhook-1", Date.now(), { value: "test" }),
      );
      expect(actions[0]!.action).toBe("filtered");
    });

    it("rejects input strings exceeding max length", async () => {
      const config = makeConfig({
        t1: {
          on: "webhook-1",
          workflow: "wf.yaml",
          filter: { "payload.body.value": { pattern: "^test$" } },
        },
      });
      const longInput = "a".repeat(10001);
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(
        makeWebhookEvent("webhook-1", Date.now(), { value: longInput }),
      );
      expect(actions[0]!.action).toBe("filtered");
    });

    it("allows safe patterns within limits", async () => {
      const config = makeConfig({
        t1: {
          on: "webhook-1",
          workflow: "wf.yaml",
          filter: { "payload.body.branch": { pattern: "^main$|^develop$" } },
        },
      });
      const engine = new TriggerEngine(config, store, async () => makeSuccessResult());
      const actions = await engine.handleEvent(
        makeWebhookEvent("webhook-1", Date.now(), { branch: "main" }),
      );
      expect(actions[0]!.action).toBe("executed");
    });
  });
});
