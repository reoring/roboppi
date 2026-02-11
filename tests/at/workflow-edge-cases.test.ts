/**
 * AT-9: Edge cases
 */
import { describe, it, expect } from "bun:test";
import { stat } from "node:fs/promises";
import { parseWorkflow } from "../../src/workflow/parser.js";
import { validateDag } from "../../src/workflow/dag-validator.js";
import { WorkflowStatus, StepStatus } from "../../src/workflow/types.js";
import { ErrorClass } from "../../src/types/common.js";
import {
  MockStepRunner,
  withTempDir,
  executeYaml,
  path,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// AT-9.1 — Single step workflow
// ---------------------------------------------------------------------------
describe("AT-9.1: single step workflow", () => {
  const yaml = `
name: single-step
version: "1"
timeout: "5m"
steps:
  only:
    worker: CODEX_CLI
    instructions: "do the thing"
    capabilities: [READ]
`;

  it("parses and validates successfully", () => {
    const def = parseWorkflow(yaml);
    const errors = validateDag(def);
    expect(errors).toEqual([]);
  });

  it("executes and completes", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(async () => ({ status: "SUCCEEDED" }));
      const { state } = await executeYaml(yaml, runner, dir);
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(state.steps["only"]!.status).toBe(StepStatus.SUCCEEDED);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-9.2 — Step with no outputs
// ---------------------------------------------------------------------------
describe("AT-9.2: step with no outputs", () => {
  const yaml = `
name: no-outputs
version: "1"
timeout: "5m"
steps:
  first:
    worker: CODEX_CLI
    instructions: "do first"
    capabilities: [READ]
  second:
    worker: CODEX_CLI
    depends_on: [first]
    instructions: "do second"
    capabilities: [READ]
`;

  it("context/<stepId>/ directories are created", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(async () => ({ status: "SUCCEEDED" }));
      const { contextDir } = await executeYaml(yaml, runner, dir);

      for (const stepId of ["first", "second"]) {
        const s = await stat(path.join(contextDir, stepId)).catch(() => null);
        expect(s).not.toBeNull();
        expect(s!.isDirectory()).toBe(true);
      }
    });
  });

  it("subsequent steps execute normally", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(async () => ({ status: "SUCCEEDED" }));
      const { state } = await executeYaml(yaml, runner, dir);
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(state.steps["first"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.steps["second"]!.status).toBe(StepStatus.SUCCEEDED);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-9.3 — Same output path from multiple steps
// ---------------------------------------------------------------------------
describe("AT-9.3: same output path from multiple steps", () => {
  const yaml = `
name: same-path
version: "1"
timeout: "5m"
steps:
  A:
    worker: CODEX_CLI
    instructions: "write code"
    capabilities: [READ, EDIT]
    outputs:
      - name: code
        path: "src/main.ts"
  B:
    worker: CODEX_CLI
    instructions: "write code too"
    capabilities: [READ, EDIT]
    outputs:
      - name: code
        path: "src/main.ts"
`;

  it("parses and validates without errors", () => {
    const def = parseWorkflow(yaml);
    const errors = validateDag(def);
    expect(errors).toEqual([]);
  });

  it("each step gets independent context directory", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(async () => ({ status: "SUCCEEDED" }));
      const { contextDir } = await executeYaml(yaml, runner, dir);

      // Both step context directories should be independent
      const aStat = await stat(path.join(contextDir, "A")).catch(() => null);
      const bStat = await stat(path.join(contextDir, "B")).catch(() => null);
      expect(aStat).not.toBeNull();
      expect(bStat).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// AT-9.4 — Very long step ID (200 chars)
// ---------------------------------------------------------------------------
describe("AT-9.4: very long step ID", () => {
  const longId = "a".repeat(200);

  const yaml = `
name: long-id
version: "1"
timeout: "5m"
steps:
  ${longId}:
    worker: CODEX_CLI
    instructions: "do"
    capabilities: [READ]
`;

  it("parses, validates, and executes without error", async () => {
    const def = parseWorkflow(yaml);
    const errors = validateDag(def);
    expect(errors).toEqual([]);

    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(async () => ({ status: "SUCCEEDED" }));
      const { state } = await executeYaml(yaml, runner, dir);
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(state.steps[longId]!.status).toBe(StepStatus.SUCCEEDED);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-9.5 — Special characters in instructions
// ---------------------------------------------------------------------------
describe("AT-9.5: special characters in instructions", () => {
  it("multiline, emoji, backslash are preserved", () => {
    const yaml = `
name: special-chars
version: "1"
timeout: "5m"
steps:
  special:
    worker: CODEX_CLI
    instructions: |
      Line one
      Emoji: 🚀🔥
      Backslash: C:\\Users\\test
    capabilities: [READ]
`;
    const def = parseWorkflow(yaml);
    const instructions = def.steps["special"]!.instructions;
    expect(instructions).toContain("Line one");
    expect(instructions).toContain("🚀🔥");
    expect(instructions).toContain("C:\\Users\\test");
  });
});

// ---------------------------------------------------------------------------
// AT-9.6 — All steps SKIPPED due to first failure (abort)
// ---------------------------------------------------------------------------
describe("AT-9.6: all dependents SKIPPED when first step fails with abort", () => {
  const yaml = `
name: all-skipped
version: "1"
timeout: "5m"
steps:
  A:
    worker: CODEX_CLI
    instructions: "do A"
    capabilities: [READ]
    on_failure: abort
  B:
    worker: CODEX_CLI
    depends_on: [A]
    instructions: "do B"
    capabilities: [READ]
  C:
    worker: CODEX_CLI
    depends_on: [A]
    instructions: "do C"
    capabilities: [READ]
  D:
    worker: CODEX_CLI
    depends_on: [A]
    instructions: "do D"
    capabilities: [READ]
`;

  it("workflow is FAILED, B/C/D are all SKIPPED", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(async (stepId) => {
        if (stepId === "A") {
          return { status: "FAILED", errorClass: ErrorClass.NON_RETRYABLE };
        }
        return { status: "SUCCEEDED" };
      });
      const { state } = await executeYaml(yaml, runner, dir);
      expect(state.status).toBe(WorkflowStatus.FAILED);
      expect(state.steps["A"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["B"]!.status).toBe(StepStatus.SKIPPED);
      expect(state.steps["C"]!.status).toBe(StepStatus.SKIPPED);
      expect(state.steps["D"]!.status).toBe(StepStatus.SKIPPED);
    });
  });
});
