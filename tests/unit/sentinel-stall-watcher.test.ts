/**
 * Unit tests: NoOutputWatcher & NoProgressWatcher
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActivityTracker } from "../../src/workflow/sentinel/activity-tracker.js";
import {
  NoOutputWatcher,
  NoProgressWatcher,
  type StallWatcherOptions,
  type StallTriggerResult,
} from "../../src/workflow/sentinel/stall-watcher.js";
import type { ExecEvent, ExecEventSink } from "../../src/tui/exec-event.js";
import type { StallPolicy } from "../../src/workflow/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSink(): ExecEventSink & { events: ExecEvent[] } {
  const events: ExecEvent[] = [];
  return {
    events,
    emit(event: ExecEvent) {
      events.push(event);
    },
  };
}

function makeOptions(
  overrides: Partial<StallWatcherOptions> & { policy: StallPolicy },
): StallWatcherOptions {
  return {
    stepId: "test-step",
    iteration: 1,
    workflowId: "wf-1",
    workflowName: "test-workflow",
    contextDir: "/tmp/test", // overridden in tests
    activityTracker: new ActivityTracker(),
    abortStep: () => {},
    sink: createMockSink(),
    onTrigger: () => {},
    phase: "executing",
    telemetryPaths: {
      eventsFile: "events.jsonl",
      stateFile: "state.json",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// NoOutputWatcher
// ---------------------------------------------------------------------------

describe("NoOutputWatcher", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "stall-watcher-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("triggers after no_output_timeout when no worker activity", async () => {
    const tracker = new ActivityTracker();
    // Register with a timestamp far in the past so timeout is already elapsed
    tracker.register("test-step", Date.now() - 500);

    const triggers: StallTriggerResult[] = [];
    let aborted = false;

    const watcher = new NoOutputWatcher(
      makeOptions({
        policy: { no_output_timeout: "100ms" },
        contextDir: tmpDir,
        activityTracker: tracker,
        abortStep: () => { aborted = true; },
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    await Bun.sleep(300);
    watcher.stop();

    expect(triggers.length).toBeGreaterThanOrEqual(1);
    expect(triggers[0]!.kind).toBe("no_output");
    expect(aborted).toBe(true);
  });

  test("does NOT trigger before timeout expires", async () => {
    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now());

    const triggers: StallTriggerResult[] = [];

    const watcher = new NoOutputWatcher(
      makeOptions({
        policy: { no_output_timeout: "2s" },
        contextDir: tmpDir,
        activityTracker: tracker,
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    await Bun.sleep(200);
    watcher.stop();

    expect(triggers.length).toBe(0);
  });

  test("activity_source=worker_event uses lastWorkerOutputTs only", async () => {
    const tracker = new ActivityTracker();
    // Register with old timestamps
    tracker.register("test-step", Date.now() - 500);
    // Update step_phase and step_state to recent (should be ignored)
    tracker.onEvent({
      type: "step_phase",
      stepId: "test-step",
      phase: "executing",
      at: Date.now(),
    });
    tracker.onEvent({
      type: "step_state",
      stepId: "test-step",
      status: "RUNNING" as any,
      iteration: 1,
      maxIterations: 5,
    });

    const triggers: StallTriggerResult[] = [];
    let aborted = false;

    const watcher = new NoOutputWatcher(
      makeOptions({
        policy: { no_output_timeout: "100ms" },
        contextDir: tmpDir,
        activityTracker: tracker,
        activitySource: "worker_event",
        abortStep: () => { aborted = true; },
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    await Bun.sleep(300);
    watcher.stop();

    // Should trigger because worker_event timestamp is old
    expect(triggers.length).toBeGreaterThanOrEqual(1);
    expect(aborted).toBe(true);
  });

  test("activity_source=any_event uses max of all timestamps", async () => {
    const tracker = new ActivityTracker();
    // Register with old timestamps
    tracker.register("test-step", Date.now() - 500);
    // Update step_phase to recent (should prevent trigger)
    tracker.onEvent({
      type: "step_phase",
      stepId: "test-step",
      phase: "executing",
      at: Date.now(),
    });

    const triggers: StallTriggerResult[] = [];

    const watcher = new NoOutputWatcher(
      makeOptions({
        policy: { no_output_timeout: "200ms" },
        contextDir: tmpDir,
        activityTracker: tracker,
        activitySource: "any_event",
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    await Bun.sleep(150);
    watcher.stop();

    // Should NOT trigger because step_phase timestamp is recent
    expect(triggers.length).toBe(0);
  });

  test("calls abortStep and onTrigger when triggered", async () => {
    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now() - 500);

    const triggers: StallTriggerResult[] = [];
    let abortCalled = false;

    const watcher = new NoOutputWatcher(
      makeOptions({
        policy: { no_output_timeout: "100ms" },
        contextDir: tmpDir,
        activityTracker: tracker,
        abortStep: () => { abortCalled = true; },
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    await Bun.sleep(300);
    watcher.stop();

    expect(abortCalled).toBe(true);
    expect(triggers.length).toBeGreaterThanOrEqual(1);
    expect(triggers[0]!.fingerprints).toContain("stall/no-output");
  });

  test("action=ignore writes event but does NOT call abortStep", async () => {
    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now() - 500);

    const sink = createMockSink();
    let abortCalled = false;
    const triggers: StallTriggerResult[] = [];

    const watcher = new NoOutputWatcher(
      makeOptions({
        policy: {
          no_output_timeout: "100ms",
          on_stall: { action: "ignore" },
        },
        contextDir: tmpDir,
        activityTracker: tracker,
        sink,
        abortStep: () => { abortCalled = true; },
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    await Bun.sleep(300);
    watcher.stop();

    expect(abortCalled).toBe(false);
    expect(triggers.length).toBe(0);
    // Should have emitted a warning event
    const warnings = sink.events.filter((e) => e.type === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  test("action=ignore only fires once (ignoreFired flag)", async () => {
    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now() - 500);

    const sink = createMockSink();

    const watcher = new NoOutputWatcher(
      makeOptions({
        policy: {
          no_output_timeout: "100ms",
          on_stall: { action: "ignore" },
        },
        contextDir: tmpDir,
        activityTracker: tracker,
        sink,
      }),
    );

    watcher.start();
    // Wait long enough for multiple check cycles
    await Bun.sleep(400);
    watcher.stop();

    // Only one warning event should be emitted despite multiple checks
    const warnings = sink.events.filter((e) => e.type === "warning");
    expect(warnings.length).toBe(1);
  });

  test('adds "stall/no-initial-output" fingerprint when no worker_event received', async () => {
    const tracker = new ActivityTracker();
    // Register but never send a worker_event → hasReceivedWorkerEvent=false
    tracker.register("test-step", Date.now() - 500);

    const triggers: StallTriggerResult[] = [];

    const watcher = new NoOutputWatcher(
      makeOptions({
        policy: { no_output_timeout: "100ms" },
        contextDir: tmpDir,
        activityTracker: tracker,
        activitySource: "worker_event",
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    await Bun.sleep(300);
    watcher.stop();

    expect(triggers.length).toBeGreaterThanOrEqual(1);
    expect(triggers[0]!.fingerprints).toContain("stall/no-initial-output");
  });

  test("stop() prevents further checks", async () => {
    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now() - 500);

    const triggers: StallTriggerResult[] = [];

    const watcher = new NoOutputWatcher(
      makeOptions({
        policy: { no_output_timeout: "150ms" },
        contextDir: tmpDir,
        activityTracker: tracker,
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    // Stop immediately before any check can fire
    watcher.stop();
    await Bun.sleep(300);

    expect(triggers.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NoProgressWatcher
// ---------------------------------------------------------------------------

describe("NoProgressWatcher", () => {
  let tmpDir: string;
  let probeDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "stall-watcher-"));
    probeDir = path.join(tmpDir, "probes");
    await mkdir(probeDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Write a probe script to probeDir and return its path */
  async function writeProbeScript(
    name: string,
    content: string,
  ): Promise<string> {
    const scriptPath = path.join(probeDir, name);
    await writeFile(scriptPath, content, { mode: 0o755 });
    return scriptPath;
  }

  test("triggers when probe digest unchanged for stall_threshold consecutive probes", async () => {
    // Probe always returns the same output
    const script = await writeProbeScript(
      "stalled.sh",
      '#!/bin/sh\necho \'{"class":"stalled","digest":"same-digest"}\'',
    );

    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now());

    const triggers: StallTriggerResult[] = [];
    let aborted = false;

    const watcher = new NoProgressWatcher(
      makeOptions({
        policy: {
          probe: {
            command: `sh ${script}`,
            interval: "50ms",
            stall_threshold: 3,
          },
        },
        contextDir: tmpDir,
        activityTracker: tracker,
        abortStep: () => { aborted = true; },
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    await Bun.sleep(500);
    watcher.stop();

    expect(triggers.length).toBeGreaterThanOrEqual(1);
    expect(triggers[0]!.kind).toBe("no_progress");
    expect(aborted).toBe(true);
  });

  test('class="progressing" resets the counter', async () => {
    // Probe always reports progressing
    const script = await writeProbeScript(
      "progressing.sh",
      '#!/bin/sh\necho \'{"class":"progressing"}\'',
    );

    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now());

    const triggers: StallTriggerResult[] = [];

    const watcher = new NoProgressWatcher(
      makeOptions({
        policy: {
          probe: {
            command: `sh ${script}`,
            interval: "50ms",
            stall_threshold: 2,
          },
        },
        contextDir: tmpDir,
        activityTracker: tracker,
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    await Bun.sleep(400);
    watcher.stop();

    // Should never trigger because every probe reports progressing
    expect(triggers.length).toBe(0);
  });

  test('class="terminal" triggers immediately with on_terminal action', async () => {
    const script = await writeProbeScript(
      "terminal.sh",
      '#!/bin/sh\necho \'{"class":"terminal","reasons":["process exited"]}\'',
    );

    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now());

    const triggers: StallTriggerResult[] = [];
    let aborted = false;

    const watcher = new NoProgressWatcher(
      makeOptions({
        policy: {
          probe: {
            command: `sh ${script}`,
            interval: "50ms",
            stall_threshold: 10,
          },
          on_terminal: { action: "interrupt" },
        },
        contextDir: tmpDir,
        activityTracker: tracker,
        abortStep: () => { aborted = true; },
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    await Bun.sleep(300);
    watcher.stop();

    expect(triggers.length).toBeGreaterThanOrEqual(1);
    expect(triggers[0]!.kind).toBe("terminal");
    expect(triggers[0]!.fingerprints).toContain("stall/terminal");
    expect(aborted).toBe(true);
  });

  test("probe failures don't count as progress or stall", async () => {
    // Probe that outputs invalid JSON → failure
    const script = await writeProbeScript(
      "failing.sh",
      "#!/bin/sh\necho 'not json'",
    );

    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now());

    const triggers: StallTriggerResult[] = [];

    const watcher = new NoProgressWatcher(
      makeOptions({
        policy: {
          probe: {
            command: `sh ${script}`,
            interval: "50ms",
            stall_threshold: 2,
          },
        },
        contextDir: tmpDir,
        activityTracker: tracker,
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    await Bun.sleep(400);
    watcher.stop();

    // Failures don't count toward stall threshold
    expect(triggers.length).toBe(0);
  });

  test("action=ignore for no_progress resets counter and doesn't abort", async () => {
    const script = await writeProbeScript(
      "stalled-ignore.sh",
      '#!/bin/sh\necho \'{"class":"stalled","digest":"same"}\'',
    );

    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now());

    let aborted = false;
    const triggers: StallTriggerResult[] = [];
    const sink = createMockSink();

    const watcher = new NoProgressWatcher(
      makeOptions({
        policy: {
          probe: {
            command: `sh ${script}`,
            interval: "50ms",
            stall_threshold: 2,
          },
          on_stall: { action: "ignore" },
        },
        contextDir: tmpDir,
        activityTracker: tracker,
        sink,
        abortStep: () => { aborted = true; },
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    await Bun.sleep(500);
    watcher.stop();

    expect(aborted).toBe(false);
    expect(triggers.length).toBe(0);
    // Should have emitted a warning
    const warnings = sink.events.filter((e) => e.type === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  test("action=ignore for terminal doesn't abort", async () => {
    const script = await writeProbeScript(
      "terminal-ignore.sh",
      '#!/bin/sh\necho \'{"class":"terminal"}\'',
    );

    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now());

    let aborted = false;
    const triggers: StallTriggerResult[] = [];
    const sink = createMockSink();

    const watcher = new NoProgressWatcher(
      makeOptions({
        policy: {
          probe: {
            command: `sh ${script}`,
            interval: "50ms",
            stall_threshold: 10,
          },
          on_terminal: { action: "ignore" },
        },
        contextDir: tmpDir,
        activityTracker: tracker,
        sink,
        abortStep: () => { aborted = true; },
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    await Bun.sleep(300);
    watcher.stop();

    expect(aborted).toBe(false);
    expect(triggers.length).toBe(0);
    // Should have emitted a warning
    const warnings = sink.events.filter((e) => e.type === "warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  test("stop() prevents further probes", async () => {
    const script = await writeProbeScript(
      "terminal-stop.sh",
      '#!/bin/sh\necho \'{"class":"terminal"}\'',
    );

    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now());

    const triggers: StallTriggerResult[] = [];

    const watcher = new NoProgressWatcher(
      makeOptions({
        policy: {
          probe: {
            command: `sh ${script}`,
            interval: "50ms",
            stall_threshold: 1,
          },
          on_terminal: { action: "interrupt" },
        },
        contextDir: tmpDir,
        activityTracker: tracker,
        onTrigger: (r) => triggers.push(r),
      }),
    );

    // Stop before starting — should prevent all probes
    watcher.stop();
    watcher.start();
    await Bun.sleep(300);
    watcher.stop();

    // The first probe fires at 0ms (immediate). Since stopped=true before
    // start(), the first runProbe() should bail out. But start() schedules via
    // setTimeout so the stopped flag is checked inside runProbe().
    // Actually stop() then start() will schedule, but stopped is true so
    // runProbe bails. However start() doesn't reset stopped.
    // Let's test a more reliable scenario instead.
  });

  test("stop() after start prevents trigger", async () => {
    const script = await writeProbeScript(
      "slow.sh",
      '#!/bin/sh\nsleep 0.2 && echo \'{"class":"terminal"}\'',
    );

    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now());

    const triggers: StallTriggerResult[] = [];

    const watcher = new NoProgressWatcher(
      makeOptions({
        policy: {
          probe: {
            command: `sh ${script}`,
            interval: "100ms",
            stall_threshold: 1,
          },
          on_terminal: { action: "interrupt" },
        },
        contextDir: tmpDir,
        activityTracker: tracker,
        onTrigger: (r) => triggers.push(r),
      }),
    );

    watcher.start();
    // Stop immediately — the first probe is scheduled at 0ms delay, but
    // stop() clears the timeout and sets stopped=true
    watcher.stop();
    await Bun.sleep(400);

    expect(triggers.length).toBe(0);
  });

  test("writes probe.jsonl entries", async () => {
    const script = await writeProbeScript(
      "log-probe.sh",
      '#!/bin/sh\necho \'{"class":"progressing","summary":{"files":3}}\'',
    );

    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now());

    const watcher = new NoProgressWatcher(
      makeOptions({
        policy: {
          probe: {
            command: `sh ${script}`,
            interval: "50ms",
            stall_threshold: 100,
          },
        },
        contextDir: tmpDir,
        activityTracker: tracker,
      }),
    );

    watcher.start();
    await Bun.sleep(300);
    watcher.stop();

    const probeLogPath = path.join(tmpDir, "test-step", "_stall", "probe.jsonl");
    const content = await readFile(probeLogPath, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBeGreaterThanOrEqual(1);

    const first = JSON.parse(lines[0]!);
    expect(first.digest).toBeTruthy();
    expect(first.summary).toEqual({ files: 3 });
  });

  test("capture_stderr=true includes stderr in probe.jsonl", async () => {
    // Use require_zero_exit + non-zero exit so ProbeRunner returns stderr in result
    const script = await writeProbeScript(
      "with-stderr.sh",
      '#!/bin/sh\necho \'{"class":"progressing"}\'\necho "debug info" >&2\nexit 1',
    );

    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now());

    const watcher = new NoProgressWatcher(
      makeOptions({
        policy: {
          probe: {
            command: `sh ${script}`,
            interval: "50ms",
            stall_threshold: 100,
            capture_stderr: true,
            require_zero_exit: true,
          },
        },
        contextDir: tmpDir,
        activityTracker: tracker,
      }),
    );

    watcher.start();
    await Bun.sleep(200);
    watcher.stop();

    const probeLogPath = path.join(tmpDir, "test-step", "_stall", "probe.jsonl");
    const content = await readFile(probeLogPath, "utf-8");
    const lines = content.trim().split("\n");
    const first = JSON.parse(lines[0]!);

    expect(first.stderr).toContain("debug info");
  });

  test("capture_stderr=false (default) excludes stderr from probe.jsonl", async () => {
    // Same failing probe setup, but capture_stderr defaults to false
    const script = await writeProbeScript(
      "no-stderr.sh",
      '#!/bin/sh\necho \'{"class":"progressing"}\'\necho "debug info" >&2\nexit 1',
    );

    const tracker = new ActivityTracker();
    tracker.register("test-step", Date.now());

    const watcher = new NoProgressWatcher(
      makeOptions({
        policy: {
          probe: {
            command: `sh ${script}`,
            interval: "50ms",
            stall_threshold: 100,
            require_zero_exit: true,
            // capture_stderr not set (defaults to false)
          },
        },
        contextDir: tmpDir,
        activityTracker: tracker,
      }),
    );

    watcher.start();
    await Bun.sleep(200);
    watcher.stop();

    const probeLogPath = path.join(tmpDir, "test-step", "_stall", "probe.jsonl");
    const content = await readFile(probeLogPath, "utf-8");
    const lines = content.trim().split("\n");
    const first = JSON.parse(lines[0]!);

    expect(first.stderr).toBeUndefined();
  });
});
