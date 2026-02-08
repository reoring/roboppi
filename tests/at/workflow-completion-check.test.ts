/**
 * AT-4: completion_check loop
 *
 * Tests the completion_check iteration logic in WorkflowExecutor.
 */
import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ErrorClass } from "../../src/types/common.js";
import { WorkflowStatus, StepStatus } from "../../src/workflow/types.js";
import {
  MockStepRunner,
  withTempDir,
  executeYaml,
  writeWorkspaceFile,
} from "./helpers.js";

// Base YAML template for a single step with completion_check
function completionCheckYaml(opts: {
  maxIterations?: number;
  onIterationsExhausted?: "abort" | "continue";
  onFailure?: "abort" | "continue" | "retry";
  maxRetries?: number;
  hasFollowUp?: boolean;
}): string {
  const maxIter = opts.maxIterations ?? 5;
  const onExhausted = opts.onIterationsExhausted ?? "abort";
  const onFailure = opts.onFailure ?? "abort";
  const maxRetries = opts.maxRetries ?? 0;

  let yaml = `
name: completion-check-test
version: "1"
timeout: "30s"
steps:
  looper:
    worker: CUSTOM
    instructions: "loop step"
    capabilities: ["READ"]
    on_failure: "${onFailure}"
    max_retries: ${maxRetries}
    max_iterations: ${maxIter}
    on_iterations_exhausted: "${onExhausted}"
    completion_check:
      worker: CUSTOM
      instructions: "check if complete"
      capabilities: ["READ"]
`;

  if (opts.hasFollowUp) {
    yaml += `
  followup:
    worker: CUSTOM
    instructions: "follow up step"
    capabilities: ["READ"]
    depends_on: ["looper"]
`;
  }

  return yaml;
}

describe("AT-4: completion_check loop", () => {
  // -----------------------------------------------------------------------
  // AT-4.1 Check passes on first iteration (no loop)
  // -----------------------------------------------------------------------
  test("AT-4.1: check passes on first iteration (no loop)", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(
        async () => ({ status: "SUCCEEDED" }),
        async () => ({ complete: true, failed: false }),
      );

      const { state } = await executeYaml(
        completionCheckYaml({ maxIterations: 5 }),
        runner,
        dir,
      );

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(state.steps["looper"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.steps["looper"]!.iteration).toBe(1);
      expect(runner.getStepCallCount("looper")).toBe(1);
      expect(runner.getCheckCallCount("looper")).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // AT-4.2 Check passes on Nth iteration
  // -----------------------------------------------------------------------
  test("AT-4.2: check passes on Nth iteration (N=5)", async () => {
    await withTempDir(async (dir) => {
      let checkCount = 0;
      const runner = new MockStepRunner(
        async () => ({ status: "SUCCEEDED" }),
        async () => {
          checkCount++;
          return { complete: checkCount >= 5, failed: false };
        },
      );

      const { state } = await executeYaml(
        completionCheckYaml({ maxIterations: 10 }),
        runner,
        dir,
      );

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(state.steps["looper"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.steps["looper"]!.iteration).toBe(5);
      expect(runner.getStepCallCount("looper")).toBe(5);
      expect(runner.getCheckCallCount("looper")).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // AT-4.3 max_iterations exhausted + abort
  // -----------------------------------------------------------------------
  test("AT-4.3: max_iterations exhausted + abort", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(
        async () => ({ status: "SUCCEEDED" }),
        async () => ({ complete: false, failed: false }),
      );

      const { state } = await executeYaml(
        completionCheckYaml({
          maxIterations: 3,
          onIterationsExhausted: "abort",
          hasFollowUp: true,
        }),
        runner,
        dir,
      );

      expect(state.status).toBe(WorkflowStatus.FAILED);
      expect(state.steps["looper"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["followup"]!.status).toBe(StepStatus.SKIPPED);
      expect(runner.getStepCallCount("looper")).toBe(3);
      expect(runner.getCheckCallCount("looper")).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // AT-4.4 max_iterations exhausted + continue
  // -----------------------------------------------------------------------
  test("AT-4.4: max_iterations exhausted + continue", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(
        async () => ({ status: "SUCCEEDED" }),
        async () => ({ complete: false, failed: false }),
      );

      const { state } = await executeYaml(
        completionCheckYaml({
          maxIterations: 3,
          onIterationsExhausted: "continue",
          hasFollowUp: true,
        }),
        runner,
        dir,
      );

      // Workflow succeeds because INCOMPLETE is treated as progress-allowing
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(state.steps["looper"]!.status).toBe(StepStatus.INCOMPLETE);
      expect(state.steps["followup"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(runner.getStepCallCount("looper")).toBe(3);
      expect(runner.getCheckCallCount("looper")).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // AT-4.5 Checker itself fails
  // -----------------------------------------------------------------------
  test("AT-4.5: checker itself fails", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(
        async () => ({ status: "SUCCEEDED" }),
        async () => ({ complete: false, failed: true }),
      );

      const { state } = await executeYaml(
        completionCheckYaml({
          maxIterations: 10,
          hasFollowUp: true,
        }),
        runner,
        dir,
      );

      // Step fails on first iteration when check fails
      expect(state.steps["looper"]!.status).toBe(StepStatus.FAILED);
      expect(state.status).toBe(WorkflowStatus.FAILED);
      // Loop stops immediately
      expect(runner.getStepCallCount("looper")).toBe(1);
      expect(runner.getCheckCallCount("looper")).toBe(1);
      expect(state.steps["followup"]!.status).toBe(StepStatus.SKIPPED);
    });
  });

  // -----------------------------------------------------------------------
  // AT-4.6 Step fails + retry succeeds + then completion_check
  // -----------------------------------------------------------------------
  test("AT-4.6: retry + completion_check combined", async () => {
    await withTempDir(async (dir) => {
      let stepCallCount = 0;
      let checkCallCount = 0;

      const runner = new MockStepRunner(
        async () => {
          stepCallCount++;
          // First call: FAILED (retryable), second call: SUCCEEDED (iter 1),
          // third call: SUCCEEDED (iter 2)
          if (stepCallCount === 1) {
            return {
              status: "FAILED" as const,
              errorClass: ErrorClass.RETRYABLE_TRANSIENT,
            };
          }
          return { status: "SUCCEEDED" as const };
        },
        async () => {
          checkCallCount++;
          // First check (after retry in iter 1): not complete
          // Second check (iter 2): complete
          return { complete: checkCallCount >= 2, failed: false };
        },
      );

      const { state } = await executeYaml(
        completionCheckYaml({
          maxIterations: 5,
          onFailure: "retry",
          maxRetries: 2,
        }),
        runner,
        dir,
      );

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(state.steps["looper"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.steps["looper"]!.iteration).toBe(2);
      // runStep: fail(1) + retry-success(1) + iter2-success(1) = 3
      expect(runner.getStepCallCount("looper")).toBe(3);
      // runCheck: iter1-check(1) + iter2-check(1) = 2
      expect(runner.getCheckCallCount("looper")).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // AT-4.7 File state persists across iterations
  // -----------------------------------------------------------------------
  test("AT-4.7: file state persists across iterations", async () => {
    await withTempDir(async (dir) => {
      let iterNum = 0;
      let checkCount = 0;
      const progressFile = path.join(dir, "progress.txt");

      const runner = new MockStepRunner(
        async () => {
          iterNum++;
          if (iterNum === 1) {
            await writeWorkspaceFile(dir, "progress.txt", "step1");
          } else if (iterNum === 2) {
            // Read existing content and append
            const existing = await readFile(progressFile, "utf-8");
            await writeWorkspaceFile(
              dir,
              "progress.txt",
              existing + "\nstep2",
            );
          }
          return { status: "SUCCEEDED" as const };
        },
        async () => {
          checkCount++;
          return { complete: checkCount >= 2, failed: false };
        },
      );

      const { state } = await executeYaml(
        completionCheckYaml({ maxIterations: 5 }),
        runner,
        dir,
      );

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(state.steps["looper"]!.iteration).toBe(2);

      // Verify file state accumulated across iterations
      const finalContent = await readFile(progressFile, "utf-8");
      expect(finalContent).toBe("step1\nstep2");
    });
  });
});
