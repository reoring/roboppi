/**
 * AT-1: Full pipeline — YAML parse → DAG validate → execute
 */
import { describe, it, expect } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { parseWorkflow, WorkflowParseError } from "../../src/workflow/parser.js";
import { validateDag } from "../../src/workflow/dag-validator.js";
import { WorkflowStatus, StepStatus } from "../../src/workflow/types.js";
import {
  MockStepRunner,
  withTempDir,
  executeYaml,
  writeWorkspaceFile,
  path,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// AT-1.1 — Design doc "implement-review-fix" example runs to completion
// ---------------------------------------------------------------------------
describe("AT-1.1: implement-review-fix full pipeline", () => {
  // Actual YAML from the design doc section 3.1
  const yaml = `
name: implement-review-fix
version: "1"
description: "機能実装後にレビューし、指摘を修正する"
timeout: "1h"
concurrency: 2

steps:
  implement:
    description: "機能の初期実装を行う"
    worker: CODEX_CLI
    instructions: |
      src/feature.ts に新しいユーティリティ関数を追加してください。
      仕様は instructions.md を参照。
    capabilities: [READ, EDIT]
    timeout: "15m"
    max_retries: 1
    on_failure: retry
    outputs:
      - name: implementation
        path: "src/feature.ts"
        type: code

  test:
    description: "実装のテストを実行する"
    worker: CODEX_CLI
    depends_on: [implement]
    instructions: |
      テストスイートを実行し、結果を報告してください。
    capabilities: [READ, RUN_TESTS]
    inputs:
      - from: implement
        artifact: implementation
    timeout: "10m"
    on_failure: continue
    outputs:
      - name: test-report
        path: "test-results.txt"
        type: test-report

  review:
    description: "実装コードをレビューする"
    worker: CLAUDE_CODE
    depends_on: [implement]
    instructions: |
      src/feature.ts のコードレビューを行ってください。
      コード品質、エラーハンドリング、テストの観点で指摘をまとめてください。
    capabilities: [READ]
    inputs:
      - from: implement
        artifact: implementation
    timeout: "10m"
    on_failure: abort
    outputs:
      - name: review-comments
        path: "review.md"
        type: review

  fix:
    description: "レビュー指摘とテスト結果に基づき修正する"
    worker: CODEX_CLI
    depends_on: [review, test]
    instructions: |
      review.md の指摘事項を反映してください。
      テストが失敗していた場合はそれも修正してください。
    capabilities: [READ, EDIT, RUN_TESTS]
    inputs:
      - from: review
        artifact: review-comments
      - from: test
        artifact: test-report
    timeout: "15m"
    max_retries: 2
    on_failure: retry
    outputs:
      - name: fixed-code
        path: "src/feature.ts"
        type: code
`;

  it("1. WorkflowState.status is SUCCEEDED", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(async (stepId, _step, _ci, _abort) => {
        // Write output files so collectOutputs would work
        if (stepId === "implement") {
          await writeWorkspaceFile(dir, "src/feature.ts", "export function foo() {}");
        } else if (stepId === "test") {
          await writeWorkspaceFile(dir, "test-results.txt", "All tests passed");
        } else if (stepId === "review") {
          await writeWorkspaceFile(dir, "review.md", "LGTM");
        }
        return { status: "SUCCEEDED" };
      });
      const { state } = await executeYaml(yaml, runner, dir);
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
    });
  });

  it("2. all steps SUCCEEDED", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(async () => ({ status: "SUCCEEDED" }));
      const { state } = await executeYaml(yaml, runner, dir);
      for (const stepId of ["implement", "test", "review", "fix"]) {
        expect(state.steps[stepId]!.status).toBe(StepStatus.SUCCEEDED);
      }
    });
  });

  it("3. execution order: implement → (test, review parallel) → fix", async () => {
    await withTempDir(async (dir) => {
      const order: string[] = [];
      const runner = new MockStepRunner(async (stepId) => {
        order.push(stepId);
        // Small delay to allow parallel steps to register
        await new Promise((r) => setTimeout(r, 5));
        return { status: "SUCCEEDED" };
      });
      const { state } = await executeYaml(yaml, runner, dir);
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      // implement must be first
      expect(order[0]).toBe("implement");
      // fix must be last
      expect(order[order.length - 1]).toBe("fix");
      // test and review both after implement, before fix
      const implIdx = order.indexOf("implement");
      const testIdx = order.indexOf("test");
      const reviewIdx = order.indexOf("review");
      const fixIdx = order.indexOf("fix");
      expect(testIdx).toBeGreaterThan(implIdx);
      expect(reviewIdx).toBeGreaterThan(implIdx);
      expect(fixIdx).toBeGreaterThan(testIdx);
      expect(fixIdx).toBeGreaterThan(reviewIdx);
    });
  });

  it("4-6. context step directories exist after execution", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(async () => ({ status: "SUCCEEDED" }));
      const { contextDir } = await executeYaml(yaml, runner, dir);

      // The executor calls initStep for each step, creating context/<stepId>/
      for (const stepId of ["implement", "review", "test", "fix"]) {
        const stepDir = path.join(contextDir, stepId);
        const s = await stat(stepDir).catch(() => null);
        expect(s).not.toBeNull();
        expect(s!.isDirectory()).toBe(true);
      }
    });
  });

  it("7. context/_workflow.json exists with correct name", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(async () => ({ status: "SUCCEEDED" }));
      const { contextDir } = await executeYaml(yaml, runner, dir);

      const workflowJsonPath = path.join(contextDir, "_workflow.json");
      const content = await readFile(workflowJsonPath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.name).toBe("implement-review-fix");
    });
  });
});

// ---------------------------------------------------------------------------
// AT-1.2 — Design doc "completion_check loop" example runs to completion
// ---------------------------------------------------------------------------
describe("AT-1.2: implement-from-todo completion_check loop", () => {
  const yaml = `
name: implement-from-todo
version: "1"
description: "todo.md のタスクをすべて完了するまで繰り返し実装する"
timeout: "2h"

steps:
  implement-all:
    description: "todo.md の未完了タスクをすべて実装する"
    worker: CODEX_CLI
    instructions: |
      todo.md を読み、- [ ] でマークされた未完了タスクを1つ選んで実装してください。
      実装が完了したら、該当行を - [x] に更新してください。
    capabilities: [READ, EDIT, RUN_TESTS]
    timeout: "10m"
    max_retries: 1
    on_failure: retry
    completion_check:
      worker: CLAUDE_CODE
      instructions: |
        todo.md を確認してください。
        - [ ] が1つでも残っていれば「未完了」と判定してください。
        すべて - [x] であれば「完了」と判定してください。
      capabilities: [READ]
      timeout: "2m"
    max_iterations: 20
    on_iterations_exhausted: abort
    outputs:
      - name: completed-code
        path: "src/"
        type: code
      - name: final-todo
        path: "todo.md"
        type: review

  verify:
    description: "全タスク完了後にテストを実行"
    worker: CODEX_CLI
    depends_on: [implement-all]
    instructions: "全テストスイートを実行し、結果を報告してください"
    capabilities: [READ, RUN_TESTS]
    inputs:
      - from: implement-all
        artifact: completed-code
    timeout: "10m"
    on_failure: abort
`;

  it("1. WorkflowState.status is SUCCEEDED", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(
        async () => ({ status: "SUCCEEDED" }),
        async (_stepId, _check, callIndex) => ({
          complete: callIndex >= 3,
          failed: false,
        }),
      );
      const { state } = await executeYaml(yaml, runner, dir);
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
    });
  });

  it("2. implement-all iteration is 3", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(
        async () => ({ status: "SUCCEEDED" }),
        async (_stepId, _check, callIndex) => ({
          complete: callIndex >= 3,
          failed: false,
        }),
      );
      const { state } = await executeYaml(yaml, runner, dir);
      expect(state.steps["implement-all"]!.iteration).toBe(3);
    });
  });

  it("3. implement-all status is SUCCEEDED", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(
        async () => ({ status: "SUCCEEDED" }),
        async (_stepId, _check, callIndex) => ({
          complete: callIndex >= 3,
          failed: false,
        }),
      );
      const { state } = await executeYaml(yaml, runner, dir);
      expect(state.steps["implement-all"]!.status).toBe(StepStatus.SUCCEEDED);
    });
  });

  it("4. verify status is SUCCEEDED", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(
        async () => ({ status: "SUCCEEDED" }),
        async (_stepId, _check, callIndex) => ({
          complete: callIndex >= 3,
          failed: false,
        }),
      );
      const { state } = await executeYaml(yaml, runner, dir);
      expect(state.steps["verify"]!.status).toBe(StepStatus.SUCCEEDED);
    });
  });

  it("5. runStep called 3 times for implement-all", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(
        async () => ({ status: "SUCCEEDED" }),
        async (_stepId, _check, callIndex) => ({
          complete: callIndex >= 3,
          failed: false,
        }),
      );
      await executeYaml(yaml, runner, dir);
      expect(runner.getStepCallCount("implement-all")).toBe(3);
    });
  });

  it("6. runCheck called 3 times for implement-all", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(
        async () => ({ status: "SUCCEEDED" }),
        async (_stepId, _check, callIndex) => ({
          complete: callIndex >= 3,
          failed: false,
        }),
      );
      await executeYaml(yaml, runner, dir);
      expect(runner.getCheckCallCount("implement-all")).toBe(3);
    });
  });
});

// ---------------------------------------------------------------------------
// AT-1.3 — Invalid YAML is rejected early
// ---------------------------------------------------------------------------
describe("AT-1.3: invalid YAML is rejected early", () => {
  it("a. version: '2' throws WorkflowParseError", () => {
    const yaml = `
name: bad-version
version: "2"
timeout: "5m"
steps:
  a:
    worker: CODEX_CLI
    instructions: "do"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
  });

  it("b. empty steps object throws WorkflowParseError", () => {
    const yaml = `
name: empty-steps
version: "1"
timeout: "5m"
steps: {}
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
  });

  it("c. invalid worker throws WorkflowParseError", () => {
    const yaml = `
name: bad-worker
version: "1"
timeout: "5m"
steps:
  a:
    worker: "INVALID"
    instructions: "do"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
  });

  it("d. invalid capability throws WorkflowParseError", () => {
    const yaml = `
name: bad-cap
version: "1"
timeout: "5m"
steps:
  a:
    worker: CODEX_CLI
    instructions: "do"
    capabilities: [DESTROY]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
  });

  it("e. completion_check without max_iterations throws WorkflowParseError", () => {
    const yaml = `
name: no-max-iter
version: "1"
timeout: "5m"
steps:
  a:
    worker: CODEX_CLI
    instructions: "do"
    capabilities: [READ]
    completion_check:
      worker: CLAUDE_CODE
      instructions: "check"
      capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
  });

  it("f. completion_check with max_iterations: 1 throws WorkflowParseError", () => {
    const yaml = `
name: bad-max-iter
version: "1"
timeout: "5m"
steps:
  a:
    worker: CODEX_CLI
    instructions: "do"
    capabilities: [READ]
    completion_check:
      worker: CLAUDE_CODE
      instructions: "check"
      capabilities: [READ]
    max_iterations: 1
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
  });

  it("g. invalid on_failure value throws WorkflowParseError", () => {
    const yaml = `
name: bad-on-failure
version: "1"
timeout: "5m"
steps:
  a:
    worker: CODEX_CLI
    instructions: "do"
    capabilities: [READ]
    on_failure: "explode"
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
  });

  it("h. YAML syntax error throws WorkflowParseError", () => {
    const badYaml = `
name: bad
  version: "1"
    timeout: broken
      steps:
        this is not valid yaml: [
`;
    expect(() => parseWorkflow(badYaml)).toThrow(WorkflowParseError);
  });
});

// ---------------------------------------------------------------------------
// AT-1.4 — DAG validation errors
// ---------------------------------------------------------------------------
describe("AT-1.4: DAG validation errors", () => {
  it("a. A → B → A cycle detected", () => {
    const yaml = `
name: cycle-2
version: "1"
timeout: "5m"
steps:
  A:
    worker: CODEX_CLI
    instructions: "do A"
    capabilities: [READ]
    depends_on: [B]
  B:
    worker: CODEX_CLI
    instructions: "do B"
    capabilities: [READ]
    depends_on: [A]
`;
    const def = parseWorkflow(yaml);
    const errors = validateDag(def);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.toLowerCase().includes("cycle"))).toBe(true);
  });

  it("b. A → B → C → A (3-node cycle) detected", () => {
    const yaml = `
name: cycle-3
version: "1"
timeout: "5m"
steps:
  A:
    worker: CODEX_CLI
    instructions: "do A"
    capabilities: [READ]
    depends_on: [C]
  B:
    worker: CODEX_CLI
    instructions: "do B"
    capabilities: [READ]
    depends_on: [A]
  C:
    worker: CODEX_CLI
    instructions: "do C"
    capabilities: [READ]
    depends_on: [B]
`;
    const def = parseWorkflow(yaml);
    const errors = validateDag(def);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.toLowerCase().includes("cycle"))).toBe(true);
  });

  it("c. depends_on references nonexistent step", () => {
    const yaml = `
name: bad-ref
version: "1"
timeout: "5m"
steps:
  A:
    worker: CODEX_CLI
    instructions: "do A"
    capabilities: [READ]
    depends_on: [nonexistent]
`;
    const def = parseWorkflow(yaml);
    const errors = validateDag(def);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.field === "depends_on" && e.message.includes("unknown"))).toBe(true);
  });

  it("d. inputs[].from not in depends_on", () => {
    const yaml = `
name: bad-input
version: "1"
timeout: "5m"
steps:
  A:
    worker: CODEX_CLI
    instructions: "do A"
    capabilities: [READ]
    outputs:
      - name: result
        path: "out.txt"
  B:
    worker: CODEX_CLI
    instructions: "do B"
    capabilities: [READ]
    inputs:
      - from: A
        artifact: result
`;
    const def = parseWorkflow(yaml);
    const errors = validateDag(def);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.field === "inputs")).toBe(true);
  });

  it("e. duplicate output name within same step", () => {
    const yaml = `
name: dup-output
version: "1"
timeout: "5m"
steps:
  A:
    worker: CODEX_CLI
    instructions: "do A"
    capabilities: [READ]
    outputs:
      - name: result
        path: "a.txt"
      - name: result
        path: "b.txt"
`;
    const def = parseWorkflow(yaml);
    const errors = validateDag(def);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.field === "outputs" && e.message.includes("duplicate"))).toBe(true);
  });

  it("f. self-referencing depends_on", () => {
    const yaml = `
name: self-ref
version: "1"
timeout: "5m"
steps:
  self:
    worker: CODEX_CLI
    instructions: "do self"
    capabilities: [READ]
    depends_on: [self]
`;
    const def = parseWorkflow(yaml);
    const errors = validateDag(def);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.toLowerCase().includes("cycle"))).toBe(true);
  });
});
