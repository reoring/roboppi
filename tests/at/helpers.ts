/**
 * Shared test helpers for acceptance tests.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseWorkflow } from "../../src/workflow/parser.js";
import { ContextManager } from "../../src/workflow/context-manager.js";
import { WorkflowExecutor } from "../../src/workflow/executor.js";
import type { StepRunner, StepRunResult, CheckResult } from "../../src/workflow/executor.js";
import type { StepDefinition, CompletionCheckDef, WorkflowState } from "../../src/workflow/types.js";

// ---------------------------------------------------------------------------
// MockStepRunner — reusable across all AT test files
// ---------------------------------------------------------------------------

export type StepHandler = (
  stepId: string,
  step: StepDefinition,
  callIndex: number,
  abortSignal: AbortSignal,
) => Promise<StepRunResult>;

export type CheckHandler = (
  stepId: string,
  check: CompletionCheckDef,
  callIndex: number,
) => Promise<CheckResult>;

export class MockStepRunner implements StepRunner {
  readonly stepCalls: Array<{ stepId: string; callIndex: number }> = [];
  readonly checkCalls: Array<{ stepId: string; callIndex: number }> = [];
  private stepCallCounts = new Map<string, number>();
  private checkCallCounts = new Map<string, number>();
  runningNow = 0;
  maxConcurrentObserved = 0;

  constructor(
    private readonly stepHandler: StepHandler = async () => ({ status: "SUCCEEDED" }),
    private readonly checkHandler: CheckHandler = async () => ({ complete: true, failed: false }),
  ) {}

  async runStep(
    stepId: string,
    step: StepDefinition,
    _workspaceDir: string,
    abortSignal: AbortSignal,
  ): Promise<StepRunResult> {
    const count = (this.stepCallCounts.get(stepId) ?? 0) + 1;
    this.stepCallCounts.set(stepId, count);
    this.stepCalls.push({ stepId, callIndex: count });
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
    this.checkCalls.push({ stepId, callIndex: count });
    return this.checkHandler(stepId, check, count);
  }

  getStepCallCount(stepId: string): number {
    return this.stepCallCounts.get(stepId) ?? 0;
  }

  getCheckCallCount(stepId: string): number {
    return this.checkCallCounts.get(stepId) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Temp directory helper
// ---------------------------------------------------------------------------

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "at-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Full pipeline helper: YAML string → WorkflowState
// ---------------------------------------------------------------------------

export async function executeYaml(
  yamlContent: string,
  runner: MockStepRunner,
  dir: string,
  contextSubDir = "context",
): Promise<{ state: WorkflowState; contextDir: string; workspaceDir: string }> {
  const definition = parseWorkflow(yamlContent);
  const contextDir = path.join(dir, contextSubDir);
  const ctx = new ContextManager(contextDir);
  const executor = new WorkflowExecutor(definition, ctx, runner, dir);
  const state = await executor.execute();
  return { state, contextDir, workspaceDir: dir };
}

// ---------------------------------------------------------------------------
// File creation helper — write files into workspace for mock outputs
// ---------------------------------------------------------------------------

export async function writeWorkspaceFile(
  workspaceDir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = path.join(workspaceDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
}

export { path };
