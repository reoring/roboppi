import { describe, it, expect } from "bun:test";
import {
  WorkflowExecutor,
  type StepRunner,
  type StepRunResult,
  type CheckResult,
} from "../../../src/workflow/executor.js";
import { ContextManager } from "../../../src/workflow/context-manager.js";
import type {
  WorkflowDefinition,
  StepDefinition,
  CompletionCheckDef,
} from "../../../src/workflow/types.js";
import { WorkflowStatus, StepStatus } from "../../../src/workflow/types.js";
import { ErrorClass } from "../../../src/types/common.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return {
    worker: "CODEX_CLI",
    instructions: "do work",
    capabilities: ["READ"],
    ...overrides,
  };
}

function makeWorkflow(
  steps: Record<string, StepDefinition>,
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    name: "test-workflow",
    version: "1",
    timeout: "10m",
    steps,
    ...overrides,
  };
}

/** Simple mock StepRunner that delegates to callbacks. */
class MockStepRunner implements StepRunner {
  readonly stepCalls: Array<{ stepId: string; iteration: number }> = [];
  readonly checkCalls: Array<{ stepId: string }> = [];
  private readonly stepHandler: (
    stepId: string,
    step: StepDefinition,
    callIndex: number,
    abortSignal: AbortSignal,
  ) => Promise<StepRunResult>;
  private readonly checkHandler: (
    stepId: string,
    check: CompletionCheckDef,
    callIndex: number,
  ) => Promise<CheckResult>;
  private stepCallCounts = new Map<string, number>();
  private checkCallCounts = new Map<string, number>();
  runningNow = 0;
  maxConcurrentObserved = 0;

  constructor(
    stepHandler?: (
      stepId: string,
      step: StepDefinition,
      callIndex: number,
      abortSignal: AbortSignal,
    ) => Promise<StepRunResult>,
    checkHandler?: (
      stepId: string,
      check: CompletionCheckDef,
      callIndex: number,
    ) => Promise<CheckResult>,
  ) {
    this.stepHandler =
      stepHandler ?? (async () => ({ status: "SUCCEEDED" as const }));
    this.checkHandler =
      checkHandler ??
      (async () => ({ complete: true, failed: false }));
  }

  async runStep(
    stepId: string,
    step: StepDefinition,
    _workspaceDir: string,
    abortSignal: AbortSignal,
  ): Promise<StepRunResult> {
    const count = (this.stepCallCounts.get(stepId) ?? 0) + 1;
    this.stepCallCounts.set(stepId, count);
    this.stepCalls.push({ stepId, iteration: count });
    this.runningNow++;
    if (this.runningNow > this.maxConcurrentObserved) {
      this.maxConcurrentObserved = this.runningNow;
    }
    try {
      return await this.stepHandler(stepId, step, count, abortSignal);
    } finally {
      this.runningNow--;
    }
  }

  async runCheck(
    stepId: string,
    check: CompletionCheckDef,
    _workspaceDir: string,
    _abortSignal: AbortSignal,
  ): Promise<CheckResult> {
    const count = (this.checkCallCounts.get(stepId) ?? 0) + 1;
    this.checkCallCounts.set(stepId, count);
    this.checkCalls.push({ stepId });
    return this.checkHandler(stepId, check, count);
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runCmd(
  cwd: string,
  command: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkflowExecutor", () => {
  // -----------------------------------------------------------------------
  // Linear DAG: A -> B -> C, all succeed
  // -----------------------------------------------------------------------
  describe("linear DAG", () => {
    it("executes A → B → C in order, all succeed", async () => {
      await withTempDir(async (dir) => {
        const order: string[] = [];
        const runner = new MockStepRunner(async (stepId) => {
          order.push(stepId);
          return { status: "SUCCEEDED" };
        });

        const wf = makeWorkflow({
          A: makeStep(),
          B: makeStep({ depends_on: ["A"] }),
          C: makeStep({ depends_on: ["B"] }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);
        expect(result.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(result.steps["B"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(result.steps["C"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(order).toEqual(["A", "B", "C"]);
      });
    });
  });

  // -----------------------------------------------------------------------
  // Parallel fan-out/fan-in: A → {B, C} → D
  // -----------------------------------------------------------------------
  describe("parallel fan-out/fan-in", () => {
    it("runs B and C in parallel after A, then D after both", async () => {
      await withTempDir(async (dir) => {
        const order: string[] = [];
        const runner = new MockStepRunner(async (stepId) => {
          order.push(stepId);
          // Small delay so parallel steps overlap
          await new Promise((r) => setTimeout(r, 10));
          return { status: "SUCCEEDED" };
        });

        const wf = makeWorkflow({
          A: makeStep(),
          B: makeStep({ depends_on: ["A"] }),
          C: makeStep({ depends_on: ["A"] }),
          D: makeStep({ depends_on: ["B", "C"] }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);
        // A must be first, D must be last
        expect(order[0]).toBe("A");
        expect(order[3]).toBe("D");
        // B and C should be in the middle (order between them is non-deterministic)
        expect(order.slice(1, 3).sort()).toEqual(["B", "C"]);
        expect(runner.maxConcurrentObserved).toBeGreaterThanOrEqual(2);
      });
    });
  });

  // -----------------------------------------------------------------------
  // completion_check loop: passes on 3rd iteration
  // -----------------------------------------------------------------------
  describe("completion_check loop", () => {
    it("loops until check passes on 3rd iteration", async () => {
      await withTempDir(async (dir) => {
        let runCount = 0;
        const runner = new MockStepRunner(
          async () => {
            runCount++;
            return { status: "SUCCEEDED" };
          },
          async (_stepId, _check, callIndex) => {
            // Passes on 3rd check call
            return {
              complete: callIndex >= 3,
              failed: false,
            };
          },
        );

        const wf = makeWorkflow({
          A: makeStep({
            completion_check: {
              worker: "CLAUDE_CODE",
              instructions: "check",
              capabilities: ["READ"],
            },
            max_iterations: 5,
            on_iterations_exhausted: "abort",
          }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);
        expect(result.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(result.steps["A"]!.iteration).toBe(3);
        expect(runCount).toBe(3);
        expect(runner.checkCalls.length).toBe(3);
      });
    });

    it("collects outputs written by completion_check", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(
          async () => ({ status: "SUCCEEDED" }),
          async () => {
            await writeFile(path.join(dir, "out.txt"), "from-check", "utf-8");
            return { complete: true, failed: false };
          },
        );

        const wf = makeWorkflow({
          A: makeStep({
            outputs: [{ name: "out", path: "out.txt", type: "text" }],
            completion_check: {
              worker: "CLAUDE_CODE",
              instructions: "check",
              capabilities: ["READ"],
            },
            max_iterations: 2,
            on_iterations_exhausted: "abort",
          }),
        });

        const ctxDir = path.join(dir, "context");
        const ctx = new ContextManager(ctxDir);
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);
        const copied = await readFile(path.join(ctxDir, "A", "out", "out.txt"), "utf-8");
        expect(copied).toBe("from-check");
      });
    });

    it("escalates convergence stage on repeating fingerprints and fails at max_stage", async () => {
      await withTempDir(async (dir) => {
        const instructionsByIter: string[] = [];
        const runner = new MockStepRunner(
          async (_stepId, step) => {
            instructionsByIter.push(step.instructions);
            return { status: "SUCCEEDED" };
          },
          async () => ({
            complete: false,
            failed: false,
            fingerprints: ["fp:test:one"],
          }),
        );

        const wf = makeWorkflow({
          A: makeStep({
            completion_check: {
              worker: "CLAUDE_CODE",
              instructions: "check",
              capabilities: ["READ"],
            },
            max_iterations: 10,
            on_iterations_exhausted: "abort",
            convergence: {
              enabled: true,
              stall_threshold: 2,
              max_stage: 3,
              fail_on_max_stage: true,
            },
          }),
        });

        const ctxDir = path.join(dir, "context");
        const ctx = new ContextManager(ctxDir);
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.FAILED);
        expect(result.steps["A"]!.status).toBe(StepStatus.FAILED);
        expect(result.steps["A"]!.iteration).toBe(4);
        expect(result.steps["A"]!.convergenceStage).toBe(3);
        expect(instructionsByIter.length).toBe(4);
        expect(instructionsByIter[0]!).not.toContain("[Convergence Controller]");
        expect(instructionsByIter[2]!).toContain("[Convergence Controller]");

        const stateJson = await readFile(
          path.join(ctxDir, "A", "_convergence", "state.json"),
          "utf-8",
        );
        const parsed = JSON.parse(stateJson) as { stage?: number };
        expect(parsed.stage).toBeDefined();
      });
    });

    it("forces INCOMPLETE when allowed_paths is violated (even if check says complete)", async () => {
      await withTempDir(async (dir) => {
        await runCmd(dir, ["git", "init"]);
        await writeFile(path.join(dir, "README.md"), "init\n", "utf-8");
        await runCmd(dir, ["git", "add", "README.md"]);
        await runCmd(dir, [
          "git",
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "init",
        ]);

        const runner = new MockStepRunner(
          async () => {
            // Create an out-of-scope untracked file.
            await writeFile(path.join(dir, "outside.txt"), "oops\n", "utf-8");
            return { status: "SUCCEEDED" };
          },
          async () => ({ complete: true, failed: false }),
        );

        const wf = makeWorkflow({
          A: makeStep({
            completion_check: {
              worker: "CLAUDE_CODE",
              instructions: "check",
              capabilities: ["READ"],
            },
            max_iterations: 2,
            on_iterations_exhausted: "abort",
            convergence: {
              enabled: true,
              stall_threshold: 99,
              max_stage: 3,
              fail_on_max_stage: true,
              allowed_paths: ["README.md"],
            },
          }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.FAILED);
        expect(result.steps["A"]!.iteration).toBe(2);
        expect(result.steps["A"]!.error).toContain("Max iterations exhausted");
      });
    });
  });

  // -----------------------------------------------------------------------
  // max_iterations exhausted + abort
  // -----------------------------------------------------------------------
  describe("max_iterations exhausted + abort", () => {
    it("fails when max_iterations reached with abort policy", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(
          async () => ({ status: "SUCCEEDED" }),
          async () => ({ complete: false, failed: false }), // never complete
        );

        const wf = makeWorkflow({
          A: makeStep({
            completion_check: {
              worker: "CLAUDE_CODE",
              instructions: "check",
              capabilities: ["READ"],
            },
            max_iterations: 3,
            on_iterations_exhausted: "abort",
          }),
          B: makeStep({ depends_on: ["A"] }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.FAILED);
        expect(result.steps["A"]!.status).toBe(StepStatus.FAILED);
        expect(result.steps["B"]!.status).toBe(StepStatus.SKIPPED);
      });
    });
  });

  // -----------------------------------------------------------------------
  // max_iterations exhausted + continue
  // -----------------------------------------------------------------------
  describe("max_iterations exhausted + continue", () => {
    it("marks step INCOMPLETE and allows downstream to proceed", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(
          async () => ({ status: "SUCCEEDED" }),
          async () => ({ complete: false, failed: false }), // never complete
        );

        const wf = makeWorkflow({
          A: makeStep({
            completion_check: {
              worker: "CLAUDE_CODE",
              instructions: "check",
              capabilities: ["READ"],
            },
            max_iterations: 2,
            on_iterations_exhausted: "continue",
          }),
          B: makeStep({ depends_on: ["A"] }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);
        expect(result.steps["A"]!.status).toBe(StepStatus.INCOMPLETE);
        expect(result.steps["B"]!.status).toBe(StepStatus.SUCCEEDED);
      });
    });
  });

  // -----------------------------------------------------------------------
  // on_failure: retry (fails then succeeds)
  // -----------------------------------------------------------------------
  describe("on_failure: retry", () => {
    it("retries on failure and succeeds on subsequent attempt", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(async (_stepId, _step, callIndex) => {
          if (callIndex === 1) {
            return {
              status: "FAILED",
              errorClass: ErrorClass.RETRYABLE_TRANSIENT,
            };
          }
          return { status: "SUCCEEDED" };
        });

        const wf = makeWorkflow({
          A: makeStep({
            on_failure: "retry",
            max_retries: 2,
          }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);
        expect(result.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
        // Should have been called twice (fail + succeed)
        expect(runner.stepCalls.length).toBe(2);
      });
    });

    it("marks FAILED when retries exhausted", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(async () => ({
          status: "FAILED",
          errorClass: ErrorClass.RETRYABLE_TRANSIENT,
        }));

        const wf = makeWorkflow({
          A: makeStep({
            on_failure: "retry",
            max_retries: 2,
          }),
          B: makeStep({ depends_on: ["A"] }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.FAILED);
        expect(result.steps["A"]!.status).toBe(StepStatus.FAILED);
        expect(result.steps["B"]!.status).toBe(StepStatus.SKIPPED);
        // 1 initial + 2 retries = 3
        expect(runner.stepCalls.length).toBe(3);
      });
    });
  });

  // -----------------------------------------------------------------------
  // on_failure: abort (step fails, downstream SKIPPED)
  // -----------------------------------------------------------------------
  describe("on_failure: abort", () => {
    it("skips downstream steps when a step fails with abort policy", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(async (stepId) => {
          if (stepId === "B") {
            return {
              status: "FAILED",
              errorClass: ErrorClass.NON_RETRYABLE,
            };
          }
          return { status: "SUCCEEDED" };
        });

        const wf = makeWorkflow({
          A: makeStep(),
          B: makeStep({ depends_on: ["A"], on_failure: "abort" }),
          C: makeStep({ depends_on: ["B"] }),
          D: makeStep({ depends_on: ["C"] }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.FAILED);
        expect(result.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(result.steps["B"]!.status).toBe(StepStatus.FAILED);
        expect(result.steps["C"]!.status).toBe(StepStatus.SKIPPED);
        expect(result.steps["D"]!.status).toBe(StepStatus.SKIPPED);
      });
    });
  });

  // -----------------------------------------------------------------------
  // on_failure: continue (step fails, downstream runs)
  // -----------------------------------------------------------------------
  describe("on_failure: continue", () => {
    it("allows downstream steps to run despite failure", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(async (stepId) => {
          if (stepId === "A") {
            return {
              status: "FAILED",
              errorClass: ErrorClass.NON_RETRYABLE,
            };
          }
          return { status: "SUCCEEDED" };
        });

        const wf = makeWorkflow({
          A: makeStep({ on_failure: "continue" }),
          B: makeStep({ depends_on: ["A"] }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.FAILED);
        expect(result.steps["A"]!.status).toBe(StepStatus.FAILED);
        expect(result.steps["B"]!.status).toBe(StepStatus.SUCCEEDED);
      });
    });
  });

  // -----------------------------------------------------------------------
  // ErrorClass.FATAL overrides on_failure setting
  // -----------------------------------------------------------------------
  describe("ErrorClass.FATAL", () => {
    it("overrides on_failure: continue and aborts the workflow", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(async (stepId) => {
          if (stepId === "A") {
            return {
              status: "FAILED",
              errorClass: ErrorClass.FATAL,
            };
          }
          return { status: "SUCCEEDED" };
        });

        const wf = makeWorkflow({
          A: makeStep({ on_failure: "continue" }),
          B: makeStep({ depends_on: ["A"] }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.FAILED);
        expect(result.steps["A"]!.status).toBe(StepStatus.FAILED);
        expect(result.steps["B"]!.status).toBe(StepStatus.SKIPPED);
      });
    });

    it("overrides on_failure: retry and aborts without retrying", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(async () => ({
          status: "FAILED",
          errorClass: ErrorClass.FATAL,
        }));

        const wf = makeWorkflow({
          A: makeStep({ on_failure: "retry", max_retries: 5 }),
          B: makeStep({ depends_on: ["A"] }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.FAILED);
        expect(result.steps["A"]!.status).toBe(StepStatus.FAILED);
        expect(result.steps["B"]!.status).toBe(StepStatus.SKIPPED);
        // Only called once — no retries
        expect(runner.stepCalls.length).toBe(1);
      });
    });
  });

  // -----------------------------------------------------------------------
  // Workflow timeout cancels running steps
  // -----------------------------------------------------------------------
  describe("workflow timeout", () => {
    it("cancels running steps and marks workflow TIMED_OUT", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(
          async (stepId, _step, _callIndex, abortSignal) => {
            if (stepId === "A") {
              // Wait until aborted by the workflow timeout
              await new Promise<void>((resolve) => {
                if (abortSignal.aborted) {
                  resolve();
                  return;
                }
                abortSignal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
            }
            return { status: "SUCCEEDED" };
          },
        );

        const wf = makeWorkflow(
          {
            A: makeStep(),
            B: makeStep({ depends_on: ["A"] }),
          },
          { timeout: "1s" },
        );

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.TIMED_OUT);
        // B should be skipped (never started)
        const bStatus = result.steps["B"]!.status;
        expect([StepStatus.SKIPPED, StepStatus.CANCELLED]).toContain(bStatus);
      });
    });
  });

  // -----------------------------------------------------------------------
  // Concurrency limit
  // -----------------------------------------------------------------------
  describe("concurrency limit", () => {
    it("respects concurrency limit of 1", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(async () => {
          // Small delay to allow overlap detection
          await new Promise((r) => setTimeout(r, 10));
          return { status: "SUCCEEDED" };
        });

        const wf = makeWorkflow(
          {
            A: makeStep(),
            B: makeStep(),
            C: makeStep(),
          },
          { concurrency: 1 },
        );

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);
        // With concurrency 1, at most 1 step should run at a time
        expect(runner.maxConcurrentObserved).toBe(1);
      });
    });

    it("allows multiple parallel steps with higher concurrency", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { status: "SUCCEEDED" };
        });

        const wf = makeWorkflow(
          {
            A: makeStep(),
            B: makeStep(),
            C: makeStep(),
          },
          { concurrency: 3 },
        );

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);
        // All 3 should run in parallel
        expect(runner.maxConcurrentObserved).toBeGreaterThanOrEqual(2);
      });
    });
  });

  // -----------------------------------------------------------------------
  // DAG validation errors
  // -----------------------------------------------------------------------
  describe("DAG validation", () => {
    it("throws on cyclic dependencies", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner();
        const wf = makeWorkflow({
          A: makeStep({ depends_on: ["B"] }),
          B: makeStep({ depends_on: ["A"] }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);

        await expect(executor.execute()).rejects.toThrow(
          "Workflow DAG validation failed",
        );
      });
    });
  });

  // -----------------------------------------------------------------------
  // Completion check - checker failure
  // -----------------------------------------------------------------------
  describe("completion check failure", () => {
    it("marks step FAILED when completion checker itself fails", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(
          async () => ({ status: "SUCCEEDED" }),
          async () => ({ complete: false, failed: true }),
        );

        const wf = makeWorkflow({
          A: makeStep({
            on_failure: "abort",
            completion_check: {
              worker: "CLAUDE_CODE",
              instructions: "check",
              capabilities: ["READ"],
            },
            max_iterations: 3,
          }),
          B: makeStep({ depends_on: ["A"] }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.FAILED);
        expect(result.steps["A"]!.status).toBe(StepStatus.FAILED);
        expect(result.steps["B"]!.status).toBe(StepStatus.SKIPPED);
      });
    });
  });

  // -----------------------------------------------------------------------
  // Default on_failure is abort
  // -----------------------------------------------------------------------
  describe("default on_failure", () => {
    it("defaults to abort when on_failure is not specified", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(async (stepId) => {
          if (stepId === "A") {
            return {
              status: "FAILED",
              errorClass: ErrorClass.NON_RETRYABLE,
            };
          }
          return { status: "SUCCEEDED" };
        });

        const wf = makeWorkflow({
          A: makeStep(), // no on_failure specified
          B: makeStep({ depends_on: ["A"] }),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.FAILED);
        expect(result.steps["A"]!.status).toBe(StepStatus.FAILED);
        expect(result.steps["B"]!.status).toBe(StepStatus.SKIPPED);
      });
    });
  });

  // -----------------------------------------------------------------------
  // No dependencies — all steps run immediately
  // -----------------------------------------------------------------------
  describe("no dependencies", () => {
    it("runs all independent steps", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner(async () => ({
          status: "SUCCEEDED",
        }));

        const wf = makeWorkflow({
          A: makeStep(),
          B: makeStep(),
          C: makeStep(),
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);
        expect(result.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(result.steps["B"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(result.steps["C"]!.status).toBe(StepStatus.SUCCEEDED);
      });
    });
  });

  // -----------------------------------------------------------------------
  // Input/output resolution
  // -----------------------------------------------------------------------
  describe("input/output resolution", () => {
    it("resolves inputs before running the step", async () => {
      await withTempDir(async (dir) => {
        const ctxDir = path.join(dir, "context");
        const ctx = new ContextManager(ctxDir);

        // Pre-populate an artifact from a "producer" step
        await ctx.initWorkflow("test-wf", "test");
        await ctx.initStep("producer");
        const { writeFile: wf, mkdir: mkd } = await import("node:fs/promises");
        const artifactDir = path.join(ctxDir, "producer", "result");
        await mkd(artifactDir, { recursive: true });
        await wf(path.join(artifactDir, "data.txt"), "hello from producer");

        let receivedInputData = "";
        const runner = new MockStepRunner(async (stepId) => {
          if (stepId === "consumer") {
            // Read the file that should have been copied by resolveInputs
            const { readFile: rf } = await import("node:fs/promises");
            try {
              receivedInputData = await rf(path.join(dir, "result", "data.txt"), "utf-8");
            } catch {
              receivedInputData = "NOT_FOUND";
            }
          }
          return { status: "SUCCEEDED" };
        });

        const wfDef = makeWorkflow({
          producer: makeStep(),
          consumer: makeStep({
            depends_on: ["producer"],
            inputs: [{ from: "producer", artifact: "result" }],
          }),
        });

        const executor = new WorkflowExecutor(wfDef, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);
        expect(receivedInputData).toBe("hello from producer");
      });
    });

    it("collects outputs after step succeeds", async () => {
      await withTempDir(async (dir) => {
        const ctxDir = path.join(dir, "context");
        const ctx = new ContextManager(ctxDir);

        const { writeFile: wf, mkdir: mkd, stat: st } = await import("node:fs/promises");

        const runner = new MockStepRunner(async (stepId) => {
          if (stepId === "builder") {
            // Create an output file in the workspace
            const outputDir = path.join(dir, "build-output");
            await mkd(outputDir, { recursive: true });
            await wf(path.join(outputDir, "artifact.txt"), "built output");
          }
          return { status: "SUCCEEDED" };
        });

        const wfDef = makeWorkflow({
          builder: makeStep({
            outputs: [{ name: "build", path: "build-output" }],
          }),
        });

        const executor = new WorkflowExecutor(wfDef, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);

        // Verify the output was collected into the context dir
        const collectedPath = path.join(ctxDir, "builder", "build");
        const collectedStat = await st(collectedPath).catch(() => null);
        expect(collectedStat).not.toBeNull();
        expect(collectedStat!.isDirectory()).toBe(true);
      });
    });

    it("skips input resolution when step has no inputs", async () => {
      await withTempDir(async (dir) => {
        const ctxDir = path.join(dir, "context");
        const ctx = new ContextManager(ctxDir);
        const runner = new MockStepRunner();

        const wfDef = makeWorkflow({
          A: makeStep(), // no inputs
        });

        const executor = new WorkflowExecutor(wfDef, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);
      });
    });
  });

  // -----------------------------------------------------------------------
  // WorkflowState shape
  // -----------------------------------------------------------------------
  describe("WorkflowState shape", () => {
    it("returns correct metadata fields", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner();
        const wf = makeWorkflow({ A: makeStep() });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.workflowId).toBeDefined();
        expect(result.name).toBe("test-workflow");
        expect(result.startedAt).toBeGreaterThan(0);
        expect(result.completedAt).toBeGreaterThan(0);
        expect(result.completedAt!).toBeGreaterThanOrEqual(result.startedAt);
        expect(result.steps["A"]!.startedAt).toBeGreaterThan(0);
        expect(result.steps["A"]!.completedAt).toBeGreaterThan(0);
      });
    });
  });

  // -----------------------------------------------------------------------
  // Workflow metadata persistence
  // -----------------------------------------------------------------------
  describe("_workflow.json terminal status", () => {
    it("writes SUCCEEDED at workflow completion", async () => {
      await withTempDir(async (dir) => {
        const runner = new MockStepRunner();
        const wf = makeWorkflow({ A: makeStep() });
        const ctxDir = path.join(dir, "context");

        const ctx = new ContextManager(ctxDir);
        const executor = new WorkflowExecutor(wf, ctx, runner, dir);
        const result = await executor.execute();

        const content = JSON.parse(
          await readFile(path.join(ctxDir, "_workflow.json"), "utf-8"),
        ) as Record<string, unknown>;

        expect(content["id"]).toBe(result.workflowId);
        expect(content["name"]).toBe("test-workflow");
        expect(content["status"]).toBe(WorkflowStatus.SUCCEEDED);
        expect(typeof content["startedAt"]).toBe("number");
        expect(typeof content["completedAt"]).toBe("number");
        expect((content["completedAt"] as number)).toBeGreaterThanOrEqual(
          content["startedAt"] as number,
        );
      });
    });

    it("writes CANCELLED when externally aborted", async () => {
      await withTempDir(async (dir) => {
        const abortCtrl = new AbortController();
        const runner = new MockStepRunner(
          async (_stepId, _step, _callIndex, abortSignal) => {
            await new Promise<void>((resolve) => {
              if (abortSignal.aborted) {
                resolve();
                return;
              }
              abortSignal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            return { status: "SUCCEEDED" };
          },
        );

        const wf = makeWorkflow({ A: makeStep() }, { timeout: "2m" });
        const ctxDir = path.join(dir, "context");
        const ctx = new ContextManager(ctxDir);
        const executor = new WorkflowExecutor(
          wf,
          ctx,
          runner,
          dir,
          undefined,
          abortCtrl.signal,
        );

        const runPromise = executor.execute();

        // Let the step start before aborting.
        for (let i = 0; i < 20 && runner.stepCalls.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 10));
        }
        abortCtrl.abort();

        const result = await runPromise;
        expect(result.status).toBe(WorkflowStatus.CANCELLED);

        const content = JSON.parse(
          await readFile(path.join(ctxDir, "_workflow.json"), "utf-8"),
        ) as Record<string, unknown>;
        expect(content["status"]).toBe(WorkflowStatus.CANCELLED);
        expect(typeof content["completedAt"]).toBe("number");
      });
    });
  });
});
