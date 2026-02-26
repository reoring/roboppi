/**
 * Unit tests: SentinelController
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SentinelController,
  SENTINEL_ABORT_REASON,
} from "../../src/workflow/sentinel/sentinel-controller.js";
import type { ExecEvent, ExecEventSink } from "../../src/tui/exec-event.js";
import type { SentinelConfig, StallPolicy } from "../../src/workflow/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSink(): ExecEventSink & { events: ExecEvent[] } {
  const events: ExecEvent[] = [];
  return {
    events,
    emit(event: ExecEvent) {
      events.push(event);
    },
  };
}

function makeConfig(overrides?: Partial<SentinelConfig>): SentinelConfig {
  return { enabled: true, ...overrides };
}

function makePolicy(overrides?: Partial<StallPolicy>): StallPolicy {
  return { enabled: true, ...overrides };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

let tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sentinel-ctrl-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs = [];
});

describe("SentinelController", () => {
  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe("constructor", () => {
    test("initializes without error", async () => {
      const contextDir = await createTempDir();
      const sink = makeSink();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        sink,
        "wf-1",
        "test-workflow",
      );
      expect(ctrl).toBeDefined();
    });

    test("accepts optional workspaceDir", async () => {
      const contextDir = await createTempDir();
      const sink = makeSink();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        sink,
        "wf-1",
        "test-workflow",
        "/tmp/workspace",
      );
      expect(ctrl).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // guardStep / guardCheck
  // -------------------------------------------------------------------------

  describe("guardStep()", () => {
    test("returns a SentinelGuard with stop() and getLastTrigger()", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      const guard = ctrl.guardStep("step-1", 1, makePolicy(), ac);

      expect(typeof guard.stop).toBe("function");
      expect(typeof guard.getLastTrigger).toBe("function");
      guard.stop();
    });

    test("creates guard for executing phase", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      // Should not throw — executing phase
      const guard = ctrl.guardStep("step-1", 1, makePolicy(), ac);
      guard.stop();
    });
  });

  describe("guardCheck()", () => {
    test("returns a SentinelGuard for checking phase", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      const guard = ctrl.guardCheck("step-1", 1, makePolicy(), ac);

      expect(typeof guard.stop).toBe("function");
      expect(typeof guard.getLastTrigger).toBe("function");
      guard.stop();
    });
  });

  // -------------------------------------------------------------------------
  // guard.stop()
  // -------------------------------------------------------------------------

  describe("guard.stop()", () => {
    test("stops watchers and cleans up", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      const policy = makePolicy({ no_output_timeout: "5s" });
      const guard = ctrl.guardStep("step-1", 1, policy, ac);

      // Stopping should not throw
      guard.stop();

      // After stop, the abort should NOT fire even after waiting
      await Bun.sleep(50);
      expect(ac.signal.aborted).toBe(false);
    });

    test("can be called multiple times without error", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      const guard = ctrl.guardStep("step-1", 1, makePolicy({ no_output_timeout: "5s" }), ac);

      guard.stop();
      guard.stop(); // Should not throw
    });
  });

  // -------------------------------------------------------------------------
  // onEvent()
  // -------------------------------------------------------------------------

  describe("onEvent()", () => {
    test("propagates worker_event to activity tracker (resets stall timer)", async () => {
      const contextDir = await createTempDir();
      const sink = makeSink();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        sink,
        "wf-1",
        "test-workflow",
      );

      const ac = new AbortController();
      const policy = makePolicy({ no_output_timeout: "150ms" });
      const guard = ctrl.guardStep("step-1", 1, policy, ac);

      // Keep feeding events to prevent stall from firing
      const keepAlive = setInterval(() => {
        ctrl.onEvent({
          type: "worker_event",
          stepId: "step-1",
          ts: Date.now(),
          event: { type: "stdout", data: "alive" },
        } as ExecEvent);
      }, 50);

      // Wait longer than the timeout — should NOT abort because events keep coming
      await Bun.sleep(300);
      clearInterval(keepAlive);

      expect(ac.signal.aborted).toBe(false);
      guard.stop();
    });
  });

  // -------------------------------------------------------------------------
  // stopAll()
  // -------------------------------------------------------------------------

  describe("stopAll()", () => {
    test("stops all active guards", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );

      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const policy = makePolicy({ no_output_timeout: "5s" });

      ctrl.guardStep("step-1", 1, policy, ac1);
      ctrl.guardStep("step-2", 1, policy, ac2);

      ctrl.stopAll();

      // After stopAll, watchers should not fire
      await Bun.sleep(50);
      expect(ac1.signal.aborted).toBe(false);
      expect(ac2.signal.aborted).toBe(false);
    });

    test("can be called when no guards are active", () => {
      const ctrl = new SentinelController(
        makeConfig(),
        "/tmp/nonexistent",
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      // Should not throw
      ctrl.stopAll();
    });
  });

  // -------------------------------------------------------------------------
  // getLastTrigger()
  // -------------------------------------------------------------------------

  describe("getLastTrigger()", () => {
    test("returns null initially", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      const guard = ctrl.guardStep("step-1", 1, makePolicy(), ac);

      expect(guard.getLastTrigger()).toBeNull();
      guard.stop();
    });

    test("returns trigger result after stall fires", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      const policy = makePolicy({ no_output_timeout: "100ms" });
      const guard = ctrl.guardStep("step-1", 1, policy, ac);

      // Wait for the stall to fire
      await Bun.sleep(300);

      const trigger = guard.getLastTrigger();
      expect(trigger).not.toBeNull();
      expect(trigger!.kind).toBe("no_output");
      expect(trigger!.fingerprints).toContain("stall/no-output");
      expect(ac.signal.aborted).toBe(true);
      guard.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Guard key uniqueness
  // -------------------------------------------------------------------------

  describe("guard key uniqueness", () => {
    test("same stepId with different phase creates separate guards", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );

      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const policy = makePolicy({ no_output_timeout: "5s" });

      const guardExec = ctrl.guardStep("step-1", 1, policy, ac1);
      const guardCheck = ctrl.guardCheck("step-1", 1, policy, ac2);

      // Both guards should be active (no overwrite)
      // Stopping one should not affect the other
      guardExec.stop();
      await Bun.sleep(50);
      expect(ac2.signal.aborted).toBe(false);

      guardCheck.stop();
    });

    test("same stepId and phase with different iteration creates separate guards", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );

      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const policy = makePolicy({ no_output_timeout: "5s" });

      const guard1 = ctrl.guardStep("step-1", 1, policy, ac1);
      const guard2 = ctrl.guardStep("step-1", 2, policy, ac2);

      guard1.stop();
      await Bun.sleep(50);
      // Second guard should still be active
      expect(ac2.signal.aborted).toBe(false);

      guard2.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Watcher creation based on policy
  // -------------------------------------------------------------------------

  describe("watcher creation", () => {
    test("NoOutputWatcher is created when no_output_timeout is set", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      const policy = makePolicy({ no_output_timeout: "100ms" });
      const guard = ctrl.guardStep("step-1", 1, policy, ac);

      // The NoOutputWatcher should fire and abort
      await Bun.sleep(300);

      expect(ac.signal.aborted).toBe(true);
      expect(ac.signal.reason).toBe(SENTINEL_ABORT_REASON);
      guard.stop();
    });

    test("NoProgressWatcher is created when probe is set", async () => {
      const contextDir = await createTempDir();
      const sink = makeSink();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        sink,
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      const policy = makePolicy({
        probe: {
          command: 'echo \'{"class":"stalled"}\'',
          interval: "50ms",
          stall_threshold: 2,
          timeout: "1s",
        },
      });
      const guard = ctrl.guardStep("step-1", 1, policy, ac);

      // Wait for probe to run twice with same digest → stall
      await Bun.sleep(500);

      expect(ac.signal.aborted).toBe(true);
      const trigger = guard.getLastTrigger();
      expect(trigger).not.toBeNull();
      expect(trigger!.kind).toBe("no_progress");
      guard.stop();
    });

    test("activity_source=probe_only skips NoOutputWatcher", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      const policy = makePolicy({
        no_output_timeout: "100ms",
        activity_source: "probe_only",
      });
      const guard = ctrl.guardStep("step-1", 1, policy, ac);

      // Wait well past the no_output_timeout — should NOT abort because
      // probe_only disables the NoOutputWatcher
      await Bun.sleep(300);

      expect(ac.signal.aborted).toBe(false);
      guard.stop();
    });

    test("no watchers created when policy has neither timeout nor probe", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      const policy = makePolicy(); // No timeout, no probe
      const guard = ctrl.guardStep("step-1", 1, policy, ac);

      await Bun.sleep(100);
      expect(ac.signal.aborted).toBe(false);
      guard.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Workflow defaults (sentinel.defaults)
  // -------------------------------------------------------------------------

  describe("workflow defaults", () => {
    test("defaults.no_output_timeout applies when step policy omits it", async () => {
      const contextDir = await createTempDir();
      const config = makeConfig({
        defaults: { no_output_timeout: "100ms" },
      });
      const ctrl = new SentinelController(
        config,
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      // Step policy has no no_output_timeout — should inherit from defaults
      const policy = makePolicy();
      const guard = ctrl.guardStep("step-1", 1, policy, ac);

      await Bun.sleep(300);

      expect(ac.signal.aborted).toBe(true);
      expect(guard.getLastTrigger()?.kind).toBe("no_output");
      guard.stop();
    });

    test("step-level no_output_timeout overrides workflow default", async () => {
      const contextDir = await createTempDir();
      const config = makeConfig({
        defaults: { no_output_timeout: "10s" }, // Long default — would not fire
      });
      const ctrl = new SentinelController(
        config,
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      // Step policy overrides with a short timeout
      const policy = makePolicy({ no_output_timeout: "100ms" });
      const guard = ctrl.guardStep("step-1", 1, policy, ac);

      await Bun.sleep(300);

      expect(ac.signal.aborted).toBe(true);
      guard.stop();
    });

    test("defaults.activity_source=probe_only suppresses NoOutputWatcher", async () => {
      const contextDir = await createTempDir();
      const config = makeConfig({
        defaults: {
          no_output_timeout: "100ms",
          activity_source: "probe_only",
        },
      });
      const ctrl = new SentinelController(
        config,
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      // Step policy doesn't set activity_source — inherits probe_only from defaults
      const policy = makePolicy();
      const guard = ctrl.guardStep("step-1", 1, policy, ac);

      await Bun.sleep(300);

      expect(ac.signal.aborted).toBe(false);
      guard.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Abort reason tagging
  // -------------------------------------------------------------------------

  describe("abort reason", () => {
    test("sentinel abort uses SENTINEL_ABORT_REASON tag", async () => {
      const contextDir = await createTempDir();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        makeSink(),
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      const policy = makePolicy({ no_output_timeout: "100ms" });
      const guard = ctrl.guardStep("step-1", 1, policy, ac);

      await Bun.sleep(300);

      expect(ac.signal.aborted).toBe(true);
      expect(ac.signal.reason).toBe(SENTINEL_ABORT_REASON);
      guard.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Sink events
  // -------------------------------------------------------------------------

  describe("sink events", () => {
    test("emits warning event when stall fires", async () => {
      const contextDir = await createTempDir();
      const sink = makeSink();
      const ctrl = new SentinelController(
        makeConfig(),
        contextDir,
        sink,
        "wf-1",
        "test-workflow",
      );
      const ac = new AbortController();
      const policy = makePolicy({ no_output_timeout: "100ms" });
      const guard = ctrl.guardStep("step-1", 1, policy, ac);

      await Bun.sleep(300);

      const warnings = sink.events.filter((e) => e.type === "warning");
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      const stallWarning = warnings.find(
        (e) => e.type === "warning" && e.message.includes("[sentinel]"),
      );
      expect(stallWarning).toBeDefined();
      guard.stop();
    });
  });
});
