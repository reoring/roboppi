/**
 * AT-7: Concurrency control acceptance tests.
 */
import { describe, it, expect } from "bun:test";
import { MockStepRunner, withTempDir, executeYaml } from "./helpers.js";
import { WorkflowStatus, StepStatus } from "../../src/workflow/types.js";

// ---------------------------------------------------------------------------
// Helper: create a minimal step YAML block
// ---------------------------------------------------------------------------
function step(id: string, deps?: string[]): string {
  const depsLine = deps && deps.length > 0
    ? `\n      depends_on: [${deps.map((d) => `"${d}"`).join(", ")}]`
    : "";
  return `
    ${id}:
      worker: CUSTOM
      instructions: "Run ${id}"
      capabilities: [READ]${depsLine}`;
}

describe("AT-7: Concurrency control", () => {
  // -------------------------------------------------------------------------
  // AT-7.1: concurrency: 1 forces sequential execution
  // -------------------------------------------------------------------------
  describe("AT-7.1: concurrency: 1 forces sequential", () => {
    it("only one step runs at a time (maxConcurrentObserved = 1)", async () => {
      const runner = new MockStepRunner(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { status: "SUCCEEDED" };
      });

      const yaml = `
name: seq-concurrency
version: "1"
timeout: "30s"
concurrency: 1
steps:${step("A")}${step("B")}${step("C")}
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);
        expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
        expect(runner.maxConcurrentObserved).toBe(1);
        for (const id of ["A", "B", "C"]) {
          expect(state.steps[id]!.status).toBe(StepStatus.SUCCEEDED);
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // AT-7.2: concurrency: 2 with 4 steps
  // -------------------------------------------------------------------------
  describe("AT-7.2: concurrency: 2 with 4 steps", () => {
    it("at most 2 steps run simultaneously", async () => {
      const runner = new MockStepRunner(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { status: "SUCCEEDED" };
      });

      const yaml = `
name: limited-concurrency
version: "1"
timeout: "30s"
concurrency: 2
steps:${step("A")}${step("B")}${step("C")}${step("D")}
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);
        expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
        expect(runner.maxConcurrentObserved).toBeLessThanOrEqual(2);
        expect(runner.maxConcurrentObserved).toBeGreaterThanOrEqual(1);
        for (const id of ["A", "B", "C", "D"]) {
          expect(state.steps[id]!.status).toBe(StepStatus.SUCCEEDED);
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // AT-7.3: No concurrency limit (default unlimited)
  // -------------------------------------------------------------------------
  describe("AT-7.3: No concurrency limit (default unlimited)", () => {
    it("all independent steps can run simultaneously", async () => {
      const runner = new MockStepRunner(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { status: "SUCCEEDED" };
      });

      const yaml = `
name: unlimited-concurrency
version: "1"
timeout: "30s"
steps:${step("A")}${step("B")}${step("C")}${step("D")}${step("E")}
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);
        expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
        // With 5 independent steps and no limit, all should overlap
        expect(runner.maxConcurrentObserved).toBeGreaterThanOrEqual(4);
        for (const id of ["A", "B", "C", "D", "E"]) {
          expect(state.steps[id]!.status).toBe(StepStatus.SUCCEEDED);
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // AT-7.4: concurrency + DAG dependencies interaction
  // -------------------------------------------------------------------------
  describe("AT-7.4: concurrency + DAG dependencies interaction", () => {
    it("A -> {B, C, D} with concurrency: 2 — at most 2 of B/C/D run at once", async () => {
      const executionOrder: string[] = [];
      const runner = new MockStepRunner(async (stepId) => {
        executionOrder.push(stepId);
        await new Promise((r) => setTimeout(r, 20));
        return { status: "SUCCEEDED" };
      });

      const yaml = `
name: dag-with-concurrency
version: "1"
timeout: "30s"
concurrency: 2
steps:${step("A")}${step("B", ["A"])}${step("C", ["A"])}${step("D", ["A"])}
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);

        expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
        // A must be first
        expect(executionOrder[0]).toBe("A");
        // Max concurrent must not exceed 2
        expect(runner.maxConcurrentObserved).toBeLessThanOrEqual(2);
        // All steps should succeed
        for (const id of ["A", "B", "C", "D"]) {
          expect(state.steps[id]!.status).toBe(StepStatus.SUCCEEDED);
        }
      });
    });
  });
});
