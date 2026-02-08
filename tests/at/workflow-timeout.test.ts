/**
 * AT-6: Timeout acceptance tests
 */
import { describe, test, expect } from "bun:test";
import { WorkflowStatus, StepStatus } from "../../src/workflow/types.js";
import { MockStepRunner, withTempDir, executeYaml } from "./helpers.js";

// ---------------------------------------------------------------------------
// AT-6.1 Workflow timeout cancels long-running step
// ---------------------------------------------------------------------------

describe("AT-6.1 Workflow timeout cancels long-running step", () => {
  test("timeout: 1s, step hangs → CANCELLED, workflow TIMED_OUT", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: timeout-basic
version: "1"
timeout: "1s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
  B:
    worker: CODEX_CLI
    instructions: "step B"
    capabilities: [READ]
    depends_on: [A]
`;

      const runner = new MockStepRunner(async (_stepId, _step, _callIndex, abortSignal) => {
        // Step A hangs until aborted
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
            return;
          }
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "SUCCEEDED" };
      });

      const startTime = Date.now();
      const { state } = await executeYaml(yaml, runner, dir);
      const elapsed = Date.now() - startTime;

      expect(state.steps["A"]!.status).toBe(StepStatus.CANCELLED);
      expect(state.steps["B"]!.status).toBe(StepStatus.SKIPPED);
      expect(state.status).toBe(WorkflowStatus.TIMED_OUT);
      // Execution time should be around 1s (±500ms)
      expect(elapsed).toBeGreaterThanOrEqual(800);
      expect(elapsed).toBeLessThan(2500);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-6.2 Multiple parallel steps running at timeout
// ---------------------------------------------------------------------------

describe("AT-6.2 Multiple parallel steps running at timeout", () => {
  test("A, B, C parallel all hang → all CANCELLED, workflow TIMED_OUT", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: timeout-parallel
version: "1"
timeout: "1s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
  B:
    worker: CODEX_CLI
    instructions: "step B"
    capabilities: [READ]
  C:
    worker: CODEX_CLI
    instructions: "step C"
    capabilities: [READ]
  D:
    worker: CODEX_CLI
    instructions: "step D"
    capabilities: [READ]
    depends_on: [A, B, C]
`;

      const runner = new MockStepRunner(async (_stepId, _step, _callIndex, abortSignal) => {
        // All steps hang until aborted
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
            return;
          }
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      // All running steps should be CANCELLED
      expect(state.steps["A"]!.status).toBe(StepStatus.CANCELLED);
      expect(state.steps["B"]!.status).toBe(StepStatus.CANCELLED);
      expect(state.steps["C"]!.status).toBe(StepStatus.CANCELLED);
      // D was PENDING and never started → SKIPPED
      expect(state.steps["D"]!.status).toBe(StepStatus.SKIPPED);
      expect(state.status).toBe(WorkflowStatus.TIMED_OUT);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-6.3 completion_check loop interrupted by timeout
// ---------------------------------------------------------------------------

describe("AT-6.3 completion_check loop interrupted by timeout", () => {
  test("loop at iteration 3/10 when timeout hits → CANCELLED, TIMED_OUT", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: timeout-completion-loop
version: "1"
timeout: "1s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
    max_iterations: 10
    on_iterations_exhausted: abort
    completion_check:
      worker: CODEX_CLI
      instructions: "check A"
      capabilities: [READ]
`;

      let iterationCount = 0;
      const runner = new MockStepRunner(
        async (_stepId, _step, _callIndex, abortSignal) => {
          iterationCount++;
          if (iterationCount >= 3) {
            // On 3rd iteration, hang until abort
            await new Promise<void>((resolve) => {
              if (abortSignal.aborted) {
                resolve();
                return;
              }
              abortSignal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          return { status: "SUCCEEDED" };
        },
        async () => {
          // Completion check always returns incomplete
          return { complete: false, failed: false };
        },
      );

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.steps["A"]!.status).toBe(StepStatus.CANCELLED);
      expect(state.status).toBe(WorkflowStatus.TIMED_OUT);
      // Should have run at least 2 full iterations before timeout interrupted the 3rd
      expect(iterationCount).toBeGreaterThanOrEqual(2);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-6.4 AbortSignal fires on timeout
// ---------------------------------------------------------------------------

describe("AT-6.4 AbortSignal fires on timeout", () => {
  test("abortSignal.aborted becomes true when timeout fires", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: timeout-signal
version: "1"
timeout: "1s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "step A"
    capabilities: [READ]
`;

      let signalWasAborted = false;
      let abortEventFired = false;

      const runner = new MockStepRunner(async (_stepId, _step, _callIndex, abortSignal) => {
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            signalWasAborted = true;
            resolve();
            return;
          }
          abortSignal.addEventListener(
            "abort",
            () => {
              abortEventFired = true;
              signalWasAborted = abortSignal.aborted;
              resolve();
            },
            { once: true },
          );
        });
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.TIMED_OUT);
      expect(abortEventFired).toBe(true);
      expect(signalWasAborted).toBe(true);
    });
  });
});
