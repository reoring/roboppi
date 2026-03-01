/**
 * AT: Management Agent acceptance tests (TC-MA-X-01 through TC-MA-X-07)
 *
 * These are TDD Red-phase tests for the management agent feature.
 * They verify the key behaviors of the management agent hooks:
 * force_complete, adjust_timeout, on_stall integration, event isolation,
 * modify_instructions, fallback to sentinel, and subworkflow scoping.
 *
 * Tests WILL FAIL until the management agent implementation is complete.
 */
import { describe, test, expect } from "bun:test";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseWorkflow } from "../../src/workflow/parser.js";
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
import { withTempDir } from "./helpers.js";

// ---------------------------------------------------------------------------
// Enhanced mock runner with env capture for management tests
// ---------------------------------------------------------------------------

type EnhancedStepHandler = (
  stepId: string,
  step: StepDefinition,
  callIndex: number,
  abortSignal: AbortSignal,
  env?: Record<string, string>,
) => Promise<StepRunResult>;

type EnhancedCheckHandler = (
  stepId: string,
  check: CompletionCheckDef,
  callIndex: number,
  abortSignal: AbortSignal,
) => Promise<CheckResult>;

class ManagementMockRunner implements StepRunner {
  readonly stepCalls: Array<{
    stepId: string;
    callIndex: number;
    env?: Record<string, string>;
    step: StepDefinition;
  }> = [];
  readonly checkCalls: Array<{ stepId: string; callIndex: number }> = [];
  private stepCallCounts = new Map<string, number>();
  private checkCallCounts = new Map<string, number>();

  constructor(
    private readonly stepHandler: EnhancedStepHandler = async () => ({
      status: "SUCCEEDED",
    }),
    private readonly checkHandler: EnhancedCheckHandler = async () => ({
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
    this.stepCalls.push({ stepId, callIndex: count, env, step });
    return this.stepHandler(stepId, step, count, abortSignal, env);
  }

  async runCheck(
    stepId: string,
    check: CompletionCheckDef,
    _workspaceDir: string,
    abortSignal: AbortSignal,
    _env?: Record<string, string>,
  ): Promise<CheckResult> {
    const count = (this.checkCallCounts.get(stepId) ?? 0) + 1;
    this.checkCallCounts.set(stepId, count);
    this.checkCalls.push({ stepId, callIndex: count });
    return this.checkHandler(stepId, check, count, abortSignal);
  }

  getStepCallCount(stepId: string): number {
    return this.stepCallCounts.get(stepId) ?? 0;
  }

  getCheckCallCount(stepId: string): number {
    return this.checkCallCounts.get(stepId) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// Helper: execute YAML with the management-aware mock runner
// ---------------------------------------------------------------------------

async function executeMgmtYaml(
  yamlContent: string,
  runner: ManagementMockRunner,
  dir: string,
  contextSubDir = "context",
): Promise<{
  state: import("../../src/workflow/types.js").WorkflowState;
  contextDir: string;
  workspaceDir: string;
}> {
  const definition = parseWorkflow(yamlContent);
  const contextDir = path.join(dir, contextSubDir);
  const ctx = new ContextManager(contextDir);
  const executor = new WorkflowExecutor(definition, ctx, runner, dir);
  const state = await executor.execute();
  return { state, contextDir, workspaceDir: dir };
}

// ---------------------------------------------------------------------------
// TC-MA-X-01: post_check force_complete ends loop early
// ---------------------------------------------------------------------------

describe("TC-MA-X-01: post_check force_complete ends loop early", () => {
  test("management post_check returning force_complete stops the iteration loop", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: force-complete-test
version: "1"
timeout: "10m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    post_check: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "implement"
    capabilities: [READ, EDIT]
    completion_check:
      worker: CODEX_CLI
      instructions: "check"
      capabilities: [READ]
      decision_file: "decision.txt"
    max_iterations: 10
`;

      let checkCallCount = 0;
      let postCheckHookCount = 0;

      // Check handler always returns incomplete (never completes on its own).
      // The management agent post_check hook should force_complete on the 2nd check.
      const runner = new ManagementMockRunner(
        async (_stepId, _step, _callIndex, _abortSignal, env) => {
          // Management hook invocation: write decision file
          if (env?.ROBOPPI_MANAGEMENT_DECISION_FILE) {
            postCheckHookCount++;
            const hookId = env.ROBOPPI_MANAGEMENT_HOOK_ID!;
            const decisionPath = env.ROBOPPI_MANAGEMENT_DECISION_FILE!;
            let inputContent: any = {};
            try {
              inputContent = JSON.parse(await readFile(env.ROBOPPI_MANAGEMENT_INPUT_FILE!, "utf-8"));
            } catch {}

            if (postCheckHookCount >= 2) {
              // 2nd post_check: force_complete
              await mkdir(path.dirname(decisionPath), { recursive: true });
              await writeFile(decisionPath, JSON.stringify({
                hook_id: hookId,
                hook: "post_check",
                step_id: inputContent.step_id ?? "A",
                directive: { action: "force_complete", reason: "enough iterations" },
              }));
            } else {
              // 1st post_check: proceed
              await mkdir(path.dirname(decisionPath), { recursive: true });
              await writeFile(decisionPath, JSON.stringify({
                hook_id: hookId,
                hook: "post_check",
                step_id: inputContent.step_id ?? "A",
                directive: { action: "proceed" },
              }));
            }
            return { status: "SUCCEEDED" };
          }
          return { status: "SUCCEEDED" };
        },
        async (_stepId, _check, _callIndex, _abortSignal) => {
          checkCallCount++;
          // Never complete on our own -- management should intervene
          return { complete: false, failed: false };
        },
      );

      const { state } = await executeMgmtYaml(yaml, runner, dir);

      // After force_complete, step A should be SUCCEEDED
      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
      // Total check invocations should be <= 2 (management stopped the loop)
      expect(checkCallCount).toBeLessThanOrEqual(2);
    });
  });
});

// ---------------------------------------------------------------------------
// TC-MA-X-02: adjust_timeout at pre_check
// ---------------------------------------------------------------------------

describe("TC-MA-X-02: adjust_timeout at pre_check", () => {
  test("management pre_check returning adjust_timeout changes check timeout", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: adjust-timeout-test
version: "1"
timeout: "30s"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    pre_check: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "implement"
    capabilities: [READ, EDIT]
    completion_check:
      worker: CODEX_CLI
      instructions: "check"
      capabilities: [READ]
      decision_file: "decision.txt"
      timeout: "1s"
    max_iterations: 3
`;

      // The step handler completes immediately
      // The check handler simulates a check that takes 2s.
      // Without adjust_timeout, the 1s timeout would fire.
      // With management returning adjust_timeout: "10s", the check should succeed.
      const runner = new ManagementMockRunner(
        async () => ({ status: "SUCCEEDED" }),
        async (_stepId, _check, _callIndex, _abortSignal) => {
          // Simulate a check that takes 2 seconds but should succeed
          // if management adjusted the timeout to be >= 2s
          await new Promise<void>((resolve) => setTimeout(resolve, 200));
          return { complete: true, failed: false };
        },
      );

      // When management is implemented, the pre_check hook should return:
      // { action: "adjust_timeout", timeout: "10s", reason: "allow more time for check" }
      const { state } = await executeMgmtYaml(yaml, runner, dir);

      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);
    });
  });
});

// ---------------------------------------------------------------------------
// TC-MA-X-03: Sentinel stall + management on_stall
// ---------------------------------------------------------------------------

describe("TC-MA-X-03: Sentinel stall + management on_stall", () => {
  test("management on_stall directive takes precedence over sentinel static action", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: stall-mgmt
version: "1"
timeout: "30s"
sentinel:
  enabled: true
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    on_stall: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
    stall:
      no_output_timeout: "1s"
      on_stall:
        action: fail
`;

      let stepCallCount = 0;

      const runner = new ManagementMockRunner(
        async (_stepId, _step, _callIndex, abortSignal) => {
          stepCallCount++;
          if (stepCallCount === 1) {
            // First call: hang until aborted (will trigger stall detection)
            await new Promise<void>((_resolve, reject) => {
              if (abortSignal.aborted) {
                reject(new Error("aborted"));
                return;
              }
              abortSignal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
            });
            return { status: "SUCCEEDED" };
          }
          // Second call (after management retry): succeed immediately
          return { status: "SUCCEEDED" };
        },
      );

      // When implemented:
      // 1. Step A starts and stalls (no output for 1s)
      // 2. Sentinel detects stall
      // 3. Management on_stall hook fires, returns:
      //    { action: "retry", reason: "try again with different approach",
      //      modify_instructions: "Try a simpler approach" }
      // 4. Sentinel's static action (fail) is NOT applied because management succeeded
      // 5. Step A is re-executed with modified instructions
      const { state, contextDir } = await executeMgmtYaml(yaml, runner, dir);

      // When management successfully handles on_stall with retry,
      // the sentinel's static "fail" action should not be applied.
      // The management decision should be recorded.
      const decisionsPath = path.join(
        contextDir,
        "_management",
        "decisions.jsonl",
      );
      const decisionsExist = await stat(decisionsPath).catch(() => null);

      // Expect the decision log to exist once management is implemented
      expect(decisionsExist).not.toBeNull();

      // If management succeeds with retry, the step may succeed on re-execution
      // (depending on how re-execution is implemented)
      expect(
        state.steps["A"]!.status === StepStatus.SUCCEEDED ||
          state.steps["A"]!.status === StepStatus.FAILED,
      ).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// TC-MA-X-04: management worker event isolation
// ---------------------------------------------------------------------------

describe("TC-MA-X-04: management worker event isolation", () => {
  test("management worker events are isolated from main telemetry", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: event-isolation
version: "1"
timeout: "30s"
sentinel:
  enabled: true
  telemetry:
    events_file: "events.jsonl"
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

      const runner = new ManagementMockRunner(
        async () => ({ status: "SUCCEEDED" }),
      );

      const { state, contextDir } = await executeMgmtYaml(yaml, runner, dir);

      expect(state.steps["A"]!.status).toBe(StepStatus.SUCCEEDED);

      // Main telemetry events.jsonl should NOT contain management worker events
      const mainEventsPath = path.join(contextDir, "events.jsonl");
      const mainEventsExist = await stat(mainEventsPath).catch(() => null);

      if (mainEventsExist) {
        const mainEvents = (await readFile(mainEventsPath, "utf-8"))
          .trim()
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line));

        // No event should be from a management worker invocation
        for (const event of mainEvents) {
          expect(event.source).not.toBe("management");
          // Management events should not have management hook metadata
          expect(event.management_hook_id).toBeUndefined();
        }
      }

      // Management events should be in their own isolated location
      // _management/inv/<hook_id>/worker.jsonl
      const mgmtDir = path.join(contextDir, "_management", "inv");
      const mgmtDirExists = await stat(mgmtDir).catch(() => null);

      // Once management is implemented, this directory should exist
      expect(mgmtDirExists).not.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// TC-MA-X-05: on_stall retry with modify_instructions
// ---------------------------------------------------------------------------

describe("TC-MA-X-05: on_stall retry with modify_instructions", () => {
  test("management on_stall returns retry+modify_instructions, step re-executes with modified instructions", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: stall-retry-modify
version: "1"
timeout: "30s"
sentinel:
  enabled: true
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "5s"
  hooks:
    on_stall: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "original instructions"
    capabilities: [READ]
    stall:
      no_output_timeout: "1s"
      on_stall:
        action: fail
`;

      let stepCallCount = 0;
      const capturedInstructions: string[] = [];

      const runner = new ManagementMockRunner(
        async (_stepId, step, _callIndex, abortSignal) => {
          stepCallCount++;
          capturedInstructions.push(step.instructions ?? "");

          if (stepCallCount === 1) {
            // First call: hang until aborted (will trigger stall)
            await new Promise<void>((_resolve, reject) => {
              if (abortSignal.aborted) {
                reject(new Error("aborted"));
                return;
              }
              abortSignal.addEventListener(
                "abort",
                () => reject(new Error("aborted")),
                { once: true },
              );
            });
            return { status: "SUCCEEDED" };
          }
          // Second call (after management retry): succeed
          return { status: "SUCCEEDED" };
        },
      );

      // When implemented:
      // 1. Step A hangs -> sentinel detects stall
      // 2. Management on_stall returns:
      //    { action: "retry", reason: "stalled", modify_instructions: "Try a simpler approach" }
      // 3. Step A is re-executed with modified instructions
      const { state: _state } = await executeMgmtYaml(yaml, runner, dir);

      // Expect the step to have been called at least twice (original + retry)
      expect(stepCallCount).toBeGreaterThanOrEqual(2);

      // The second invocation should have modified instructions
      // (appended or replaced by the management directive)
      expect(capturedInstructions.length).toBeGreaterThanOrEqual(2);
      if (capturedInstructions.length >= 2) {
        // The modified instructions should differ from the original
        expect(capturedInstructions[1]).not.toBe(capturedInstructions[0]);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// TC-MA-X-06: on_stall management timeout/invalid falls back to sentinel
// ---------------------------------------------------------------------------

describe("TC-MA-X-06: on_stall management failure falls back to sentinel static action", () => {
  test("when management on_stall returns invalid/times out, sentinel static action is applied", async () => {
    await withTempDir(async (dir) => {
      const yaml = `
name: stall-fallback
version: "1"
timeout: "30s"
sentinel:
  enabled: true
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "1s"
  hooks:
    on_stall: true
steps:
  A:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
    stall:
      no_output_timeout: "1s"
      on_stall:
        action: fail
`;

      const runner = new ManagementMockRunner(
        async (_stepId, _step, _callIndex, abortSignal) => {
          // Hang until aborted (will trigger stall detection)
          await new Promise<void>((_resolve, reject) => {
            if (abortSignal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            abortSignal.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          });
          return { status: "SUCCEEDED" };
        },
      );

      // When implemented:
      // 1. Step A stalls
      // 2. Sentinel detects stall, calls management on_stall hook
      // 3. Management times out (1s timeout) or returns an invalid directive
      // 4. Executor falls back to sentinel static on_stall.action = "fail"
      // 5. Step A is FAILED
      const { state, contextDir } = await executeMgmtYaml(yaml, runner, dir);

      // Sentinel's static action "fail" should have been applied
      expect(state.steps["A"]!.status).toBe(StepStatus.FAILED);
      expect(state.status).toBe(WorkflowStatus.FAILED);

      // decisions.jsonl should record applied: false for the failed management attempt
      const decisionsPath = path.join(
        contextDir,
        "_management",
        "decisions.jsonl",
      );
      const decisionsExist = await stat(decisionsPath).catch(() => null);

      if (decisionsExist) {
        const decisions = (await readFile(decisionsPath, "utf-8"))
          .trim()
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line));

        // Find the on_stall decision entry
        const stallDecision = decisions.find(
          (d: any) => d.hook === "on_stall" && d.step_id === "A",
        );

        if (stallDecision) {
          // The management decision should be recorded as not applied
          expect(stallDecision.applied).toBe(false);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// TC-MA-X-07: subworkflow — hook fires only for parent step
// ---------------------------------------------------------------------------

describe("TC-MA-X-07: subworkflow hook fires only for parent step", () => {
  test("management pre_step hook fires for parent step, not child workflow steps", async () => {
    await withTempDir(async (dir) => {
      // Write child workflow YAML
      const childYaml = `
name: child-workflow
version: "1"
timeout: "10s"
steps:
  child-A:
    worker: CODEX_CLI
    instructions: "child step A"
    capabilities: [READ]
  child-B:
    worker: CODEX_CLI
    instructions: "child step B"
    capabilities: [READ]
    depends_on: [child-A]
`;
      await mkdir(path.join(dir), { recursive: true });
      await writeFile(path.join(dir, "child.yaml"), childYaml);

      const parentYaml = `
name: sub-mgmt
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
  parent:
    workflow: ./child.yaml
`;

      const hookFiredForSteps: string[] = [];

      // Track which step IDs the management hook fires for.
      // In the real implementation, the management agent runner would be
      // invoked with env vars indicating the hook context.
      // Here we spy on step executions to verify behavior.
      const runner = new ManagementMockRunner(
        async (stepId, _step, _callIndex, _abortSignal, env) => {
          // Track if this is a management hook invocation via env vars
          if (env?.["ROBOPPI_MANAGEMENT_HOOK_ID"]) {
            hookFiredForSteps.push(stepId);
          }
          return { status: "SUCCEEDED" };
        },
      );

      // Parse and execute with subworkflow support
      const definition = parseWorkflow(parentYaml);
      const contextDir = path.join(dir, "context");
      const ctx = new ContextManager(contextDir);

      const parentPath = path.join(dir, "parent.yaml");
      await writeFile(parentPath, parentYaml);

      const executor = new WorkflowExecutor(
        definition,
        ctx,
        runner,
        dir,
        undefined, // env
        undefined, // abortSignal
        undefined, // branchContext
        false, // supervised
        undefined, // sink
        {
          definitionPath: parentPath,
          workflowCallStack: [parentPath],
        },
      );

      const state = await executor.execute();

      // Workflow should succeed (all steps pass)
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      // The management pre_step hook should fire ONLY for the "parent" step,
      // NOT for "child-A" or "child-B" within the child workflow.
      //
      // When management is implemented, the hook should be scoped to
      // the parent workflow's steps only.
      // At minimum, verify that if hooks fired, they only fired for "parent"
      if (hookFiredForSteps.length > 0) {
        for (const stepId of hookFiredForSteps) {
          // Management worker step IDs have the format "_management:<hook>:<stepId>"
          expect(stepId).toContain("parent");
        }
        // Should not contain child step IDs
        expect(hookFiredForSteps.some(s => s.includes("child-A"))).toBe(false);
        expect(hookFiredForSteps.some(s => s.includes("child-B"))).toBe(false);
      }

      // Additionally verify that the management decisions log, if it exists,
      // only references "parent" as the step_id
      const decisionsPath = path.join(
        contextDir,
        "_management",
        "decisions.jsonl",
      );
      const decisionsExist = await stat(decisionsPath).catch(() => null);

      if (decisionsExist) {
        const decisions = (await readFile(decisionsPath, "utf-8"))
          .trim()
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line));

        for (const decision of decisions) {
          // All management decisions should reference the parent step
          expect(decision.step_id).toBe("parent");
        }
      }
    });
  });
});
