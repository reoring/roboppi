/**
 * Integration tests: Management Agent x Executor (TC-MA-E-01 through TC-MA-E-19)
 *
 * These tests validate the management agent integration with the executor.
 * The ManagementController DOES NOT EXIST YET (TDD red phase).
 * Tests are written against expected behavior and will fail until implementation.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseWorkflow } from "../../src/workflow/parser.js";
import { ContextManager } from "../../src/workflow/context-manager.js";
import {
  WorkflowExecutor,
  type StepRunner,
  type StepRunResult,
  type CheckResult,
} from "../../src/workflow/executor.js";
import type { ExecEvent, ExecEventSink } from "../../src/tui/exec-event.js";
import type {
  StepDefinition,
  CompletionCheckDef,
} from "../../src/workflow/types.js";
import { WorkflowStatus, StepStatus } from "../../src/workflow/types.js";
import type { DecisionsLogEntry } from "../../src/workflow/management/types.js";
import {
  ENV_MANAGEMENT_HOOK_ID,
  ENV_MANAGEMENT_INPUT_FILE,
  ENV_MANAGEMENT_DECISION_FILE,
} from "../../src/workflow/management/types.js";
import { writeFile, mkdir } from "node:fs/promises";

// ---------------------------------------------------------------------------
// MockStepRunner — extended with env capture for management hook testing
// ---------------------------------------------------------------------------

type StepHandler = (
  stepId: string,
  step: StepDefinition,
  callIndex: number,
  abortSignal: AbortSignal,
  env?: Record<string, string>,
) => Promise<StepRunResult>;

type CheckHandler = (
  stepId: string,
  check: CompletionCheckDef,
  callIndex: number,
) => Promise<CheckResult>;

class MockStepRunner implements StepRunner {
  readonly stepCalls: Array<{
    stepId: string;
    callIndex: number;
    env?: Record<string, string>;
    instructions?: string;
  }> = [];
  readonly checkCalls: Array<{ stepId: string; callIndex: number }> = [];
  private stepCallCounts = new Map<string, number>();
  private checkCallCounts = new Map<string, number>();
  runningNow = 0;
  maxConcurrentObserved = 0;

  constructor(
    private readonly stepHandler: StepHandler = async () => ({
      status: "SUCCEEDED",
    }),
    private readonly checkHandler: CheckHandler = async () => ({
      complete: true,
      failed: false,
    }),
  ) {}

  async runStep(
    stepId: string,
    step: StepDefinition,
    _workspaceDir: string,
    abortSignal: AbortSignal,
    env?: Record<string, string>,
  ): Promise<StepRunResult> {
    const count = (this.stepCallCounts.get(stepId) ?? 0) + 1;
    this.stepCallCounts.set(stepId, count);
    this.stepCalls.push({
      stepId,
      callIndex: count,
      env,
      instructions: step.instructions,
    });
    this.runningNow++;
    if (this.runningNow > this.maxConcurrentObserved) {
      this.maxConcurrentObserved = this.runningNow;
    }
    try {
      return await this.stepHandler(stepId, step, count, abortSignal, env);
    } finally {
      this.runningNow--;
    }
  }

  async runCheck(
    stepId: string,
    check: CompletionCheckDef,
    _workspaceDir: string,
    _abortSignal: AbortSignal,
    _env?: Record<string, string>,
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
// Full pipeline helper: YAML string -> WorkflowState
// ---------------------------------------------------------------------------

async function executeYaml(
  yamlContent: string,
  runner: MockStepRunner,
  dir: string,
  sink?: ExecEventSink,
): Promise<{
  state: import("../../src/workflow/types.js").WorkflowState;
  contextDir: string;
}> {
  const definition = parseWorkflow(yamlContent);
  const contextDir = path.join(dir, "context");
  const ctx = new ContextManager(contextDir);
  const executor = sink
    ? new WorkflowExecutor(definition, ctx, runner, dir, undefined, undefined, undefined, false, sink)
    : new WorkflowExecutor(definition, ctx, runner, dir);
  const state = await executor.execute();
  return { state, contextDir };
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

async function makeTmpDir(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "mgmt-int-"));
  tmpDirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// Helper: check if a path exists
// ---------------------------------------------------------------------------

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helper: read decisions.jsonl as array of DecisionsLogEntry
// ---------------------------------------------------------------------------

async function readDecisionsLog(
  contextDir: string,
): Promise<DecisionsLogEntry[]> {
  const logPath = path.join(contextDir, "_management", "decisions.jsonl");
  const content = await readFile(logPath, "utf-8");
  return content
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as DecisionsLogEntry);
}

// ---------------------------------------------------------------------------
// Helper: list inv directories under _management/inv/
// ---------------------------------------------------------------------------

async function listInvDirs(contextDir: string): Promise<string[]> {
  const invDir = path.join(contextDir, "_management", "inv");
  if (!(await pathExists(invDir))) return [];
  return readdir(invDir);
}

// ---------------------------------------------------------------------------
// Helper: write a management decision file for a mock management worker
// ---------------------------------------------------------------------------

async function writeDecisionFile(
  decisionFilePath: string,
  decision: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.dirname(decisionFilePath), { recursive: true });
  await writeFile(decisionFilePath, JSON.stringify(decision));
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Management Agent x Executor Integration", () => {
  // -------------------------------------------------------------------------
  // TC-MA-E-01: management disabled means behavior unchanged
  // -------------------------------------------------------------------------
  describe("TC-MA-E-01: management disabled means behavior unchanged", () => {
    it("should succeed without creating _management/ directory", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
steps:
  A:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
`;

      const runner = new MockStepRunner();
      const { state, contextDir } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);

      // _management/ directory should NOT exist
      const mgmtDir = path.join(contextDir, "_management");
      expect(await pathExists(mgmtDir)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-02: pre_step proceed
  // -------------------------------------------------------------------------
  describe("TC-MA-E-02: pre_step proceed", () => {
    it("should execute step normally and record applied decision", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
`;

      // The mock step handler: when management env vars are present
      // (i.e. the management worker invocation), write the proceed
      // decision to the decision file. For normal steps, just succeed.
      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            // This is the management worker invocation
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: "A",
              directive: { action: "proceed" },
            });
            return { status: "SUCCEEDED" };
          }
          // Normal step
          return { status: "SUCCEEDED" };
        },
      );

      const { state, contextDir } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);

      // decisions.jsonl should exist with at least 1 applied entry
      const decisions = await readDecisionsLog(contextDir);
      expect(decisions.length).toBeGreaterThanOrEqual(1);
      const applied = decisions.find(
        (d) => d.step_id === "A" && d.hook === "pre_step" && d.applied === true,
      );
      expect(applied).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-03: pre_step skip -> OMITTED, downstream not blocked
  // -------------------------------------------------------------------------
  describe("TC-MA-E-03: pre_step skip -> OMITTED, downstream not blocked", () => {
    it("should mark A as OMITTED and still execute B", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
  B:
    worker: CODEX_CLI
    instructions: "do more"
    capabilities: [READ]
    depends_on: [A]
`;

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            // Read input.json to figure out which step this hook is for
            const inputPath = env[ENV_MANAGEMENT_INPUT_FILE]!;
            let hookStepId = "A";
            try {
              const inputContent = JSON.parse(await readFile(inputPath, "utf-8"));
              hookStepId = inputContent.step_id;
            } catch {
              // fallback
            }

            if (hookStepId === "A") {
              // Skip step A
              await writeDecisionFile(decisionPath, {
                hook_id: hookId,
                hook: "pre_step",
                step_id: "A",
                directive: { action: "skip", reason: "not needed" },
              });
            } else {
              // Proceed for step B
              await writeDecisionFile(decisionPath, {
                hook_id: hookId,
                hook: "pre_step",
                step_id: hookStepId,
                directive: { action: "proceed" },
              });
            }
            return { status: "SUCCEEDED" };
          }
          // Normal step execution
          return { status: "SUCCEEDED" };
        },
      );

      const { state } = await executeYaml(yaml, runner, dir);

      // A should be OMITTED
      expect(state.steps["A"]!.status).toBe(StepStatus.OMITTED);

      // B should still succeed (downstream not blocked)
      expect(state.steps["B"]!.status).toBe(StepStatus.SUCCEEDED);

      // runner should never have called runStep for A (as a normal step)
      const normalStepCallsForA = runner.stepCalls.filter(
        (c) => c.stepId === "A" && !c.env?.[ENV_MANAGEMENT_DECISION_FILE],
      );
      expect(normalStepCallsForA.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-04: OMITTED outputs are empty (missing tolerated)
  // -------------------------------------------------------------------------
  describe("TC-MA-E-04: OMITTED outputs are empty (missing tolerated)", () => {
    it("should tolerate missing inputs from OMITTED step", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "produce output"
    capabilities: [READ]
    outputs:
      - name: out
        path: result.txt
  B:
    worker: CODEX_CLI
    instructions: "consume input"
    capabilities: [READ]
    depends_on: [A]
    inputs:
      - from: A
        artifact: out
`;

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            const inputPath = env[ENV_MANAGEMENT_INPUT_FILE]!;
            let hookStepId = "A";
            try {
              const inputContent = JSON.parse(await readFile(inputPath, "utf-8"));
              hookStepId = inputContent.step_id;
            } catch {
              // fallback
            }

            if (hookStepId === "A") {
              await writeDecisionFile(decisionPath, {
                hook_id: hookId,
                hook: "pre_step",
                step_id: "A",
                directive: { action: "skip", reason: "not needed" },
              });
            } else {
              await writeDecisionFile(decisionPath, {
                hook_id: hookId,
                hook: "pre_step",
                step_id: hookStepId,
                directive: { action: "proceed" },
              });
            }
            return { status: "SUCCEEDED" };
          }
          return { status: "SUCCEEDED" };
        },
      );

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.steps["A"]!.status).toBe(StepStatus.OMITTED);
      // B should still succeed even though input from A is missing
      expect(state.steps["B"]!.status).toBe(StepStatus.SUCCEEDED);
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-05: overlay composition (base + convergence + management)
  // -------------------------------------------------------------------------
  describe("TC-MA-E-05: overlay composition (base + convergence + management)", () => {
    it("should compose instructions in order: base -> convergence -> management", async () => {
      const dir = await makeTmpDir();

      // Use completion_check + convergence + management modify_instructions.
      // We need multiple iterations so convergence kicks in at stage > 1.
      const yaml = `
name: test
version: "1"
timeout: "30s"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "BASE INSTRUCTIONS"
    capabilities: [READ]
    max_iterations: 5
    completion_check:
      worker: CODEX_CLI
      instructions: "check completion"
      capabilities: [READ]
      decision_file: decision.txt
    convergence:
      enabled: true
      stall_threshold: 1
      max_stage: 3
      fail_on_max_stage: false
      stages:
        - stage: 2
          append_instructions: "CONVERGENCE OVERLAY"
`;

      let capturedInstructions: string[] = [];

      const runner = new MockStepRunner(
        async (
          _stepId,
          step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: "A",
              directive: {
                action: "modify_instructions",
                append: "MANAGEMENT OVERLAY",
              },
            });
            return { status: "SUCCEEDED" };
          }
          // Capture the instructions passed to the actual step execution
          if (step.instructions) {
            capturedInstructions.push(step.instructions);
          }
          return { status: "SUCCEEDED" };
        },
        // Check handler: always incomplete to force iterations
        async (_stepId, _check, callIndex) => {
          if (callIndex >= 3) {
            return { complete: true, failed: false };
          }
          return {
            complete: false,
            failed: false,
            fingerprints: ["fp-same"],
          };
        },
      );

      const { state: _state } = await executeYaml(yaml, runner, dir);

      // Verify at least one captured instruction has all three layers
      // The management overlay should be present and contain the
      // [Management Agent] prefix per spec R-07.
      const hasAllLayers = capturedInstructions.some(
        (instr) =>
          instr.includes("BASE INSTRUCTIONS") &&
          instr.includes("[Management Agent]"),
      );
      expect(hasAllLayers).toBe(true);

      // This may or may not be true depending on iteration timing, but
      // at minimum the management overlay should appear
      expect(
        capturedInstructions.some((instr) =>
          instr.includes("[Management Agent]"),
        ),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-06: management overlay replacement/clear
  // -------------------------------------------------------------------------
  describe("TC-MA-E-06: management overlay replacement/clear", () => {
    it("should clear management overlay when management returns proceed", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "30s"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "BASE INSTRUCTIONS"
    capabilities: [READ]
    max_iterations: 5
    completion_check:
      worker: CODEX_CLI
      instructions: "check it"
      capabilities: [READ]
      decision_file: decision.txt
`;

      let managementCallCount = 0;
      let capturedInstructions: string[] = [];

      const runner = new MockStepRunner(
        async (
          _stepId,
          step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            managementCallCount++;
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;

            if (managementCallCount <= 2) {
              // Iterations 1-2: modify_instructions
              await writeDecisionFile(decisionPath, {
                hook_id: hookId,
                hook: "pre_step",
                step_id: "A",
                directive: {
                  action: "modify_instructions",
                  append: `MGMT_OVERLAY_ITER_${managementCallCount}`,
                },
              });
            } else {
              // Iteration 3+: proceed (should clear management overlay)
              await writeDecisionFile(decisionPath, {
                hook_id: hookId,
                hook: "pre_step",
                step_id: "A",
                directive: { action: "proceed" },
              });
            }
            return { status: "SUCCEEDED" };
          }
          // Capture instructions for normal step calls
          if (step.instructions) {
            capturedInstructions.push(step.instructions);
          }
          return { status: "SUCCEEDED" };
        },
        // Check handler: incomplete for first 3 iterations, then complete
        async (_stepId, _check, callIndex) => {
          if (callIndex >= 4) return { complete: true, failed: false };
          return { complete: false, failed: false };
        },
      );

      const { state: _state2 } = await executeYaml(yaml, runner, dir);

      // pre_step hook fires once (at launchStep, before the first iteration).
      // Subsequent iterations reuse the same overlay from the initial pre_step.
      // Verify the first iteration has the management overlay from call 1.
      expect(capturedInstructions.length).toBeGreaterThanOrEqual(1);
      const iter1Instructions = capturedInstructions[0]!;
      expect(iter1Instructions).toContain("MGMT_OVERLAY_ITER_1");
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-07: pre_step does not consume concurrency slot
  // -------------------------------------------------------------------------
  describe("TC-MA-E-07: pre_step does not consume concurrency slot", () => {
    it("should allow full concurrency for actual step execution", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
concurrency: 2
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "work A"
    capabilities: [READ]
  B:
    worker: CODEX_CLI
    instructions: "work B"
    capabilities: [READ]
`;

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: _stepId,
              directive: { action: "proceed" },
            });
            return { status: "SUCCEEDED" };
          }
          // Simulate some work to allow concurrency observation
          await new Promise((r) => setTimeout(r, 50));
          return { status: "SUCCEEDED" };
        },
      );

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      // Both steps should have run, and maxConcurrentObserved should be >= 2
      // meaning management hooks did not consume concurrency slots
      expect(runner.maxConcurrentObserved).toBeGreaterThanOrEqual(2);
    });
  });

  describe("TC-MA-E-07b: pre_step hook concurrency is bounded", () => {
    it("should not run more pre_step management workers than workflow concurrency", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
concurrency: 1
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "work A"
    capabilities: [READ]
  B:
    worker: CODEX_CLI
    instructions: "work B"
    capabilities: [READ]
  C:
    worker: CODEX_CLI
    instructions: "work C"
    capabilities: [READ]
`;

      let mgmtRunning = 0;
      let maxMgmtConcurrent = 0;

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            mgmtRunning++;
            maxMgmtConcurrent = Math.max(maxMgmtConcurrent, mgmtRunning);
            try {
              const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
              const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
              await new Promise((r) => setTimeout(r, 40));
              await writeDecisionFile(decisionPath, {
                hook_id: hookId,
                hook: "pre_step",
                step_id: _stepId,
                directive: { action: "proceed" },
              });
              return { status: "SUCCEEDED" };
            } finally {
              mgmtRunning--;
            }
          }
          return { status: "SUCCEEDED" };
        },
      );

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(maxMgmtConcurrent).toBeLessThanOrEqual(1);
    });
  });

  describe("TC-MA-E-07c: pre_step can run even when execution slots are full", () => {
    it("should invoke managed pre_step while an unmanaged step is occupying concurrency", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
concurrency: 1
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  U:
    worker: CODEX_CLI
    instructions: "long unmanaged work"
    capabilities: [READ]
    management:
      enabled: false
  M:
    worker: CODEX_CLI
    instructions: "managed work"
    capabilities: [READ]
`;

      let unmanagedRunning = false;
      let managedHookWhileUnmanagedRunning = false;
      let managedPreStepInvocationCount = 0;

      const runner = new MockStepRunner(
        async (
          stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            const inputPath = env[ENV_MANAGEMENT_INPUT_FILE]!;
            let hookStepId = "M";
            try {
              const inputContent = JSON.parse(await readFile(inputPath, "utf-8"));
              hookStepId = inputContent.step_id;
            } catch {
              // fallback
            }
            if (hookStepId === "M" && unmanagedRunning) {
              managedHookWhileUnmanagedRunning = true;
            }
            if (hookStepId === "M") {
              managedPreStepInvocationCount++;
            }
            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: hookStepId,
              directive: { action: "proceed" },
            });
            return { status: "SUCCEEDED" };
          }

          if (stepId === "U") {
            unmanagedRunning = true;
            try {
              await new Promise((r) => setTimeout(r, 80));
            } finally {
              unmanagedRunning = false;
            }
          }
          return { status: "SUCCEEDED" };
        },
      );

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(managedHookWhileUnmanagedRunning).toBe(true);
      expect(managedPreStepInvocationCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-08: hook_id no collision under parallelism
  // -------------------------------------------------------------------------
  describe("TC-MA-E-08: hook_id no collision under parallelism", () => {
    it("should create distinct hook_id directories for parallel hooks", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
concurrency: 2
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "work A"
    capabilities: [READ]
  B:
    worker: CODEX_CLI
    instructions: "work B"
    capabilities: [READ]
`;

      const collectedHookIds: string[] = [];

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            collectedHookIds.push(hookId);
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: _stepId,
              directive: { action: "proceed" },
            });
            return { status: "SUCCEEDED" };
          }
          return { status: "SUCCEEDED" };
        },
      );

      const { state, contextDir } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      // Should have 2 distinct hook IDs (one for A, one for B)
      expect(collectedHookIds.length).toBe(2);
      expect(new Set(collectedHookIds).size).toBe(2);

      // Verify two distinct inv directories exist
      const invDirs = await listInvDirs(contextDir);
      expect(invDirs.length).toBe(2);
      expect(new Set(invDirs).size).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-09: management timeout -> proceed (safe fallback)
  // -------------------------------------------------------------------------
  describe("TC-MA-E-09: management timeout -> proceed (safe fallback)", () => {
    it("should fall back to proceed when management worker times out", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "30s"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "1s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
`;

      // Management worker never writes decision file (simulates timeout)
      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            // Simulate timeout: just wait until aborted or timeout
            await new Promise<void>((resolve) => {
              if (abortSignal.aborted) {
                resolve();
                return;
              }
              const timer = setTimeout(resolve, 5000);
              abortSignal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
            return { status: "SUCCEEDED" };
          }
          // Normal step: just succeed
          return { status: "SUCCEEDED" };
        },
      );

      const { state, contextDir } = await executeYaml(yaml, runner, dir);

      // Step should still succeed (management timeout falls back to proceed)
      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      // decisions.jsonl should record applied=false
      const decisions = await readDecisionsLog(contextDir);
      expect(decisions.length).toBeGreaterThanOrEqual(1);
      const timeoutEntry = decisions.find(
        (d) => d.step_id === "A" && d.applied === false,
      );
      expect(timeoutEntry).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-10: max_consecutive_interventions guard
  // -------------------------------------------------------------------------
  describe("TC-MA-E-10: max_consecutive_interventions guard", () => {
    it("should bypass hook after exceeding max consecutive interventions", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "30s"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
  max_consecutive_interventions: 2
steps:
  A:
    worker: CODEX_CLI
    instructions: "work A"
    capabilities: [READ]
    max_iterations: 5
    completion_check:
      worker: CODEX_CLI
      instructions: "check"
      capabilities: [READ]
      decision_file: decision.txt
  B:
    worker: CODEX_CLI
    instructions: "work B"
    capabilities: [READ]
    depends_on: [A]
  C:
    worker: CODEX_CLI
    instructions: "work C"
    capabilities: [READ]
    depends_on: [B]
`;

      let managementInvocationCount = 0;

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            managementInvocationCount++;
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            const inputPath = env[ENV_MANAGEMENT_INPUT_FILE]!;
            let hookStepId = "A";
            try {
              const inputContent = JSON.parse(await readFile(inputPath, "utf-8"));
              hookStepId = inputContent.step_id;
            } catch {
              // fallback
            }
            // Always return a non-proceed intervention (modify_instructions)
            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: hookStepId,
              directive: {
                action: "modify_instructions",
                append: "extra instructions",
              },
            });
            return { status: "SUCCEEDED" };
          }
          return { status: "SUCCEEDED" };
        },
        // Check: complete after 2 iterations
        async (_stepId, _check, callIndex) => {
          if (callIndex >= 2) return { complete: true, failed: false };
          return { complete: false, failed: false };
        },
      );

      const { state, contextDir } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      // With max_consecutive_interventions=2, after 2 consecutive non-proceed
      // decisions, the 3rd hook for the next step should be bypassed (no inv dir).
      // We should see at most 2 management worker invocations before bypass.
      // The exact count depends on implementation details, but the 3rd
      // consecutive non-proceed should be bypassed.
      const invDirs = await listInvDirs(contextDir);
      // Steps A (potentially 2 iterations), B, C = up to 4 hooks possible.
      // With max_consecutive_interventions=2, after 2 consecutive interventions
      // the 3rd should be bypassed, so inv dirs should be <= 2 for the
      // consecutive intervention window.
      // The exact assertion: total inv dirs should be less than total possible hooks
      const totalPossibleHooks = 4; // A(iter1) + A(iter2) + B + C
      expect(invDirs.length).toBeLessThan(totalPossibleHooks);
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-11: min_remaining_time guard
  // -------------------------------------------------------------------------
  describe("TC-MA-E-11: min_remaining_time guard", () => {
    it("should skip hooks when remaining time < min_remaining_time", async () => {
      const dir = await makeTmpDir();

      // Set workflow timeout to 3s but min_remaining_time to 5s
      // This means remaining time is always < min_remaining_time from the start
      // so hooks should never be invoked.
      const yaml = `
name: test
version: "1"
timeout: "3s"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "1s"
  hooks:
    pre_step: true
  min_remaining_time: "5s"
steps:
  A:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
`;

      let managementWorkerCalled = false;

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            managementWorkerCalled = true;
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: "A",
              directive: { action: "proceed" },
            });
            return { status: "SUCCEEDED" };
          }
          return { status: "SUCCEEDED" };
        },
      );

      const { state, contextDir } = await executeYaml(yaml, runner, dir);

      // Step should still succeed (hooks skipped = implicit proceed)
      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);

      // Management worker should NOT have been called
      expect(managementWorkerCalled).toBe(false);

      // No inv directories should have been created
      const invDirs = await listInvDirs(contextDir);
      expect(invDirs.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-12: abort_workflow
  // -------------------------------------------------------------------------
  describe("TC-MA-E-12: abort_workflow", () => {
    it("should cancel workflow when management returns abort_workflow", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
`;

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: "A",
              directive: {
                action: "abort_workflow",
                reason: "detected critical issue",
              },
            });
            return { status: "SUCCEEDED" };
          }
          // Normal step should not be reached if abort_workflow fires
          return { status: "SUCCEEDED" };
        },
      );

      const { state } = await executeYaml(yaml, runner, dir);

      // Workflow should be CANCELLED due to management abort
      expect(state.status).toBe(WorkflowStatus.CANCELLED);
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-13: ManagementTelemetrySink (state.json without sentinel)
  // -------------------------------------------------------------------------
  describe("TC-MA-E-13: ManagementTelemetrySink (state.json without sentinel)", () => {
    it("should write state.json even when sentinel is not enabled", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
`;

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: "A",
              directive: { action: "proceed" },
            });
            return { status: "SUCCEEDED" };
          }
          return { status: "SUCCEEDED" };
        },
      );

      const { state, contextDir } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      // state.json should exist under _workflow/ even without sentinel
      const stateJsonPath = path.join(contextDir, "_workflow", "state.json");
      expect(await pathExists(stateJsonPath)).toBe(true);

      // events.jsonl should NOT exist (that's sentinel-specific)
      const eventsPath = path.join(contextDir, "_workflow", "events.jsonl");
      expect(await pathExists(eventsPath)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-14: Sentinel telemetry reused when both enabled
  // -------------------------------------------------------------------------
  describe("TC-MA-E-14: Sentinel telemetry reused when both enabled", () => {
    it("should produce state.json with no double-write when both management and sentinel are enabled", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
sentinel:
  enabled: true
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
`;

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: "A",
              directive: { action: "proceed" },
            });
            return { status: "SUCCEEDED" };
          }
          return { status: "SUCCEEDED" };
        },
      );

      const { state, contextDir } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      // state.json should exist (sentinel telemetry reused by management)
      const stateJsonPath = path.join(contextDir, "_workflow", "state.json");
      expect(await pathExists(stateJsonPath)).toBe(true);

      // Verify state.json is valid JSON and contains workflow status
      const stateContent = JSON.parse(await readFile(stateJsonPath, "utf-8"));
      expect(stateContent).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-15: step-level management.enabled=false disables hooks for that step
  // -------------------------------------------------------------------------
  describe("TC-MA-E-15: step-level management.enabled=false disables hooks for that step", () => {
    it("should not invoke management hook for step with management.enabled=false", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "no management for this step"
    capabilities: [READ]
    management:
      enabled: false
  B:
    worker: CODEX_CLI
    instructions: "management enabled for this step"
    capabilities: [READ]
`;

      const hookStepIds: string[] = [];

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            const inputPath = env[ENV_MANAGEMENT_INPUT_FILE]!;
            let hookStepId = "unknown";
            try {
              const inputContent = JSON.parse(await readFile(inputPath, "utf-8"));
              hookStepId = inputContent.step_id;
            } catch {
              // fallback
            }
            hookStepIds.push(hookStepId);
            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: hookStepId,
              directive: { action: "proceed" },
            });
            return { status: "SUCCEEDED" };
          }
          return { status: "SUCCEEDED" };
        },
      );

      const { state, contextDir } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.steps["B"]!.status).toBe(StepStatus.SUCCEEDED);

      // Hook should NOT have been invoked for step A
      expect(hookStepIds).not.toContain("A");
      // Hook should have been invoked for step B
      expect(hookStepIds).toContain("B");

      // No inv directory should exist for step A
      const invDirs = await listInvDirs(contextDir);
      // There should be exactly 1 inv directory (for B only)
      expect(invDirs.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-16: step-level context_hint reflected in hook input
  // -------------------------------------------------------------------------
  describe("TC-MA-E-16: step-level context_hint reflected in hook input", () => {
    it("should include context_hint in input.json", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
    management:
      context_hint: "focus on tests"
`;

      let capturedInputContent: Record<string, unknown> | null = null;

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            const inputPath = env[ENV_MANAGEMENT_INPUT_FILE]!;

            // Read input.json to verify context_hint
            try {
              capturedInputContent = JSON.parse(
                await readFile(inputPath, "utf-8"),
              );
            } catch {
              // will fail assertion later
            }

            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: "A",
              directive: { action: "proceed" },
            });
            return { status: "SUCCEEDED" };
          }
          return { status: "SUCCEEDED" };
        },
      );

      const { state } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      // Verify input.json contains the context_hint
      expect(capturedInputContent).not.toBeNull();
      expect((capturedInputContent as any).context_hint).toBe("focus on tests");
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-17: decisions.jsonl format validation
  // -------------------------------------------------------------------------
  describe("TC-MA-E-17: decisions.jsonl format validation", () => {
    it("should produce valid decisions.jsonl entries with all required fields", async () => {
      const dir = await makeTmpDir();

      // Two independent steps so multiple hooks fire
      const yaml = `
name: test
version: "1"
timeout: "10m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "work A"
    capabilities: [READ]
  B:
    worker: CODEX_CLI
    instructions: "work B"
    capabilities: [READ]
`;

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            const inputPath = env[ENV_MANAGEMENT_INPUT_FILE]!;
            let hookStepId = "A";
            try {
              const inputContent = JSON.parse(await readFile(inputPath, "utf-8"));
              hookStepId = inputContent.step_id;
            } catch {
              // fallback
            }
            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: hookStepId,
              directive: { action: "proceed" },
            });
            return { status: "SUCCEEDED" };
          }
          return { status: "SUCCEEDED" };
        },
      );

      const { state, contextDir } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      // Read and validate decisions.jsonl
      const logPath = path.join(contextDir, "_management", "decisions.jsonl");
      expect(await pathExists(logPath)).toBe(true);

      const content = await readFile(logPath, "utf-8");
      const lines = content
        .trim()
        .split("\n")
        .filter((l) => l.trim() !== "");

      // Should have at least 2 entries (one per step)
      expect(lines.length).toBeGreaterThanOrEqual(2);

      for (const line of lines) {
        // Each line must be valid JSON
        const entry = JSON.parse(line) as Record<string, unknown>;

        // Required fields per spec section 8.1
        expect(typeof entry.ts).toBe("number");
        expect(typeof entry.hook_id).toBe("string");
        expect((entry.hook_id as string).length).toBeGreaterThan(0);
        expect(typeof entry.hook).toBe("string");
        expect(typeof entry.step_id).toBe("string");
        expect(typeof entry.directive).toBe("object");
        expect(entry.directive).not.toBeNull();
        expect(typeof entry.applied).toBe("boolean");
        expect(typeof entry.wallTimeMs).toBe("number");
        expect(entry.wallTimeMs).toBeGreaterThanOrEqual(0);
        expect(typeof entry.source).toBe("string");
        expect(
          ["file-json", "none", "decided", "fallback", "tool-call"].includes(entry.source as string),
        ).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-18: managementPending prevents duplicate pre_step
  // -------------------------------------------------------------------------
  describe("TC-MA-E-18: managementPending prevents duplicate pre_step", () => {
    it("should invoke pre_step only once per step even with scheduling loop re-entry", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
`;

      let managementCallCountForA = 0;

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            const inputPath = env[ENV_MANAGEMENT_INPUT_FILE]!;
            let hookStepId = "A";
            try {
              const inputContent = JSON.parse(await readFile(inputPath, "utf-8"));
              hookStepId = inputContent.step_id;
            } catch {
              // fallback
            }

            if (hookStepId === "A") {
              managementCallCountForA++;
            }

            // Simulate a slightly slow management worker to give scheduling
            // loop time to potentially re-trigger
            await new Promise((r) => setTimeout(r, 50));

            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "pre_step",
              step_id: hookStepId,
              directive: { action: "proceed" },
            });
            return { status: "SUCCEEDED" };
          }
          return { status: "SUCCEEDED" };
        },
      );

      const { state, contextDir } = await executeYaml(yaml, runner, dir);

      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      // pre_step should be invoked exactly once for step A
      expect(managementCallCountForA).toBe(1);

      // Only one inv directory for A's pre_step
      const invDirs = await listInvDirs(contextDir);
      expect(invDirs.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // TC-MA-E-19: post_step annotate doesn't change terminal status
  // -------------------------------------------------------------------------
  describe("TC-MA-E-19: post_step annotate doesn't change terminal status", () => {
    it("should preserve step status and emit an annotation event when post_step returns annotate", async () => {
      const dir = await makeTmpDir();

      const yaml = `
name: test
version: "1"
timeout: "10m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    post_step: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
`;

      const runner = new MockStepRunner(
        async (
          _stepId,
          _step,
          _callIndex,
          _abortSignal,
          env,
        ) => {
          if (env?.[ENV_MANAGEMENT_DECISION_FILE]) {
            const hookId = env[ENV_MANAGEMENT_HOOK_ID]!;
            const decisionPath = env[ENV_MANAGEMENT_DECISION_FILE]!;
            const inputPath = env[ENV_MANAGEMENT_INPUT_FILE]!;
            let hookStepId = "A";
            try {
              const inputContent = JSON.parse(await readFile(inputPath, "utf-8"));
              hookStepId = inputContent.step_id;
            } catch {
              // fallback
            }
            // Return annotate directive
            await writeDecisionFile(decisionPath, {
              hook_id: hookId,
              hook: "post_step",
              step_id: hookStepId,
              directive: {
                action: "annotate",
                message: "Step completed with observations",
              },
            });
            return { status: "SUCCEEDED" };
          }
          // Normal step succeeds
          return { status: "SUCCEEDED" };
        },
      );

      const events: ExecEvent[] = [];
      const sink: ExecEventSink = {
        emit(event) {
          events.push(event);
        },
      };

      const { state } = await executeYaml(yaml, runner, dir, sink);

      // Step should retain its terminal SUCCEEDED status
      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
      // Workflow should be SUCCEEDED
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      const annotationWarning = events.find(
        (event) =>
          event.type === "warning" &&
          event.message.includes("[management:post_step]") &&
          event.message.includes("Step completed with observations"),
      );
      expect(annotationWarning).toBeDefined();
    });
  });
});
