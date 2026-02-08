/**
 * AT-2: DAG execution topology acceptance tests.
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

describe("AT-2: DAG execution topology", () => {
  // -------------------------------------------------------------------------
  // AT-2.1: Linear chain A -> B -> C -> D
  // -------------------------------------------------------------------------
  describe("AT-2.1: Linear chain (A -> B -> C -> D)", () => {
    it("executes steps in strict order [A, B, C, D]", async () => {
      const executionOrder: string[] = [];
      const runner = new MockStepRunner(async (stepId) => {
        executionOrder.push(stepId);
        return { status: "SUCCEEDED" };
      });

      const yaml = `
name: linear-chain
version: "1"
timeout: "30s"
steps:${step("A")}${step("B", ["A"])}${step("C", ["B"])}${step("D", ["C"])}
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);

        expect(executionOrder).toEqual(["A", "B", "C", "D"]);
        expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
        for (const id of ["A", "B", "C", "D"]) {
          expect(state.steps[id]!.status).toBe(StepStatus.SUCCEEDED);
        }
      });
    });

    it("each step starts only after predecessor SUCCEEDED", async () => {
      const executionOrder: string[] = [];
      const runner = new MockStepRunner(async (stepId) => {
        executionOrder.push(stepId);
        return { status: "SUCCEEDED" };
      });

      const yaml = `
name: linear-chain-check
version: "1"
timeout: "30s"
steps:${step("A")}${step("B", ["A"])}${step("C", ["B"])}${step("D", ["C"])}
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);
        expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
        // Sequential order proves predecessors completed before successors ran
        expect(executionOrder).toEqual(["A", "B", "C", "D"]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // AT-2.2: Diamond (A -> {B, C} -> D)
  // -------------------------------------------------------------------------
  describe("AT-2.2: Diamond (A -> {B, C} -> D)", () => {
    it("B and C run after A; D runs after both B and C", async () => {
      const executionOrder: string[] = [];
      const runner = new MockStepRunner(async (stepId) => {
        executionOrder.push(stepId);
        // Small delay so B and C can overlap
        await new Promise((r) => setTimeout(r, 20));
        return { status: "SUCCEEDED" };
      });

      const yaml = `
name: diamond
version: "1"
timeout: "30s"
steps:${step("A")}${step("B", ["A"])}${step("C", ["A"])}${step("D", ["B", "C"])}
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);

        // A must be first
        expect(executionOrder[0]).toBe("A");
        // D must be last
        expect(executionOrder[3]).toBe("D");
        // B and C in the middle (order between them is non-deterministic)
        expect(executionOrder.slice(1, 3).sort()).toEqual(["B", "C"]);
        expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      });
    });

    it("observes concurrent execution of B and C (maxConcurrentObserved >= 2)", async () => {
      const runner = new MockStepRunner(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { status: "SUCCEEDED" };
      });

      const yaml = `
name: diamond-concurrency
version: "1"
timeout: "30s"
steps:${step("A")}${step("B", ["A"])}${step("C", ["A"])}${step("D", ["B", "C"])}
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);
        expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
        expect(runner.maxConcurrentObserved).toBeGreaterThanOrEqual(2);
      });
    });
  });

  // -------------------------------------------------------------------------
  // AT-2.3: Wide fan-out (A -> {B, C, D, E})
  // -------------------------------------------------------------------------
  describe("AT-2.3: Wide fan-out (A -> {B, C, D, E})", () => {
    it("all 4 fan-out steps run in parallel (no concurrency limit)", async () => {
      const runner = new MockStepRunner(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { status: "SUCCEEDED" };
      });

      const yaml = `
name: wide-fanout
version: "1"
timeout: "30s"
steps:${step("A")}${step("B", ["A"])}${step("C", ["A"])}${step("D", ["A"])}${step("E", ["A"])}
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);
        expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
        // All 4 fan-out steps should be able to run simultaneously
        expect(runner.maxConcurrentObserved).toBeGreaterThanOrEqual(4);
      });
    });

    it("concurrency: 2 limits simultaneous fan-out steps to 2", async () => {
      const runner = new MockStepRunner(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { status: "SUCCEEDED" };
      });

      const yaml = `
name: wide-fanout-limited
version: "1"
timeout: "30s"
concurrency: 2
steps:${step("A")}${step("B", ["A"])}${step("C", ["A"])}${step("D", ["A"])}${step("E", ["A"])}
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);
        expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
        expect(runner.maxConcurrentObserved).toBeLessThanOrEqual(2);
      });
    });
  });

  // -------------------------------------------------------------------------
  // AT-2.4: Independent steps (A, B, C with no deps)
  // -------------------------------------------------------------------------
  describe("AT-2.4: Independent steps (A, B, C no deps)", () => {
    it("all steps run in parallel", async () => {
      const runner = new MockStepRunner(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { status: "SUCCEEDED" };
      });

      const yaml = `
name: independent
version: "1"
timeout: "30s"
steps:${step("A")}${step("B")}${step("C")}
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);
        expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
        expect(runner.maxConcurrentObserved).toBeGreaterThanOrEqual(3);
      });
    });

    it("failure of one does not affect others (on_failure: continue)", async () => {
      const runner = new MockStepRunner(async (stepId) => {
        await new Promise((r) => setTimeout(r, 20));
        if (stepId === "B") return { status: "FAILED" };
        return { status: "SUCCEEDED" };
      });

      const yaml = `
name: independent-fail
version: "1"
timeout: "30s"
steps:
    A:
      worker: CUSTOM
      instructions: "Run A"
      capabilities: [READ]
    B:
      worker: CUSTOM
      instructions: "Run B"
      capabilities: [READ]
      on_failure: continue
    C:
      worker: CUSTOM
      instructions: "Run C"
      capabilities: [READ]
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);
        expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(state.steps["B"]!.status).toBe(StepStatus.FAILED);
        expect(state.steps["C"]!.status).toBe(StepStatus.SUCCEEDED);
      });
    });
  });

  // -------------------------------------------------------------------------
  // AT-2.5: Deep chain (10 steps)
  // -------------------------------------------------------------------------
  describe("AT-2.5: Deep chain (A -> B -> ... -> J, 10 steps)", () => {
    const letters: string[] = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

    it("all 10 steps execute in strict order", async () => {
      const executionOrder: string[] = [];
      const runner = new MockStepRunner(async (stepId) => {
        executionOrder.push(stepId);
        return { status: "SUCCEEDED" };
      });

      let stepsYaml = "";
      for (let i = 0; i < letters.length; i++) {
        const id = letters[i]!;
        const deps = i > 0 ? [letters[i - 1]!] : undefined;
        stepsYaml += step(id, deps);
      }

      const yaml = `
name: deep-chain
version: "1"
timeout: "30s"
steps:${stepsYaml}
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);
        expect(executionOrder).toEqual([...letters]);
        expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      });
    });

    it("mid-chain failure skips all subsequent steps (on_failure: abort)", async () => {
      const executionOrder: string[] = [];
      const runner = new MockStepRunner(async (stepId) => {
        executionOrder.push(stepId);
        if (stepId === "E") return { status: "FAILED" };
        return { status: "SUCCEEDED" };
      });

      let stepsYaml = "";
      for (let i = 0; i < letters.length; i++) {
        const id = letters[i]!;
        const depLine = i > 0 ? `\n      depends_on: ["${letters[i - 1]!}"]` : "";
        stepsYaml += `
    ${id}:
      worker: CUSTOM
      instructions: "Run ${id}"
      capabilities: [READ]${depLine}
      on_failure: abort`;
      }

      const yaml = `
name: deep-chain-fail
version: "1"
timeout: "30s"
steps:${stepsYaml}
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);
        expect(state.status).toBe(WorkflowStatus.FAILED);

        // A-D should have succeeded
        for (const id of ["A", "B", "C", "D"]) {
          expect(state.steps[id]!.status).toBe(StepStatus.SUCCEEDED);
        }
        // E should be failed
        expect(state.steps["E"]!.status).toBe(StepStatus.FAILED);
        // F-J should be skipped
        for (const id of ["F", "G", "H", "I", "J"]) {
          expect(state.steps[id]!.status).toBe(StepStatus.SKIPPED);
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // AT-2.6: Complex DAG with multiple join points
  //   A -> B -> D -> F
  //   A -> C -> D
  //   A -> C -> E -> F
  // -------------------------------------------------------------------------
  describe("AT-2.6: Complex DAG (A->B->D->F, A->C->D, A->C->E->F)", () => {
    it("respects all join points in the complex DAG", async () => {
      const executionOrder: string[] = [];
      const runner = new MockStepRunner(async (stepId) => {
        executionOrder.push(stepId);
        await new Promise((r) => setTimeout(r, 20));
        return { status: "SUCCEEDED" };
      });

      const yaml = `
name: complex-dag
version: "1"
timeout: "30s"
steps:
    A:
      worker: CUSTOM
      instructions: "Run A"
      capabilities: [READ]
    B:
      worker: CUSTOM
      instructions: "Run B"
      capabilities: [READ]
      depends_on: ["A"]
    C:
      worker: CUSTOM
      instructions: "Run C"
      capabilities: [READ]
      depends_on: ["A"]
    D:
      worker: CUSTOM
      instructions: "Run D"
      capabilities: [READ]
      depends_on: ["B", "C"]
    E:
      worker: CUSTOM
      instructions: "Run E"
      capabilities: [READ]
      depends_on: ["C"]
    F:
      worker: CUSTOM
      instructions: "Run F"
      capabilities: [READ]
      depends_on: ["D", "E"]
`;

      await withTempDir(async (dir) => {
        const { state } = await executeYaml(yaml, runner, dir);

        expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

        // A must be first
        expect(executionOrder[0]).toBe("A");
        // F must be last
        expect(executionOrder[executionOrder.length - 1]).toBe("F");

        // D must come after both B and C
        const idxB = executionOrder.indexOf("B");
        const idxC = executionOrder.indexOf("C");
        const idxD = executionOrder.indexOf("D");
        const idxE = executionOrder.indexOf("E");
        const idxF = executionOrder.indexOf("F");

        expect(idxD).toBeGreaterThan(idxB);
        expect(idxD).toBeGreaterThan(idxC);

        // E depends only on C
        expect(idxE).toBeGreaterThan(idxC);

        // F must come after both D and E
        expect(idxF).toBeGreaterThan(idxD);
        expect(idxF).toBeGreaterThan(idxE);
      });
    });
  });
});
