/**
 * AT: Sentinel stall-detection integration tests
 *
 * Tests the end-to-end sentinel / stall-guard system integrated
 * with the WorkflowExecutor.
 */
import { describe, test, expect } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ErrorClass } from "../../src/types/common.js";
import { WorkflowStatus, StepStatus } from "../../src/workflow/types.js";
import { parseWorkflow } from "../../src/workflow/parser.js";
import { ContextManager } from "../../src/workflow/context-manager.js";
import { WorkflowExecutor } from "../../src/workflow/executor.js";
import type { StepRunner, StepRunResult, CheckResult } from "../../src/workflow/executor.js";
import {
  MockStepRunner,
  withTempDir,
  executeYaml,
  writeWorkspaceFile,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Step handler that hangs until aborted, then throws (mimics real worker). */
function hangUntilAborted() {
  return async (
    _stepId: string,
    _step: any,
    _callIndex: number,
    abortSignal: AbortSignal,
  ) => {
    await new Promise<void>((_resolve, reject) => {
      if (abortSignal.aborted) {
        reject(new Error("aborted"));
        return;
      }
      abortSignal.addEventListener(
        "abort",
        () => reject(new Error("aborted")),
        { once: true },
      );
    });
    return { status: "SUCCEEDED" as const };
  };
}

/** Step handler that waits for abort, then returns a FAILED result (no throw). */
function hangUntilAbortedReturnFailed(errorClass: ErrorClass) {
  return async (
    _stepId: string,
    _step: any,
    _callIndex: number,
    abortSignal: AbortSignal,
  ): Promise<StepRunResult> => {
    await new Promise<void>((resolve) => {
      if (abortSignal.aborted) {
        resolve();
        return;
      }
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { status: "FAILED", errorClass };
  };
}

// ---------------------------------------------------------------------------
// AT: Sentinel no_output_timeout interrupts a stalled step
// ---------------------------------------------------------------------------

describe("Sentinel: no_output_timeout interrupts stalled step", () => {
  test("step with no worker output is interrupted by sentinel", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: sentinel-no-output
version: "1"
timeout: "30s"
sentinel:
  enabled: true
steps:
  stalled:
    worker: CUSTOM
    instructions: "this step will stall"
    capabilities: [READ]
    stall:
      no_output_timeout: "1s"
      on_stall:
        action: interrupt
`;

      const runner = new MockStepRunner(hangUntilAborted());

      const startTime = Date.now();
      const { state, contextDir } = await executeYaml(yaml, runner, dir);
      const elapsed = Date.now() - startTime;

      // Step should be FAILED (sentinel abort → FAILED with error class)
      expect(state.steps["stalled"]!.status).toBe(StepStatus.FAILED);
      // Workflow should be FAILED since on_failure defaults to "abort"
      expect(state.status).toBe(WorkflowStatus.FAILED);
      // Error class should be RETRYABLE_TRANSIENT (default for sentinel)
      expect(state.steps["stalled"]!.errorClass).toBe(
        ErrorClass.RETRYABLE_TRANSIENT,
      );

      // Should complete faster than the workflow timeout (sentinel triggers ~1s)
      expect(elapsed).toBeLessThan(10000);

      // Verify _stall/event.json artifact was written
      const stallEventPath = path.join(
        contextDir,
        "stalled",
        "_stall",
        "event.json",
      );
      const eventStat = await stat(stallEventPath).catch(() => null);
      expect(eventStat).not.toBeNull();

      const eventContent = JSON.parse(
        await readFile(stallEventPath, "utf-8"),
      );
      expect(eventContent.schema).toBe("roboppi.sentinel.stall.v1");
      expect(eventContent.trigger.kind).toBe("no_output");
      expect(eventContent.action.kind).toBe("interrupt");
      expect(eventContent.step.id).toBe("stalled");
    });
  });

  test("runner returning FAILED on abort is still treated as sentinel stall", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: sentinel-no-output-non-throw
version: "1"
timeout: "30s"
sentinel:
  enabled: true
steps:
  stalled:
    worker: CUSTOM
    instructions: "this step will stall"
    capabilities: [READ]
    stall:
      no_output_timeout: "1s"
      on_stall:
        action: interrupt
        error_class: RETRYABLE_TRANSIENT
`;

      // Simulate a real runner that returns a cancellation result instead of throwing.
      const runner = new MockStepRunner(hangUntilAbortedReturnFailed(ErrorClass.NON_RETRYABLE));

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.steps["stalled"]!.status).toBe(StepStatus.FAILED);
      // Sentinel mapping should override the runner-provided error class.
      expect(state.steps["stalled"]!.errorClass).toBe(ErrorClass.RETRYABLE_TRANSIENT);
      expect(state.status).toBe(WorkflowStatus.FAILED);
    });
  });
});

// ---------------------------------------------------------------------------
// AT: Sentinel on_stall action=interrupt maps to RETRYABLE_TRANSIENT
// ---------------------------------------------------------------------------

describe("Sentinel: on_stall action=interrupt → RETRYABLE_TRANSIENT", () => {
  test("explicit on_stall.action=interrupt produces RETRYABLE_TRANSIENT", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: sentinel-error-class
version: "1"
timeout: "30s"
sentinel:
  enabled: true
steps:
  stalled:
    worker: CUSTOM
    instructions: "stalled step"
    capabilities: [READ]
    on_failure: abort
    stall:
      no_output_timeout: "1s"
      on_stall:
        action: interrupt
        error_class: RETRYABLE_TRANSIENT
`;

      const runner = new MockStepRunner(hangUntilAborted());
      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.steps["stalled"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["stalled"]!.errorClass).toBe(
        ErrorClass.RETRYABLE_TRANSIENT,
      );
      expect(state.status).toBe(WorkflowStatus.FAILED);
    });
  });
});

// ---------------------------------------------------------------------------
// AT: Probe no_progress detects stall
// ---------------------------------------------------------------------------

describe("Sentinel: probe no_progress detects stall", () => {
  test("step with unchanging probe digest is detected as stalled", async () => {
    await withTempDir(async (dir) => {
      // Write a probe script that always returns the same JSON output.
      // The digest never changes, so with stall_threshold=2 and
      // interval=500ms, stall should be detected after ~1s.
      await writeWorkspaceFile(
        dir,
        "probe.sh",
        '#!/bin/sh\nprintf \'{"class":"stalled","value":42}\\n\'',
      );
      const { chmod } = await import("node:fs/promises");
      await chmod(path.join(dir, "probe.sh"), 0o755);

      const yaml = `
name: sentinel-probe-stall
version: "1"
timeout: "30s"
sentinel:
  enabled: true
steps:
  stalled:
    worker: CUSTOM
    instructions: "stalled step"
    capabilities: [READ]
    stall:
      probe:
        interval: "500ms"
        timeout: "3s"
        command: ./probe.sh
        stall_threshold: 2
      on_stall:
        action: interrupt
`;

      const runner = new MockStepRunner(hangUntilAborted());
      const startTime = Date.now();
      const { state, contextDir } = await executeYaml(yaml, runner, dir);
      const elapsed = Date.now() - startTime;

      expect(state.steps["stalled"]!.status).toBe(StepStatus.FAILED);
      expect(state.status).toBe(WorkflowStatus.FAILED);

      // Should detect stall within a few seconds
      expect(elapsed).toBeLessThan(15000);

      // Verify _stall/event.json was written
      const stallEventPath = path.join(
        contextDir,
        "stalled",
        "_stall",
        "event.json",
      );
      const eventStat = await stat(stallEventPath).catch(() => null);
      expect(eventStat).not.toBeNull();

      const eventContent = JSON.parse(
        await readFile(stallEventPath, "utf-8"),
      );
      expect(eventContent.trigger.kind).toBe("no_progress");
    });
  });
});

// ---------------------------------------------------------------------------
// AT: Sentinel disabled does not interfere
// ---------------------------------------------------------------------------

describe("Sentinel: disabled does not interfere", () => {
  test("workflow with sentinel.enabled=false runs step normally", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: sentinel-disabled
version: "1"
timeout: "30s"
sentinel:
  enabled: false
steps:
  normal:
    worker: CUSTOM
    instructions: "normal step"
    capabilities: [READ]
    stall:
      no_output_timeout: "1s"
      on_stall:
        action: interrupt
`;

      const runner = new MockStepRunner(async () => ({
        status: "SUCCEEDED" as const,
      }));

      const { state } = await executeYaml(yaml, runner, dir);

      // Step should succeed normally — sentinel is disabled
      expect(state.steps["normal"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
    });
  });

  test("step with stall.enabled=false runs normally even with sentinel on", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: sentinel-stall-disabled
version: "1"
timeout: "30s"
sentinel:
  enabled: true
steps:
  normal:
    worker: CUSTOM
    instructions: "normal step"
    capabilities: [READ]
    stall:
      enabled: false
      no_output_timeout: "1s"
      on_stall:
        action: interrupt
`;

      const runner = new MockStepRunner(async () => ({
        status: "SUCCEEDED" as const,
      }));

      const { state } = await executeYaml(yaml, runner, dir);

      // Step should succeed normally — stall guard is disabled at step level
      expect(state.steps["normal"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
    });
  });
});

// ---------------------------------------------------------------------------
// AT: completion_check sentinel abort maps to INCOMPLETE when as_incomplete=true
// ---------------------------------------------------------------------------

describe("Sentinel: completion_check as_incomplete", () => {
  test("sentinel abort during completion_check becomes INCOMPLETE (not FAILED)", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: sentinel-check-incomplete
version: "1"
timeout: "20s"
sentinel:
  enabled: true
steps:
  A:
    worker: CUSTOM
    instructions: "noop"
    capabilities: [READ]
    max_iterations: 2
    on_iterations_exhausted: continue
    completion_check:
      worker: CUSTOM
      instructions: "hang check"
      capabilities: [READ]
      stall:
        no_output_timeout: "200ms"
        on_stall:
          action: interrupt
          as_incomplete: true
`;

      const definition = parseWorkflow(yaml);
      const contextDir = path.join(dir, "context");
      const ctx = new ContextManager(contextDir);

      const runner: StepRunner = {
        async runStep(): Promise<StepRunResult> {
          return { status: "SUCCEEDED" };
        },
        async runCheck(
          _stepId: string,
          _check: any,
          _workspaceDir: string,
          abortSignal: AbortSignal,
        ): Promise<CheckResult> {
          await new Promise<void>((resolve) => {
            if (abortSignal.aborted) {
              resolve();
              return;
            }
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          // Mimic a real runner that returns failed=true on cancellation.
          return {
            complete: false,
            failed: true,
            errorClass: ErrorClass.RETRYABLE_TRANSIENT,
            reason: "cancelled",
          };
        },
      };

      const executor = new WorkflowExecutor(definition, ctx, runner, dir);
      const state = await executor.execute();

      // With as_incomplete=true, the check should not fail the step.
      expect(state.steps["A"]!.status).toBe(StepStatus.INCOMPLETE);
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      // Verify _stall/event.json artifact was written
      const stallEventPath = path.join(contextDir, "A", "_stall", "event.json");
      const eventStat = await stat(stallEventPath).catch(() => null);
      expect(eventStat).not.toBeNull();
      const eventContent = JSON.parse(await readFile(stallEventPath, "utf-8"));
      expect(eventContent.schema).toBe("roboppi.sentinel.stall.v1");
      expect(eventContent.trigger.kind).toBe("no_output");
    });
  });
});

// ---------------------------------------------------------------------------
// AT: activity_source: "probe_only" disables timer-based no_output watcher
// ---------------------------------------------------------------------------

describe("Sentinel: activity_source probe_only", () => {
  test("activity_source: probe_only disables timer-based no_output watcher", async () => {
    await withTempDir(async (dir) => {
      // This step has no_output_timeout: "1s" but activity_source: "probe_only".
      // The no_output watcher should NOT be created, so the step completes normally
      // even though no worker_event is ever emitted.
      const yaml = `
name: sentinel-probe-only
version: "1"
timeout: "10s"
sentinel:
  enabled: true
steps:
  quick:
    worker: CUSTOM
    instructions: "quick step"
    capabilities: [READ]
    stall:
      no_output_timeout: "1s"
      activity_source: probe_only
      on_stall:
        action: interrupt
`;

      // Step completes immediately (no hanging) — returns SUCCEEDED.
      const runner = new MockStepRunner(async () => ({
        status: "SUCCEEDED" as const,
      }));

      const { state } = await executeYaml(yaml, runner, dir);

      // Step should succeed — no_output watcher was not created due to probe_only
      expect(state.steps["quick"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
    });
  });
});
