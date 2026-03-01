/**
 * Unit tests: ManagementAgentEngine abstraction, WorkerEngine, PiSdkEngine,
 * DSL/parser engine field, and engine factory.
 *
 * TDD RED phase — these tests reference types and modules that do NOT exist yet.
 * They should compile (TypeScript-wise) but FAIL at runtime until the
 * implementation is completed.
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// --- Types that will be created ---
import type {
  ManagementAgentEngine,
  ManagementAgentEngineResult,
  HookContext,
} from "../../../src/workflow/management/types.js";

// --- Implementations that will be created ---
import { WorkerEngine } from "../../../src/workflow/management/worker-engine.js";
import { PiSdkEngine } from "../../../src/workflow/management/pi-sdk-engine.js";
import { createEngine } from "../../../src/workflow/management/engine-factory.js";

// --- Existing types ---
import {
  ENV_MANAGEMENT_HOOK_ID,
  ENV_MANAGEMENT_INPUT_FILE,
  ENV_MANAGEMENT_DECISION_FILE,
} from "../../../src/workflow/management/types.js";

// --- Parser (existing) ---
import { parseWorkflow, WorkflowParseError } from "../../../src/workflow/parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "roboppi-engine-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeHookContext(overrides: Partial<HookContext> = {}): HookContext {
  return {
    hook_id: "hook-1",
    hook: "pre_step",
    step_id: "s1",
    workflow_state: {
      steps: {
        s1: {
          status: "READY",
          iteration: 0,
          maxIterations: 3,
        },
      },
    },
    step_state: {
      status: "READY",
      iteration: 0,
      maxIterations: 3,
    },
    ...overrides,
  };
}

/** Minimal mock for StepRunner compatible with WorkerEngine. */
function createMockStepRunner() {
  const calls: Array<{
    stepId: string;
    stepDef: unknown;
    workspace: string;
    signal: AbortSignal;
    env?: Record<string, string>;
  }> = [];

  return {
    calls,
    runStep: mock(async (
      stepId: string,
      stepDef: unknown,
      workspace: string,
      signal: AbortSignal,
      env?: Record<string, string>,
    ) => {
      calls.push({ stepId, stepDef, workspace, signal, env });
      return { status: "COMPLETED" };
    }),
    runCheck: mock(async () => ({ complete: false })),
  };
}

/** Minimal mock for Pi SDK's createAgentSession / AgentSession. */
function createMockPiSession() {
  let lastPromptText = "";
  let registeredTools: Array<{ name: string; execute: Function }> = [];
  let disposed = false;

  const session = {
    prompt: mock(async (text: string) => {
      lastPromptText = text;
    }),
    subscribe: mock((_listener: Function) => {
      return () => {}; // unsubscribe
    }),
    dispose: mock(() => {
      disposed = true;
    }),
    get isDisposed() {
      return disposed;
    },
    get lastPromptText() {
      return lastPromptText;
    },
  };

  const mockCreateAgentSession = mock(async (opts: any) => {
    // Capture custom tools
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
  };
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// ===========================================================================
// §1. ManagementAgentEngine interface type tests
// ===========================================================================

describe("ManagementAgentEngine interface", () => {
  // TC-PI-E-01
  it("TC-PI-E-01: ManagementAgentEngine type is exported", () => {
    // This test verifies the type is importable.
    // If the import at the top of this file fails, the test suite won't load.
    const assertType = (engine: ManagementAgentEngine): void => {
      expect(typeof engine.invokeHook).toBe("function");
      expect(typeof engine.dispose).toBe("function");
    };
    // We only need the type to compile — runtime assertion is a bonus.
    expect(assertType).toBeDefined();
  });

  // TC-PI-E-02
  it("TC-PI-E-02: ManagementAgentEngineResult type is exported", () => {
    const result: ManagementAgentEngineResult = {
      directive: { action: "proceed" },
      meta: { reasoning: "all good", confidence: 0.95 },
    };
    expect(result.directive.action).toBe("proceed");
    expect(result.meta?.reasoning).toBe("all good");
    expect(result.meta?.confidence).toBe(0.95);
  });
});

// ===========================================================================
// §2. WorkerEngine tests
// ===========================================================================

describe("WorkerEngine", () => {
  let tmpDir: string;
  let mockStepRunner: ReturnType<typeof createMockStepRunner>;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    mockStepRunner = createMockStepRunner();
  });

  // TC-PI-W-01
  it("TC-PI-W-01: WorkerEngine implements ManagementAgentEngine", () => {
    const engine: ManagementAgentEngine = new WorkerEngine({
      contextDir: tmpDir,
      stepRunner: mockStepRunner as any,
      workspaceDir: tmpDir,
      agentConfig: {
        worker: "OPENCODE",
        capabilities: ["READ"],
        base_instructions: "You are a management agent.",
      },
    });

    expect(typeof engine.invokeHook).toBe("function");
    expect(typeof engine.dispose).toBe("function");
  });

  // TC-PI-W-02
  it("TC-PI-W-02: invokeHook sets env vars (ROBOPPI_MANAGEMENT_HOOK_ID, INPUT_FILE, DECISION_FILE)", async () => {
    const engine = new WorkerEngine({
      contextDir: tmpDir,
      stepRunner: mockStepRunner as any,
      workspaceDir: tmpDir,
      agentConfig: {
        worker: "OPENCODE",
        capabilities: ["READ"],
      },
    });

    const ctx = makeHookContext();
    const controller = new AbortController();

    await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-abc",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    expect(mockStepRunner.calls.length).toBeGreaterThanOrEqual(1);
    const call = mockStepRunner.calls[0]!;
    expect(call.env).toBeDefined();
    expect(call.env![ENV_MANAGEMENT_HOOK_ID]).toBe("hook-abc");
    expect(call.env![ENV_MANAGEMENT_INPUT_FILE]).toBeDefined();
    expect(call.env![ENV_MANAGEMENT_DECISION_FILE]).toBeDefined();
  });

  // TC-PI-W-03
  it("TC-PI-W-03: invokeHook calls stepRunner.runStep with correct management step def", async () => {
    const engine = new WorkerEngine({
      contextDir: tmpDir,
      stepRunner: mockStepRunner as any,
      workspaceDir: tmpDir,
      agentConfig: {
        worker: "CLAUDE_CODE",
        capabilities: ["READ", "EDIT"],
        base_instructions: "Supervise the workflow.",
        timeout: "1m",
      },
    });

    const ctx = makeHookContext();
    const controller = new AbortController();

    await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-def",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 60_000 },
      abortSignal: controller.signal,
    });

    expect(mockStepRunner.runStep).toHaveBeenCalled();
    const call = mockStepRunner.calls[0]!;
    // The step id should contain management marker
    expect(call.stepId).toContain("_management");
    // The step def should carry the configured worker + capabilities
    const stepDef = call.stepDef as any;
    expect(stepDef.worker).toBe("CLAUDE_CODE");
    expect(stepDef.capabilities).toEqual(["READ", "EDIT"]);
  });

  // TC-PI-W-04
  it("TC-PI-W-04: invokeHook resolves decision.json and returns directive", async () => {
    // Pre-write a decision.json that the mock step runner "produces"
    const invDir = path.join(tmpDir, "_management", "inv", "hook-resolve");
    await mkdir(invDir, { recursive: true });
    const decisionFile = path.join(invDir, "decision.json");
    await writeFile(
      decisionFile,
      JSON.stringify({
        hook_id: "hook-resolve",
        hook: "pre_step",
        step_id: "s1",
        directive: { action: "skip", reason: "not needed" },
      }),
    );

    // Make the step runner a no-op (decision file already exists)
    const engine = new WorkerEngine({
      contextDir: tmpDir,
      stepRunner: mockStepRunner as any,
      workspaceDir: tmpDir,
      agentConfig: { worker: "OPENCODE", capabilities: ["READ"] },
    });

    const ctx = makeHookContext({ hook_id: "hook-resolve" });
    const controller = new AbortController();

    const result = await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-resolve",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    expect(result.directive.action).toBe("skip");
    if (result.directive.action === "skip") {
      expect(result.directive.reason).toBe("not needed");
    }
  });

  it("TC-PI-W-08: WorkerEngine isolates management events via sink override", async () => {
    const mainEvents: unknown[] = [];
    const mainSink = {
      emit: (event: unknown) => {
        mainEvents.push(event);
      },
    };

    const stepRunner = {
      runStep: async (
        stepId: string,
        _stepDef: unknown,
        _workspace: string,
        _signal: AbortSignal,
        _env?: Record<string, string>,
        sinkOverride?: { emit: (e: unknown) => void },
      ) => {
        const sink = sinkOverride ?? mainSink;
        sink.emit({ type: "worker_event", stepId, ts: Date.now(), event: { type: "stdout", data: "hi" } });
        sink.emit({ type: "worker_result", stepId, ts: Date.now(), result: { status: "SUCCEEDED" } });
        return { status: "SUCCEEDED" };
      },
      runCheck: async () => ({ complete: true, failed: false }),
    };

    const engine = new WorkerEngine({
      contextDir: tmpDir,
      stepRunner: stepRunner as any,
      workspaceDir: tmpDir,
      agentConfig: {
        worker: "OPENCODE",
        capabilities: ["READ"],
      },
    });

    const ctx = makeHookContext({ hook_id: "hook-iso" });
    const controller = new AbortController();
    await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-iso",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    // Management worker events should not go to the main sink.
    expect(mainEvents.length).toBe(0);

    // They should be written to _management/inv/<hookId>/worker.jsonl.
    const outPath = path.join(tmpDir, "_management", "inv", "hook-iso", "worker.jsonl");
    let text = "";
    for (let i = 0; i < 20; i++) {
      text = await readFile(outPath, "utf-8").catch(() => "");
      if (text.trim()) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(text).toContain('"type":"worker_event"');
  });

  // TC-PI-W-05
  it("TC-PI-W-05: invokeHook returns proceed on timeout", async () => {
    // Make the step runner hang until abort
    mockStepRunner.runStep.mockImplementation(async (
      _stepId: string,
      _stepDef: unknown,
      _workspace: string,
      signal: AbortSignal,
    ) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("aborted");
    });

    const engine = new WorkerEngine({
      contextDir: tmpDir,
      stepRunner: mockStepRunner as any,
      workspaceDir: tmpDir,
      agentConfig: { worker: "OPENCODE", capabilities: ["READ"] },
    });

    const ctx = makeHookContext();
    const controller = new AbortController();

    // Budget with an already-past deadline to trigger immediate timeout
    const result = await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-timeout",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() - 1 }, // already expired
      abortSignal: controller.signal,
    });

    expect(result.directive).toEqual({ action: "proceed" });
  });

  // TC-PI-W-06
  it("TC-PI-W-06: invokeHook returns proceed on worker error", async () => {
    mockStepRunner.runStep.mockImplementation(async () => {
      throw new Error("worker crashed");
    });

    const engine = new WorkerEngine({
      contextDir: tmpDir,
      stepRunner: mockStepRunner as any,
      workspaceDir: tmpDir,
      agentConfig: { worker: "OPENCODE", capabilities: ["READ"] },
    });

    const ctx = makeHookContext();
    const controller = new AbortController();

    const result = await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-error",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    expect(result.directive).toEqual({ action: "proceed" });
  });

  // TC-PI-W-07
  it("TC-PI-W-07: dispose is a no-op", async () => {
    const engine = new WorkerEngine({
      contextDir: tmpDir,
      stepRunner: mockStepRunner as any,
      workspaceDir: tmpDir,
      agentConfig: { worker: "OPENCODE", capabilities: ["READ"] },
    });

    // Should not throw
    await engine.dispose();
  });
});

// ===========================================================================
// §3. PiSdkEngine tests (mock Pi SDK)
// ===========================================================================

describe("PiSdkEngine", () => {
  let tmpDir: string;
  let mockPi: ReturnType<typeof createMockPiSession>;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    mockPi = createMockPiSession();
  });

  // TC-PI-P-01
  it("TC-PI-P-01: PiSdkEngine implements ManagementAgentEngine", () => {
    const engine: ManagementAgentEngine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
        base_instructions: "You are a management agent.",
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    expect(typeof engine.invokeHook).toBe("function");
    expect(typeof engine.dispose).toBe("function");
  });

  // TC-PI-P-02
  it("TC-PI-P-02: PiSdkEngine creates session with correct options (model, tools, sessionManager)", async () => {
    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
        base_instructions: "Supervise the workflow.",
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const ctx = makeHookContext();
    const controller = new AbortController();

    await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-session",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    // createAgentSession should have been called
    expect(mockPi.mockCreateAgentSession).toHaveBeenCalled();
    const callArgs = mockPi.mockCreateAgentSession.mock.calls[0]![0];

    // Should use in-memory session manager
    expect(callArgs.sessionManager).toBeDefined();
    // Should include model
    expect(callArgs.model).toBeDefined();
  });

  // TC-PI-P-03
  it("TC-PI-P-03: PiSdkEngine registers roboppi_management_decision custom tool", async () => {
    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const ctx = makeHookContext();
    const controller = new AbortController();

    await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-tool",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    // The registered tools should include roboppi_management_decision
    const decisionTool = mockPi.registeredTools.find(
      (t) => t.name === "roboppi_management_decision",
    );
    expect(decisionTool).toBeDefined();
  });

  // TC-PI-P-04
  it("TC-PI-P-04: Decision tool captures directive correctly", async () => {
    // Override prompt to simulate the agent calling the decision tool
    mockPi.session.prompt.mockImplementation(async () => {
      const decisionTool = mockPi.registeredTools.find(
        (t) => t.name === "roboppi_management_decision",
      );
      if (decisionTool) {
        await decisionTool.execute("call-1", {
          hook_id: "hook-capture",
          hook: "pre_step",
          step_id: "s1",
          directive: { action: "skip", reason: "unnecessary" },
          reasoning: "step already done",
          confidence: 0.9,
        });
      }
    });

    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const ctx = makeHookContext({ hook_id: "hook-capture" });
    const controller = new AbortController();

    const result = await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-capture",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    expect(result.directive.action).toBe("skip");
    if (result.directive.action === "skip") {
      expect(result.directive.reason).toBe("unnecessary");
    }
    expect(result.meta?.reasoning).toBe("step already done");
    expect(result.meta?.confidence).toBe(0.9);
  });

  // TC-PI-P-05
  it("TC-PI-P-05: Decision tool validates hook_id match (rejects mismatch)", async () => {
    // Override prompt to simulate the agent calling the tool with wrong hook_id
    mockPi.session.prompt.mockImplementation(async () => {
      const decisionTool = mockPi.registeredTools.find(
        (t) => t.name === "roboppi_management_decision",
      );
      if (decisionTool) {
        await decisionTool.execute("call-1", {
          hook_id: "wrong-hook-id",
          hook: "pre_step",
          step_id: "s1",
          directive: { action: "abort_workflow", reason: "bad" },
        });
      }
    });

    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const ctx = makeHookContext({ hook_id: "hook-mismatch" });
    const controller = new AbortController();

    const result = await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-mismatch",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    // Mismatch should fall back to proceed
    expect(result.directive).toEqual({ action: "proceed" });
  });

  // TC-PI-P-06
  it("TC-PI-P-06: PiSdkEngine reuses session across multiple invokeHook calls (persistent)", async () => {
    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const controller = new AbortController();
    const budget = { deadlineAt: Date.now() + 30_000 };

    // First invocation
    await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-1",
      hookStartedAt: Date.now(),
      context: makeHookContext({ hook_id: "hook-1" }),
      budget,
      abortSignal: controller.signal,
    });

    // Second invocation
    await engine.invokeHook({
      hook: "post_step",
      hookId: "hook-2",
      hookStartedAt: Date.now(),
      context: makeHookContext({ hook_id: "hook-2", hook: "post_step" }),
      budget,
      abortSignal: controller.signal,
    });

    // createAgentSession should have been called only once (session reused)
    expect(mockPi.mockCreateAgentSession).toHaveBeenCalledTimes(1);
    // prompt should have been called twice
    expect(mockPi.session.prompt).toHaveBeenCalledTimes(2);
  });

  // TC-PI-P-07
  it("TC-PI-P-07: PiSdkEngine returns proceed on timeout", async () => {
    // Make prompt hang forever
    mockPi.session.prompt.mockImplementation(async () => {
      await new Promise(() => {}); // never resolves
    });

    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const ctx = makeHookContext();
    const controller = new AbortController();

    const result = await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-timeout",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() - 1 }, // already expired
      abortSignal: controller.signal,
    });

    expect(result.directive).toEqual({ action: "proceed" });
  });

  // TC-PI-P-08
  it("TC-PI-P-08: PiSdkEngine returns proceed on session error", async () => {
    mockPi.mockCreateAgentSession.mockImplementation(async () => {
      throw new Error("session creation failed");
    });

    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const ctx = makeHookContext();
    const controller = new AbortController();

    const result = await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-session-err",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    expect(result.directive).toEqual({ action: "proceed" });
  });

  // TC-PI-P-09
  it("TC-PI-P-09: PiSdkEngine maps READ capability to readOnlyTools", async () => {
    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const ctx = makeHookContext();
    const controller = new AbortController();

    await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-caps-read",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    const callArgs = mockPi.mockCreateAgentSession.mock.calls[0]![0];
    // tools should be the read-only set (no edit/write/bash)
    expect(callArgs.tools).toBeDefined();
    const toolNames = callArgs.tools.map((t: any) => t.name);
    // Read-only tools include: read, grep, find, ls
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("edit");
    expect(toolNames).not.toContain("bash");
  });

  // TC-PI-P-10
  it("TC-PI-P-10: PiSdkEngine remains read-only even when EDIT is requested", async () => {
    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["EDIT"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const ctx = makeHookContext();
    const controller = new AbortController();

    await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-caps-edit",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    const callArgs = mockPi.mockCreateAgentSession.mock.calls[0]![0];
    expect(callArgs.tools).toBeDefined();
    const toolNames = callArgs.tools.map((t: any) => t.name);
    // Policy/mechanism separation: PiSdkEngine never exposes edit/write/bash.
    expect(toolNames).toContain("read");
    expect(toolNames).not.toContain("edit");
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("bash");
  });

  // TC-PI-P-11
  it("TC-PI-P-11: PiSdkEngine writes decision.json for audit parity", async () => {
    // Override prompt to call the decision tool
    mockPi.session.prompt.mockImplementation(async () => {
      const decisionTool = mockPi.registeredTools.find(
        (t) => t.name === "roboppi_management_decision",
      );
      if (decisionTool) {
        await decisionTool.execute("call-1", {
          hook_id: "hook-audit",
          hook: "pre_step",
          step_id: "s1",
          directive: { action: "annotate", message: "looking good" },
        });
      }
    });

    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const ctx = makeHookContext({ hook_id: "hook-audit" });
    const controller = new AbortController();

    await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-audit",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    // decision.json should be written under _management/inv/<hookId>/
    const decisionPath = path.join(
      tmpDir,
      "_management",
      "inv",
      "hook-audit",
      "decision.json",
    );
    const content = await readFile(decisionPath, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.directive.action).toBe("annotate");
    expect(parsed.hook_id).toBe("hook-audit");
  });

  // TC-PI-P-12
  it("TC-PI-P-12: dispose calls session.dispose()", async () => {
    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    // Trigger session creation by invoking a hook
    const ctx = makeHookContext();
    const controller = new AbortController();
    await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-dispose",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    await engine.dispose();

    expect(mockPi.session.dispose).toHaveBeenCalled();
  });

  // TC-PI-P-13
  it("TC-PI-P-13: PiSdkEngine prompts with hook context and base instructions", async () => {
    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
        base_instructions: "You are a workflow management agent. Be concise.",
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const ctx = makeHookContext({
      hook_id: "hook-prompt",
      hook: "on_stall",
      step_id: "step-xyz",
      stall_event: { type: "no_output", durationMs: 60_000 },
    });
    const controller = new AbortController();

    await engine.invokeHook({
      hook: "on_stall",
      hookId: "hook-prompt",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    // prompt() should have been called with text containing hook context
    expect(mockPi.session.prompt).toHaveBeenCalled();
    const promptText = mockPi.session.prompt.mock.calls[0]![0];
    expect(promptText).toContain("hook-prompt");
    expect(promptText).toContain("on_stall");
    expect(promptText).toContain("step-xyz");
    // Should mention the decision tool requirement
    expect(promptText).toContain("roboppi_management_decision");
  });

  it("TC-PI-P-14: PiSdkEngine rejects invalid skip directive (missing reason)", async () => {
    mockPi.session.prompt.mockImplementation(async () => {
      const decisionTool = mockPi.registeredTools.find(
        (t) => t.name === "roboppi_management_decision",
      );
      if (decisionTool) {
        await decisionTool.execute("call-1", {
          hook_id: "hook-invalid-skip",
          hook: "pre_step",
          step_id: "s1",
          directive: { action: "skip" },
        });
      }
    });

    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const ctx = makeHookContext({ hook_id: "hook-invalid-skip" });
    const controller = new AbortController();

    const result = await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-invalid-skip",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    expect(result.directive).toEqual({ action: "proceed" });
  });

  it("TC-PI-P-15: PiSdkEngine rejects invalid adjust_timeout directive (missing timeout)", async () => {
    mockPi.session.prompt.mockImplementation(async () => {
      const decisionTool = mockPi.registeredTools.find(
        (t) => t.name === "roboppi_management_decision",
      );
      if (decisionTool) {
        await decisionTool.execute("call-1", {
          hook_id: "hook-invalid-timeout",
          hook: "pre_step",
          step_id: "s1",
          directive: { action: "adjust_timeout", reason: "need more" },
        });
      }
    });

    const engine = new PiSdkEngine({
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
      createAgentSession: mockPi.mockCreateAgentSession,
    });

    const ctx = makeHookContext({ hook_id: "hook-invalid-timeout" });
    const controller = new AbortController();

    const result = await engine.invokeHook({
      hook: "pre_step",
      hookId: "hook-invalid-timeout",
      hookStartedAt: Date.now(),
      context: ctx,
      budget: { deadlineAt: Date.now() + 30_000 },
      abortSignal: controller.signal,
    });

    expect(result.directive).toEqual({ action: "proceed" });
  });
});

// ===========================================================================
// §4. DSL/Parser tests — management.agent.engine field
// ===========================================================================

describe("DSL/Parser engine field", () => {
  function makeYaml(engineValue: string): string {
    return `
name: engine-test
version: "1"
timeout: "10m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    engine: "${engineValue}"
  hooks:
    pre_step: true
steps:
  s1:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
`;
  }

  // TC-PI-C-01
  it('TC-PI-C-01: management.agent.engine "pi" is accepted', () => {
    const yaml = makeYaml("pi");
    const wf = parseWorkflow(yaml);
    expect(wf.management?.agent?.engine).toBe("pi");
  });

  // TC-PI-C-02
  it('TC-PI-C-02: management.agent.engine "worker" is accepted (default)', () => {
    const yaml = makeYaml("worker");
    const wf = parseWorkflow(yaml);
    expect(wf.management?.agent?.engine).toBe("worker");
  });

  // TC-PI-C-03
  it("TC-PI-C-03: management.agent.engine with invalid value is rejected", () => {
    const yaml = makeYaml("invalid_engine");
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
  });

  // TC-PI-C-04
  it('TC-PI-C-04: engine "pi" without model warns or errors appropriately', () => {
    const yaml = `
name: engine-test
version: "1"
timeout: "10m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    engine: "pi"
  hooks:
    pre_step: true
steps:
  s1:
    worker: CODEX_CLI
    instructions: "do work"
    capabilities: [READ]
`;
    // Pi engine requires a model to be specified (or should warn)
    // The exact behavior (warn vs error) depends on implementation choice.
    // For TDD, we test that it either throws or sets a warning.
    try {
      const wf = parseWorkflow(yaml);
      // If it doesn't throw, it should still parse but the model should be absent
      // The engine factory or controller should handle the missing model at runtime
      expect(wf.management?.agent?.engine).toBe("pi");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowParseError);
    }
  });
});

// ===========================================================================
// §5. Engine factory tests
// ===========================================================================

describe("createEngine factory", () => {
  let tmpDir: string;
  let mockStepRunner: ReturnType<typeof createMockStepRunner>;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    mockStepRunner = createMockStepRunner();
  });

  // TC-PI-F-01
  it('TC-PI-F-01: createEngine("worker", ...) returns WorkerEngine', () => {
    const engine = createEngine("worker", {
      contextDir: tmpDir,
      stepRunner: mockStepRunner as any,
      workspaceDir: tmpDir,
      agentConfig: {
        worker: "OPENCODE",
        capabilities: ["READ"],
      },
    });

    expect(engine).toBeInstanceOf(WorkerEngine);
  });

  // TC-PI-F-02
  it('TC-PI-F-02: createEngine("pi", ...) returns PiSdkEngine', () => {
    const engine = createEngine("pi", {
      contextDir: tmpDir,
      workspaceDir: tmpDir,
      agentConfig: {
        model: "claude-sonnet-4-5",
        capabilities: ["READ"],
      },
    });

    expect(engine).toBeInstanceOf(PiSdkEngine);
  });

  // TC-PI-F-03
  it("TC-PI-F-03: createEngine with no engine field returns WorkerEngine (default)", () => {
    const engine = createEngine(undefined, {
      contextDir: tmpDir,
      stepRunner: mockStepRunner as any,
      workspaceDir: tmpDir,
      agentConfig: {
        worker: "OPENCODE",
        capabilities: ["READ"],
      },
    });

    expect(engine).toBeInstanceOf(WorkerEngine);
  });
});
