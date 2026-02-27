/**
 * Integration tests: ManagementController x Engine abstraction
 *
 * TDD RED phase — these tests reference types and modules that do NOT exist yet.
 * They validate the ManagementController's behavior when using different engine
 * implementations (WorkerEngine and PiSdkEngine).
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// --- Existing types ---
import {
  type StepRunner,
  type StepRunResult,
  type CheckResult,
} from "../../src/workflow/executor.js";
import type {
  StepDefinition,
} from "../../src/workflow/types.js";
import { StepStatus } from "../../src/workflow/types.js";
import type { ManagementDirective } from "../../src/workflow/management/types.js";
import {
  ENV_MANAGEMENT_HOOK_ID,
  ENV_MANAGEMENT_DECISION_FILE,
} from "../../src/workflow/management/types.js";

// --- New types/classes that will be created ---
import { WorkerEngine } from "../../src/workflow/management/worker-engine.js";
import { PiSdkEngine } from "../../src/workflow/management/pi-sdk-engine.js";
import { ManagementController } from "../../src/workflow/management/management-controller.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "roboppi-pi-int-"));
  tmpDirs.push(dir);
  return dir;
}

/** Create a mock StepRunner that writes decision.json when invoked for management hooks. */
function createMockStepRunner(opts?: {
  decisionOverride?: ManagementDirective;
}) {
  const calls: Array<{
    stepId: string;
    step: StepDefinition;
    workspace: string;
    signal: AbortSignal;
    env?: Record<string, string>;
  }> = [];

  const stepRunner: StepRunner = {
    runStep: async (
      stepId: string,
      step: StepDefinition,
      workspace: string,
      signal: AbortSignal,
      env?: Record<string, string>,
    ): Promise<StepRunResult> => {
      calls.push({ stepId, step, workspace, signal, env });

      // If this is a management invocation, write decision.json
      if (stepId.startsWith("_management:") && env) {
        const hookId = env[ENV_MANAGEMENT_HOOK_ID];
        const decisionFile = env[ENV_MANAGEMENT_DECISION_FILE];
        if (decisionFile && hookId) {
          const dir = path.dirname(decisionFile);
          await mkdir(dir, { recursive: true });
          const directive = opts?.decisionOverride ?? { action: "proceed" };
          await writeFile(
            decisionFile,
            JSON.stringify({
              hook_id: hookId,
              hook: "pre_step",
              step_id: "s1",
              directive,
            }),
          );
        }
      }

      return {
        status: "SUCCEEDED" as any,
      };
    },
    runCheck: async (): Promise<CheckResult> => {
      return { complete: true, failed: false };
    },
  };

  return { stepRunner, calls };
}

/** Create a mock Pi SDK session. */
function createMockPiSession() {
  let registeredTools: Array<{ name: string; execute: Function }> = [];
  let disposed = false;
  let promptCalls: string[] = [];

  const session = {
    prompt: mock(async (text: string) => {
      promptCalls.push(text);
      // Simulate the agent calling the decision tool
      const decisionTool = registeredTools.find(
        (t) => t.name === "roboppi_management_decision",
      );
      if (decisionTool) {
        // Extract hook_id from prompt text (simplified extraction)
        const hookIdMatch = text.match(/hook_id[:\s]*"?([^"\s,}]+)/);
        const hookId = hookIdMatch?.[1] ?? "unknown";
        await decisionTool.execute("call-1", {
          hook_id: hookId,
          hook: "pre_step",
          step_id: "s1",
          directive: { action: "proceed" },
        });
      }
    }),
    subscribe: mock((_listener: Function) => () => {}),
    dispose: mock(() => {
      disposed = true;
    }),
    get isDisposed() {
      return disposed;
    },
  };

  const mockCreateAgentSession = mock(async (opts: any) => {
    if (opts?.customTools) {
      registeredTools = opts.customTools;
    }
    return { session };
  });

  return {
    session,
    mockCreateAgentSession,
    get registeredTools() {
      return registeredTools;
    },
    get promptCalls() {
      return promptCalls;
    },
  };
}

// ===========================================================================
// Integration tests
// ===========================================================================

describe("ManagementController + Engine integration", () => {
  // TC-PI-I-01
  it("TC-PI-I-01: ManagementController with WorkerEngine produces same behavior as current implementation", async () => {
    const tmpDir = await makeTmpDir();
    const contextDir = path.join(tmpDir, "context");
    await mkdir(contextDir, { recursive: true });

    const { stepRunner, calls } = createMockStepRunner({
      decisionOverride: { action: "proceed" },
    });

    const engine = new WorkerEngine({
      contextDir,
      stepRunner,
      workspaceDir: tmpDir,
      agentConfig: {
        worker: "OPENCODE",
        capabilities: ["READ"],
        base_instructions: "Management agent.",
      },
    });

    const controller = new ManagementController(
      contextDir,
      {
        enabled: true,
        agent: {
          worker: "OPENCODE",
          capabilities: ["READ"],
          base_instructions: "Management agent.",
        },
        hooks: { pre_step: true },
      },
      engine,
    );

    const ac = new AbortController();
    const directive = await controller.invokeHook(
      "pre_step",
      "s1",
      StepStatus.READY,
      { s1: { status: StepStatus.READY, iteration: 0, maxIterations: 3 } },
      ac.signal,
    );

    expect(directive).toEqual({ action: "proceed" });

    // Verify the worker was called
    const mgmtCalls = calls.filter((c) => c.stepId.startsWith("_management:"));
    expect(mgmtCalls.length).toBeGreaterThanOrEqual(1);
  });

  // TC-PI-I-02
  it("TC-PI-I-02: ManagementController with PiSdkEngine invokes session.prompt", async () => {
    const tmpDir = await makeTmpDir();
    const contextDir = path.join(tmpDir, "context");
    await mkdir(contextDir, { recursive: true });

    const mockPi = createMockPiSession();

    const engine = new PiSdkEngine({
      contextDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
        base_instructions: "Management agent.",
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const controller = new ManagementController(
      contextDir,
      {
        enabled: true,
        agent: {
          model: "claude-sonnet-4-5",
          capabilities: ["READ"],
          base_instructions: "Management agent.",
          engine: "pi" as any,
        },
        hooks: { pre_step: true },
      },
      engine,
    );

    const ac = new AbortController();
    const directive = await controller.invokeHook(
      "pre_step",
      "s1",
      StepStatus.READY,
      { s1: { status: StepStatus.READY, iteration: 0, maxIterations: 3 } },
      ac.signal,
    );

    expect(directive).toEqual({ action: "proceed" });

    // session.prompt should have been called
    expect(mockPi.session.prompt).toHaveBeenCalled();
    expect(mockPi.promptCalls.length).toBeGreaterThanOrEqual(1);
  });

  // TC-PI-I-03
  it("TC-PI-I-03: PiSdkEngine persistent session survives multiple hook invocations", async () => {
    const tmpDir = await makeTmpDir();
    const contextDir = path.join(tmpDir, "context");
    await mkdir(contextDir, { recursive: true });

    const mockPi = createMockPiSession();

    const engine = new PiSdkEngine({
      contextDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const controller = new ManagementController(
      contextDir,
      {
        enabled: true,
        agent: {
          model: "claude-sonnet-4-5",
          capabilities: ["READ"],
          engine: "pi" as any,
        },
        hooks: { pre_step: true, post_step: true },
      },
      engine,
    );

    const ac = new AbortController();
    const steps = {
      s1: { status: StepStatus.READY, iteration: 0, maxIterations: 3 },
    };

    // Invoke pre_step
    await controller.invokeHook("pre_step", "s1", StepStatus.READY, steps, ac.signal);
    // Invoke post_step
    await controller.invokeHook("post_step", "s1", StepStatus.SUCCEEDED, steps, ac.signal);
    // Invoke pre_step again (different hook invocation)
    await controller.invokeHook("pre_step", "s1", StepStatus.READY, steps, ac.signal);

    // Session should only be created once
    expect(mockPi.mockCreateAgentSession).toHaveBeenCalledTimes(1);
    // prompt should be called 3 times
    expect(mockPi.session.prompt).toHaveBeenCalledTimes(3);
  });

  // TC-PI-I-04
  it("TC-PI-I-04: Engine disposal is called on controller stop", async () => {
    const tmpDir = await makeTmpDir();
    const contextDir = path.join(tmpDir, "context");
    await mkdir(contextDir, { recursive: true });

    const mockPi = createMockPiSession();

    const engine = new PiSdkEngine({
      contextDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const controller = new ManagementController(
      contextDir,
      {
        enabled: true,
        agent: {
          model: "claude-sonnet-4-5",
          capabilities: ["READ"],
          engine: "pi" as any,
        },
        hooks: { pre_step: true },
      },
      engine,
    );

    // Trigger session creation
    const ac = new AbortController();
    await controller.invokeHook(
      "pre_step",
      "s1",
      StepStatus.READY,
      { s1: { status: StepStatus.READY, iteration: 0, maxIterations: 3 } },
      ac.signal,
    );

    // Stop the controller (should dispose the engine)
    await controller.stop();

    expect(mockPi.session.dispose).toHaveBeenCalled();
  });
});
