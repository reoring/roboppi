/**
 * AT: Subworkflow — parent workflow invokes child workflow via `workflow:` step.
 */
import { describe, it, expect } from "bun:test";
import { stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { parseWorkflow, WorkflowParseError } from "../../src/workflow/parser.js";
import { validateDag } from "../../src/workflow/dag-validator.js";
import { WorkflowStatus, StepStatus, isSubworkflowStep, isWorkerStep } from "../../src/workflow/types.js";
import {
  assertNoRecursion,
  resolveMaxNestingDepth,
  DEFAULT_MAX_NESTING_DEPTH,
  SubworkflowRecursionError,
  SubworkflowDepthError,
} from "../../src/workflow/recursion-guard.js";
import {
  MockStepRunner,
  withTempDir,
  writeWorkspaceFile,
  path,
} from "./helpers.js";
import { ContextManager } from "../../src/workflow/context-manager.js";
import { WorkflowExecutor } from "../../src/workflow/executor.js";
import type { WorkflowExecutorOptions } from "../../src/workflow/executor.js";

// ---------------------------------------------------------------------------
// Helper: write parent + child YAMLs and execute the parent workflow
// ---------------------------------------------------------------------------

async function executeSubworkflowYaml(
  parentYaml: string,
  childWorkflows: Record<string, string>,
  runner: MockStepRunner,
  dir: string,
): Promise<{ state: import("../../src/workflow/types.js").WorkflowState; contextDir: string; workspaceDir: string }> {
  // Write child workflow files
  for (const [filename, content] of Object.entries(childWorkflows)) {
    const filePath = path.join(dir, filename);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  // Write parent workflow
  const parentPath = path.join(dir, "parent.yaml");
  await writeFile(parentPath, parentYaml);

  // Parse the parent
  const definition = parseWorkflow(parentYaml);
  const contextDir = path.join(dir, "context");
  const ctx = new ContextManager(contextDir);

  const options: WorkflowExecutorOptions = {
    definitionPath: parentPath,
    workflowCallStack: [parentPath],
  };

  const executor = new WorkflowExecutor(
    definition,
    ctx,
    runner,
    dir,
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    options,
  );
  const state = await executor.execute();
  return { state, contextDir, workspaceDir: dir };
}

// ---------------------------------------------------------------------------
// 1. Parser validation
// ---------------------------------------------------------------------------

describe("Subworkflow: Parser validation", () => {
  it("parses a subworkflow step with workflow field", () => {
    const yaml = `
name: parent
version: "1"
timeout: "5m"
steps:
  child-step:
    workflow: "./child.yaml"
    timeout: "2m"
`;
    const def = parseWorkflow(yaml);
    expect(def.steps["child-step"]).toBeDefined();
    expect(def.steps["child-step"]!.workflow).toBe("./child.yaml");
    expect(isSubworkflowStep(def.steps["child-step"]!)).toBe(true);
    expect(isWorkerStep(def.steps["child-step"]!)).toBe(false);
  });

  it("rejects workflow + worker together", () => {
    const yaml = `
name: parent
version: "1"
timeout: "5m"
steps:
  bad:
    workflow: "./child.yaml"
    worker: CODEX_CLI
    instructions: "hello"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/mutually exclusive/);
  });

  it("rejects workflow + instructions together", () => {
    const yaml = `
name: parent
version: "1"
timeout: "5m"
steps:
  bad:
    workflow: "./child.yaml"
    instructions: "do something"
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/cannot be used with workflow/);
  });

  it("rejects workflow + capabilities together", () => {
    const yaml = `
name: parent
version: "1"
timeout: "5m"
steps:
  bad:
    workflow: "./child.yaml"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/cannot be used with workflow/);
  });

  it("rejects workflow + completion_check together", () => {
    const yaml = `
name: parent
version: "1"
timeout: "5m"
steps:
  bad:
    workflow: "./child.yaml"
    completion_check:
      worker: CODEX_CLI
      instructions: "check"
      capabilities: [READ]
      decision_file: "check.txt"
    max_iterations: 3
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/cannot be used with workflow/);
  });

  it("rejects workflow + convergence together", () => {
    const yaml = `
name: parent
version: "1"
timeout: "5m"
steps:
  bad:
    workflow: "./child.yaml"
    convergence:
      enabled: true
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/cannot be used with workflow/);
  });

  it("validates exports array correctly", () => {
    const yaml = `
name: parent
version: "1"
timeout: "5m"
steps:
  child-step:
    workflow: "./child.yaml"
    exports:
      - from: step-a
        artifact: report
        as: child-report
`;
    const def = parseWorkflow(yaml);
    expect(def.steps["child-step"]!.exports).toEqual([
      { from: "step-a", artifact: "report", as: "child-report" },
    ]);
  });

  it("rejects exports with missing from", () => {
    const yaml = `
name: parent
version: "1"
timeout: "5m"
steps:
  child-step:
    workflow: "./child.yaml"
    exports:
      - artifact: report
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/from/);
  });

  it("rejects exports with missing artifact", () => {
    const yaml = `
name: parent
version: "1"
timeout: "5m"
steps:
  child-step:
    workflow: "./child.yaml"
    exports:
      - from: step-a
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/artifact/);
  });

  it("existing worker step YAML still parses correctly", () => {
    const yaml = `
name: worker-wf
version: "1"
timeout: "5m"
steps:
  step1:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ, EDIT]
    timeout: "2m"
`;
    const def = parseWorkflow(yaml);
    expect(def.steps["step1"]!.worker).toBe("CODEX_CLI");
    expect(isWorkerStep(def.steps["step1"]!)).toBe(true);
    expect(isSubworkflowStep(def.steps["step1"]!)).toBe(false);
  });

  it("rejects reserved artifact names in outputs", () => {
    const yaml = `
name: bad-outputs
version: "1"
timeout: "5m"
steps:
  step1:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
    outputs:
      - name: _meta.json
        path: "report.txt"
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/reserved artifact name/i);
  });

  it("rejects reserved artifact names in exports", () => {
    const yaml = `
name: bad-exports
version: "1"
timeout: "5m"
steps:
  child-step:
    workflow: "./child.yaml"
    exports:
      - from: step-a
        artifact: _meta.json
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/reserved artifact name/i);
  });

  it("rejects reserved artifact names in inputs", () => {
    const yaml = `
name: bad-inputs
version: "1"
timeout: "5m"
steps:
  a:
    worker: CODEX_CLI
    instructions: "a"
    capabilities: [READ]
  b:
    worker: CODEX_CLI
    instructions: "b"
    capabilities: [READ]
    depends_on: [a]
    inputs:
      - from: a
        artifact: _resolved.json
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/reserved artifact name/i);
  });

  it("rejects backslashes in step IDs", () => {
    const yaml = `
name: bad-step-id
version: "1"
timeout: "5m"
steps:
  bad\\id:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/safe path segment/i);
  });
});

// ---------------------------------------------------------------------------
// 2. DAG validator: exports duplicate check
// ---------------------------------------------------------------------------

describe("Subworkflow: DAG validator", () => {
  it("detects duplicate export names", () => {
    const yaml = `
name: parent
version: "1"
timeout: "5m"
steps:
  child-step:
    workflow: "./child.yaml"
    exports:
      - from: step-a
        artifact: report
      - from: step-b
        artifact: report
`;
    const def = parseWorkflow(yaml);
    const errors = validateDag(def);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.field === "exports" && e.message.includes("duplicate export name"))).toBe(true);
  });

  it("allows different export names (via as)", () => {
    const yaml = `
name: parent
version: "1"
timeout: "5m"
steps:
  child-step:
    workflow: "./child.yaml"
    exports:
      - from: step-a
        artifact: report
        as: report-a
      - from: step-b
        artifact: report
        as: report-b
`;
    const def = parseWorkflow(yaml);
    const errors = validateDag(def);
    expect(errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Recursion guard
// ---------------------------------------------------------------------------

describe("Subworkflow: Recursion guard", () => {
  it("detects direct recursion (A -> A)", () => {
    expect(() =>
      assertNoRecursion("/workflows/a.yaml", ["/workflows/a.yaml"]),
    ).toThrow(/Recursive subworkflow call detected/);
  });

  it("detects indirect recursion (A -> B -> A)", () => {
    expect(() =>
      assertNoRecursion(
        "/workflows/a.yaml",
        ["/workflows/a.yaml", "/workflows/b.yaml"],
      ),
    ).toThrow(/Recursive subworkflow call detected/);
  });

  it("allows non-recursive calls", () => {
    expect(() =>
      assertNoRecursion(
        "/workflows/c.yaml",
        ["/workflows/a.yaml", "/workflows/b.yaml"],
      ),
    ).not.toThrow();
  });

  it("detects depth limit exceeded", () => {
    const stack = ["/a.yaml", "/b.yaml", "/c.yaml"];
    expect(() =>
      assertNoRecursion("/d.yaml", stack, { maxDepth: 3 }),
    ).toThrow(/nesting depth limit exceeded/);
  });

  it("allows calls within depth limit", () => {
    const stack = ["/a.yaml", "/b.yaml"];
    expect(() =>
      assertNoRecursion("/c.yaml", stack, { maxDepth: 3 }),
    ).not.toThrow();
  });

  it("resolveMaxNestingDepth returns default", () => {
    expect(resolveMaxNestingDepth()).toBe(DEFAULT_MAX_NESTING_DEPTH);
  });

  it("resolveMaxNestingDepth respects configured value", () => {
    expect(resolveMaxNestingDepth(10)).toBe(10);
  });

  it("throws SubworkflowRecursionError on direct recursion", () => {
    expect(() =>
      assertNoRecursion("/workflows/a.yaml", ["/workflows/a.yaml"]),
    ).toThrow(SubworkflowRecursionError);
  });

  it("throws SubworkflowDepthError on depth limit exceeded", () => {
    const stack = ["/a.yaml", "/b.yaml", "/c.yaml"];
    expect(() =>
      assertNoRecursion("/d.yaml", stack, { maxDepth: 3 }),
    ).toThrow(SubworkflowDepthError);
  });

  it("resolveMaxNestingDepth respects env variable", () => {
    const origEnv = process.env.ROBOPPI_MAX_SUBWORKFLOW_DEPTH;
    try {
      process.env.ROBOPPI_MAX_SUBWORKFLOW_DEPTH = "8";
      expect(resolveMaxNestingDepth()).toBe(8);
    } finally {
      if (origEnv === undefined) {
        delete process.env.ROBOPPI_MAX_SUBWORKFLOW_DEPTH;
      } else {
        process.env.ROBOPPI_MAX_SUBWORKFLOW_DEPTH = origEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Execution
// ---------------------------------------------------------------------------

describe("Subworkflow: Execution", () => {
  const childYaml = `
name: child-workflow
version: "1"
timeout: "5m"
steps:
  child-step-a:
    worker: CODEX_CLI
    instructions: "child work A"
    capabilities: [READ]
  child-step-b:
    worker: CODEX_CLI
    instructions: "child work B"
    capabilities: [READ]
    depends_on: [child-step-a]
`;

  const parentYaml = `
name: parent-workflow
version: "1"
timeout: "10m"
steps:
  setup:
    worker: CODEX_CLI
    instructions: "setup work"
    capabilities: [READ]
  invoke-child:
    workflow: "./child.yaml"
    depends_on: [setup]
    timeout: "5m"
`;

  it("executes parent → subworkflow step → child workflow successfully", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner();
      const { state } = await executeSubworkflowYaml(
        parentYaml,
        { "child.yaml": childYaml },
        runner,
        dir,
      );

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(state.steps["setup"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.steps["invoke-child"]!.status).toBe(StepStatus.SUCCEEDED);

      // Verify child steps were actually run
      expect(runner.getStepCallCount("child-step-a")).toBe(1);
      expect(runner.getStepCallCount("child-step-b")).toBe(1);
    });
  });

  it("propagates child failure to parent step", async () => {
    await withTempDir(async (dir) => {
      const runner = new MockStepRunner(async (stepId) => {
        if (stepId === "child-step-b") {
          return { status: "FAILED" };
        }
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeSubworkflowYaml(
        parentYaml,
        { "child.yaml": childYaml },
        runner,
        dir,
      );

      expect(state.status).toBe(WorkflowStatus.FAILED);
      expect(state.steps["invoke-child"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["invoke-child"]!.error).toContain("child-workflow");
    });
  });

  it("propagates child timeout to parent step failure", async () => {
    await withTempDir(async (dir) => {
      // Use a child workflow with very short timeout
      const shortChildYaml = `
name: slow-child
version: "1"
timeout: "100ms"
steps:
  slow-step:
    worker: CODEX_CLI
    instructions: "slow work"
    capabilities: [READ]
`;
      const runner = new MockStepRunner(async (_stepId, _step, _callIndex, abortSignal) => {
        // Wait long enough to exceed the timeout
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          abortSignal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
        return { status: "SUCCEEDED" };
      });

      const { state } = await executeSubworkflowYaml(
        `
name: parent-timeout
version: "1"
timeout: "10m"
steps:
  invoke-child:
    workflow: "./child.yaml"
    timeout: "5m"
`,
        { "child.yaml": shortChildYaml },
        runner,
        dir,
      );

      expect(state.steps["invoke-child"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["invoke-child"]!.error).toContain("timed out");
    });
  });

  it("propagates parent cancellation to child", async () => {
    await withTempDir(async (dir) => {
      const abc = new AbortController();

      const slowChildYaml = `
name: cancelable-child
version: "1"
timeout: "30s"
steps:
  long-step:
    worker: CODEX_CLI
    instructions: "long work"
    capabilities: [READ]
`;
      let stepAborted = false;
      const runner = new MockStepRunner(async (_stepId, _step, callIndex, abortSignal) => {
        void callIndex;
        if (_stepId === "long-step") {
          await new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => {
              stepAborted = true;
              resolve();
            });
            // Also cancel after short delay to trigger abort
            setTimeout(() => abc.abort(), 50);
          });
          return { status: "FAILED" };
        }
        return { status: "SUCCEEDED" };
      });

      const parentPath = path.join(dir, "parent.yaml");
      const parentContent = `
name: cancel-parent
version: "1"
timeout: "10m"
steps:
  invoke-child:
    workflow: "./child.yaml"
`;
      await writeFile(parentPath, parentContent);
      await writeFile(path.join(dir, "child.yaml"), slowChildYaml);

      const definition = parseWorkflow(parentContent);
      const contextDir = path.join(dir, "context");
      const ctx = new ContextManager(contextDir);
      const executor = new WorkflowExecutor(
        definition,
        ctx,
        runner,
        dir,
        undefined,
        abc.signal,
        undefined,
        false,
        undefined,
        { definitionPath: parentPath, workflowCallStack: [parentPath] },
      );

      const state = await executor.execute();
      expect(stepAborted).toBe(true);
      expect([WorkflowStatus.CANCELLED, WorkflowStatus.TIMED_OUT]).toContain(state.status);
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Exports
// ---------------------------------------------------------------------------

describe("Subworkflow: Exports", () => {
  it("copies child artifacts to parent context", async () => {
    await withTempDir(async (dir) => {
      const childWithOutputs = `
name: child-with-outputs
version: "1"
timeout: "5m"
steps:
  generate:
    worker: CODEX_CLI
    instructions: "generate report"
    capabilities: [READ]
    outputs:
      - name: report
        path: "report.txt"
`;
      const parentWithExports = `
name: parent-exports
version: "1"
timeout: "10m"
steps:
  invoke-child:
    workflow: "./child.yaml"
    exports:
      - from: generate
        artifact: report
        as: child-report
`;
      const runner = new MockStepRunner(async (stepId) => {
        if (stepId === "generate") {
          // Create the output file that will be collected
          await writeWorkspaceFile(dir, "report.txt", "Test Report Content");
        }
        return { status: "SUCCEEDED" };
      });

      const { state, contextDir } = await executeSubworkflowYaml(
        parentWithExports,
        { "child.yaml": childWithOutputs },
        runner,
        dir,
      );

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      // The exported artifact should be at <parentContext>/<parentStepId>/<as>/
      const exportedDir = path.join(contextDir, "invoke-child", "child-report");
      const exportedStat = await stat(exportedDir).catch(() => null);
      expect(exportedStat).not.toBeNull();
    });
  });

  it("silently skips missing child artifacts", async () => {
    await withTempDir(async (dir) => {
      const childNoOutputs = `
name: child-no-outputs
version: "1"
timeout: "5m"
steps:
  generate:
    worker: CODEX_CLI
    instructions: "generate nothing"
    capabilities: [READ]
`;
      const parentWithExports = `
name: parent-missing-exports
version: "1"
timeout: "10m"
steps:
  invoke-child:
    workflow: "./child.yaml"
    exports:
      - from: generate
        artifact: nonexistent-artifact
`;
      const runner = new MockStepRunner();

      // Should not throw
      const { state } = await executeSubworkflowYaml(
        parentWithExports,
        { "child.yaml": childNoOutputs },
        runner,
        dir,
      );

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Context directory
// ---------------------------------------------------------------------------

describe("Subworkflow: Context directory", () => {
  it("creates _subworkflows/<stepId>/<runId>/ directory", async () => {
    await withTempDir(async (dir) => {
      const childYaml = `
name: ctx-child
version: "1"
timeout: "5m"
steps:
  work:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      const parentYaml = `
name: ctx-parent
version: "1"
timeout: "10m"
steps:
  invoke:
    workflow: "./child.yaml"
`;
      const runner = new MockStepRunner();
      const { contextDir } = await executeSubworkflowYaml(
        parentYaml,
        { "child.yaml": childYaml },
        runner,
        dir,
      );

      // Check the _subworkflows directory exists
      const subworkflowsDir = path.join(contextDir, "_subworkflows", "invoke");
      const subStat = await stat(subworkflowsDir).catch(() => null);
      expect(subStat).not.toBeNull();
      expect(subStat?.isDirectory()).toBe(true);
    });
  });

  it("child workflow writes _workflow.json in its context", async () => {
    await withTempDir(async (dir) => {
      const childYaml = `
name: child-meta
version: "1"
timeout: "5m"
steps:
  work:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      const parentYaml = `
name: parent-meta
version: "1"
timeout: "10m"
steps:
  invoke:
    workflow: "./child.yaml"
`;
      const runner = new MockStepRunner();
      const { contextDir } = await executeSubworkflowYaml(
        parentYaml,
        { "child.yaml": childYaml },
        runner,
        dir,
      );

      // Find the run directory
      const subworkflowsDir = path.join(contextDir, "_subworkflows", "invoke");
      const entries = await (await import("node:fs/promises")).readdir(subworkflowsDir);
      expect(entries.length).toBe(1);

      const runDir = path.join(subworkflowsDir, entries[0]!);
      const workflowMeta = JSON.parse(
        await readFile(path.join(runDir, "_workflow.json"), "utf-8"),
      );
      expect(workflowMeta.name).toBe("child-meta");
      expect(workflowMeta.status).toBe("SUCCEEDED");
    });
  });

  it("parent step _meta.json includes subworkflow section", async () => {
    await withTempDir(async (dir) => {
      const childYaml = `
name: meta-child
version: "1"
timeout: "5m"
steps:
  work:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      const parentYaml = `
name: meta-parent
version: "1"
timeout: "10m"
steps:
  invoke:
    workflow: "./child.yaml"
`;
      const runner = new MockStepRunner();
      const { contextDir } = await executeSubworkflowYaml(
        parentYaml,
        { "child.yaml": childYaml },
        runner,
        dir,
      );

      const metaPath = path.join(contextDir, "invoke", "_meta.json");
      const meta = JSON.parse(await readFile(metaPath, "utf-8"));
      expect(meta.subworkflow).toBeDefined();
      expect(meta.subworkflow.name).toBe("meta-child");
      expect(meta.subworkflow.status).toBe("SUCCEEDED");
      expect(meta.subworkflow.path).toBe("./child.yaml");
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Recursion guard (integration)
// ---------------------------------------------------------------------------

describe("Subworkflow: Recursion guard (integration)", () => {
  it("detects direct self-recursion at runtime", async () => {
    await withTempDir(async (dir) => {
      // Parent references itself
      const selfRecursiveYaml = `
name: self-recursive
version: "1"
timeout: "5m"
steps:
  loop:
    workflow: "./parent.yaml"
`;
      const runner = new MockStepRunner();

      const { state } = await executeSubworkflowYaml(
        selfRecursiveYaml,
        {},
        runner,
        dir,
      );

      expect(state.status).toBe(WorkflowStatus.FAILED);
      expect(state.steps["loop"]!.status).toBe(StepStatus.FAILED);
      expect(state.steps["loop"]!.error).toContain("Recursive subworkflow call detected");
    });
  });

  it("detects indirect recursion A -> B -> A at runtime", async () => {
    await withTempDir(async (dir) => {
      const parentYaml = `
name: parent-a
version: "1"
timeout: "5m"
steps:
  call-b:
    workflow: "./b.yaml"
`;
      const childB = `
name: child-b
version: "1"
timeout: "5m"
steps:
  call-a:
    workflow: "./parent.yaml"
`;
      const runner = new MockStepRunner();

      const { state } = await executeSubworkflowYaml(
        parentYaml,
        { "b.yaml": childB },
        runner,
        dir,
      );

      expect(state.status).toBe(WorkflowStatus.FAILED);
      expect(state.steps["call-b"]!.status).toBe(StepStatus.FAILED);
      // The recursion is detected in child-b, which wraps the error as FATAL
      // propagating up as "Child workflow ... failed (FATAL)"
      expect(state.steps["call-b"]!.error).toBeTruthy();
    });
  });

  it("detects depth limit at runtime", async () => {
    await withTempDir(async (dir) => {
      // Create a chain: parent -> a -> b -> c -> d (depth 5, but maxDepth=3)
      const parentYaml = `
name: deep-parent
version: "1"
timeout: "5m"
steps:
  go:
    workflow: "./a.yaml"
`;
      const aYaml = `
name: deep-a
version: "1"
timeout: "5m"
steps:
  go:
    workflow: "./b.yaml"
`;
      const bYaml = `
name: deep-b
version: "1"
timeout: "5m"
steps:
  go:
    workflow: "./c.yaml"
`;
      const cYaml = `
name: deep-c
version: "1"
timeout: "5m"
steps:
  work:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      const runner = new MockStepRunner();

      // Set max depth to 2 so parent -> a -> b would fail
      const parentPath = path.join(dir, "parent.yaml");
      await writeFile(parentPath, parentYaml);
      await writeFile(path.join(dir, "a.yaml"), aYaml);
      await writeFile(path.join(dir, "b.yaml"), bYaml);
      await writeFile(path.join(dir, "c.yaml"), cYaml);

      const definition = parseWorkflow(parentYaml);
      const contextDir = path.join(dir, "context");
      const ctx = new ContextManager(contextDir);
      const executor = new WorkflowExecutor(
        definition,
        ctx,
        runner,
        dir,
        undefined,
        undefined,
        undefined,
        false,
        undefined,
        {
          definitionPath: parentPath,
          workflowCallStack: [parentPath],
          maxNestingDepth: 2,
        },
      );

      const state = await executor.execute();
      expect(state.status).toBe(WorkflowStatus.FAILED);
    });
  });
});
