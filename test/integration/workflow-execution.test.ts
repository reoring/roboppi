import { describe, it, expect } from "bun:test";
import { parseWorkflow, WorkflowParseError } from "../../src/workflow/parser.js";
import { validateDag } from "../../src/workflow/dag-validator.js";
import { ContextManager } from "../../src/workflow/context-manager.js";
import {
  WorkflowExecutor,
  type StepRunner,
  type StepRunResult,
  type CheckResult,
} from "../../src/workflow/executor.js";
import type {
  StepDefinition,
  CompletionCheckDef,
} from "../../src/workflow/types.js";
import { WorkflowStatus, StepStatus } from "../../src/workflow/types.js";
import { ErrorClass } from "../../src/types/common.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "wf-integ-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

class MockStepRunner implements StepRunner {
  readonly stepCalls: Array<{ stepId: string; callIndex: number }> = [];
  readonly checkCalls: Array<{ stepId: string; callIndex: number }> = [];
  private stepCallCounts = new Map<string, number>();
  private checkCallCounts = new Map<string, number>();
  private readonly stepHandler: (
    stepId: string,
    step: StepDefinition,
    callIndex: number,
  ) => Promise<StepRunResult>;
  private readonly checkHandler: (
    stepId: string,
    check: CompletionCheckDef,
    callIndex: number,
  ) => Promise<CheckResult>;

  constructor(
    stepHandler?: (
      stepId: string,
      step: StepDefinition,
      callIndex: number,
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
      checkHandler ?? (async () => ({ complete: true, failed: false }));
  }

  async runStep(
    stepId: string,
    step: StepDefinition,
    _workspaceDir: string,
    _abortSignal: AbortSignal,
  ): Promise<StepRunResult> {
    const count = (this.stepCallCounts.get(stepId) ?? 0) + 1;
    this.stepCallCounts.set(stepId, count);
    this.stepCalls.push({ stepId, callIndex: count });
    return this.stepHandler(stepId, step, count);
  }

  async runCheck(
    stepId: string,
    check: CompletionCheckDef,
    _workspaceDir: string,
    _abortSignal: AbortSignal,
  ): Promise<CheckResult> {
    const count = (this.checkCallCounts.get(stepId) ?? 0) + 1;
    this.checkCallCounts.set(stepId, count);
    this.checkCalls.push({ stepId, callIndex: count });
    return this.checkHandler(stepId, check, count);
  }
}

// ---------------------------------------------------------------------------
// Integration tests: full pipeline
// ---------------------------------------------------------------------------

describe("Workflow Integration", () => {
  // -----------------------------------------------------------------------
  // implement-review-fix example from design doc
  // -----------------------------------------------------------------------
  describe("implement-review-fix pipeline", () => {
    const yaml = `
name: implement-review-fix
version: "1"
description: "Implement, review, and fix"
timeout: "1h"
concurrency: 2

steps:
  implement:
    description: "Initial implementation"
    worker: CODEX_CLI
    instructions: "Implement feature"
    capabilities: [READ, EDIT]
    timeout: "15m"
    max_retries: 1
    on_failure: retry
    outputs:
      - name: implementation
        path: "src/feature.ts"
        type: code

  test:
    description: "Run tests"
    worker: CODEX_CLI
    depends_on: [implement]
    instructions: "Run test suite"
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
    description: "Code review"
    worker: CLAUDE_CODE
    depends_on: [implement]
    instructions: "Review code"
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
    description: "Apply fixes"
    worker: CODEX_CLI
    depends_on: [review, test]
    instructions: "Apply review fixes"
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

    it("parses, validates, and executes the full pipeline", async () => {
      await withTempDir(async (dir) => {
        // Parse
        const definition = parseWorkflow(yaml);
        expect(definition.name).toBe("implement-review-fix");
        expect(definition.concurrency).toBe(2);
        expect(Object.keys(definition.steps).length).toBe(4);

        // Validate DAG
        const errors = validateDag(definition);
        expect(errors).toEqual([]);

        // Execute with mock runner
        const executionOrder: string[] = [];
        const runner = new MockStepRunner(async (stepId) => {
          executionOrder.push(stepId);
          await new Promise((r) => setTimeout(r, 5));
          return { status: "SUCCEEDED" };
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(definition, ctx, runner, dir);
        const result = await executor.execute();

        // Verify workflow succeeded
        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);
        expect(result.name).toBe("implement-review-fix");

        // Verify all steps succeeded
        expect(result.steps["implement"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(result.steps["test"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(result.steps["review"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(result.steps["fix"]!.status).toBe(StepStatus.SUCCEEDED);

        // Verify ordering: implement first, fix last
        expect(executionOrder[0]).toBe("implement");
        expect(executionOrder[executionOrder.length - 1]).toBe("fix");

        // test and review should both come after implement
        const testIdx = executionOrder.indexOf("test");
        const reviewIdx = executionOrder.indexOf("review");
        const implIdx = executionOrder.indexOf("implement");
        expect(testIdx).toBeGreaterThan(implIdx);
        expect(reviewIdx).toBeGreaterThan(implIdx);

        // Context directory should have been created
        const workflowMeta = await readFile(
          path.join(dir, "context", "_workflow.json"),
          "utf-8",
        );
        const parsed = JSON.parse(workflowMeta);
        expect(parsed.name).toBe("implement-review-fix");
      });
    });

    it("handles review failure with abort — fix gets skipped", async () => {
      await withTempDir(async (dir) => {
        const definition = parseWorkflow(yaml);
        const runner = new MockStepRunner(async (stepId) => {
          if (stepId === "review") {
            return {
              status: "FAILED",
              errorClass: ErrorClass.NON_RETRYABLE,
            };
          }
          return { status: "SUCCEEDED" };
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(definition, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.FAILED);
        expect(result.steps["implement"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(result.steps["review"]!.status).toBe(StepStatus.FAILED);
        // fix depends on review (abort) → should be skipped
        expect(result.steps["fix"]!.status).toBe(StepStatus.SKIPPED);
        // test has on_failure: continue but it should succeed
        expect(result.steps["test"]!.status).toBe(StepStatus.SUCCEEDED);
      });
    });

    it("handles test failure with continue — fix still runs", async () => {
      await withTempDir(async (dir) => {
        const definition = parseWorkflow(yaml);
        const runner = new MockStepRunner(async (stepId) => {
          if (stepId === "test") {
            return {
              status: "FAILED",
              errorClass: ErrorClass.NON_RETRYABLE,
            };
          }
          return { status: "SUCCEEDED" };
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(definition, ctx, runner, dir);
        const result = await executor.execute();

        // test failed with continue, review succeeded with abort — fix should run
        // because test's on_failure is "continue"
        expect(result.steps["test"]!.status).toBe(StepStatus.FAILED);
        expect(result.steps["review"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(result.steps["fix"]!.status).toBe(StepStatus.SUCCEEDED);
      });
    });
  });

  // -----------------------------------------------------------------------
  // completion_check loop example (implement-from-todo)
  // -----------------------------------------------------------------------
  describe("implement-from-todo pipeline (completion_check loop)", () => {
    const yaml = `
name: implement-from-todo
version: "1"
description: "Complete all todo items"
timeout: "2h"

steps:
  implement-all:
    description: "Implement todo items one by one"
    worker: CODEX_CLI
    instructions: "Pick and implement a todo item"
    capabilities: [READ, EDIT, RUN_TESTS]
    timeout: "10m"
    max_retries: 1
    on_failure: retry
    completion_check:
      worker: CLAUDE_CODE
      decision_file: ".roboppi-loop/decision.json"
      instructions: "Check if all todos are done"
      capabilities: [READ]
      timeout: "2m"
    max_iterations: 20
    on_iterations_exhausted: abort
    outputs:
      - name: completed-code
        path: "src/"
        type: code

  verify:
    description: "Run full test suite"
    worker: CODEX_CLI
    depends_on: [implement-all]
    instructions: "Run all tests"
    capabilities: [READ, RUN_TESTS]
    inputs:
      - from: implement-all
        artifact: completed-code
    timeout: "10m"
    on_failure: abort
`;

    it("parses, validates, and executes with completion_check loop", async () => {
      await withTempDir(async (dir) => {
        const definition = parseWorkflow(yaml);
        expect(definition.name).toBe("implement-from-todo");

        const errors = validateDag(definition);
        expect(errors).toEqual([]);

        let implCallCount = 0;
        const runner = new MockStepRunner(
          async (stepId) => {
            if (stepId === "implement-all") implCallCount++;
            return { status: "SUCCEEDED" };
          },
          async (_stepId, _check, callIndex) => {
            // Complete on 4th check
            return { complete: callIndex >= 4, failed: false };
          },
        );

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(definition, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.status).toBe(WorkflowStatus.SUCCEEDED);
        expect(result.steps["implement-all"]!.status).toBe(
          StepStatus.SUCCEEDED,
        );
        expect(result.steps["implement-all"]!.iteration).toBe(4);
        expect(result.steps["verify"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(implCallCount).toBe(4);
      });
    });
  });

  // -----------------------------------------------------------------------
  // Invalid YAML
  // -----------------------------------------------------------------------
  describe("invalid YAML", () => {
    it("throws WorkflowParseError for bad YAML syntax", () => {
      expect(() => parseWorkflow("{{not yaml")).toThrow(WorkflowParseError);
    });

    it("throws WorkflowParseError for missing required fields", () => {
      expect(() => parseWorkflow("name: test\n")).toThrow(WorkflowParseError);
    });

    it("throws WorkflowParseError for invalid version", () => {
      const yaml = `
name: test
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
  });

  // -----------------------------------------------------------------------
  // DAG with cycle
  // -----------------------------------------------------------------------
  describe("DAG cycle detection", () => {
    it("detects a cycle via validate then rejects in executor", async () => {
      await withTempDir(async (dir) => {
        const yaml = `
name: cyclic
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
        const definition = parseWorkflow(yaml);
        const errors = validateDag(definition);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]!.message).toContain("cycle");

        // Executor should also reject
        const runner = new MockStepRunner();
        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(definition, ctx, runner, dir);
        await expect(executor.execute()).rejects.toThrow(
          "Workflow DAG validation failed",
        );
      });
    });
  });

  // -----------------------------------------------------------------------
  // Mixed on_failure policies
  // -----------------------------------------------------------------------
  describe("mixed on_failure policies", () => {
    it("some steps abort, some continue, correct propagation", async () => {
      await withTempDir(async (dir) => {
        const yaml = `
name: mixed-policies
version: "1"
timeout: "10m"
steps:
  root:
    worker: CODEX_CLI
    instructions: "root"
    capabilities: [READ]

  branch-abort:
    worker: CODEX_CLI
    depends_on: [root]
    instructions: "will fail with abort"
    capabilities: [READ]
    on_failure: abort

  branch-continue:
    worker: CODEX_CLI
    depends_on: [root]
    instructions: "will fail with continue"
    capabilities: [READ]
    on_failure: continue

  after-abort:
    worker: CODEX_CLI
    depends_on: [branch-abort]
    instructions: "should be skipped"
    capabilities: [READ]

  after-continue:
    worker: CODEX_CLI
    depends_on: [branch-continue]
    instructions: "should still run"
    capabilities: [READ]
`;
        const definition = parseWorkflow(yaml);
        const errors = validateDag(definition);
        expect(errors).toEqual([]);

        const runner = new MockStepRunner(async (stepId) => {
          if (
            stepId === "branch-abort" ||
            stepId === "branch-continue"
          ) {
            return {
              status: "FAILED",
              errorClass: ErrorClass.NON_RETRYABLE,
            };
          }
          return { status: "SUCCEEDED" };
        });

        const ctx = new ContextManager(path.join(dir, "context"));
        const executor = new WorkflowExecutor(definition, ctx, runner, dir);
        const result = await executor.execute();

        expect(result.steps["root"]!.status).toBe(StepStatus.SUCCEEDED);
        expect(result.steps["branch-abort"]!.status).toBe(StepStatus.FAILED);
        expect(result.steps["branch-continue"]!.status).toBe(StepStatus.FAILED);
        expect(result.steps["after-abort"]!.status).toBe(StepStatus.SKIPPED);
        expect(result.steps["after-continue"]!.status).toBe(
          StepStatus.SUCCEEDED,
        );
      });
    });
  });
});
