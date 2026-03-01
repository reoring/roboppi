import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  ClaudeCodeAdapter,
  buildArgs,
  mapCapabilitiesToAllowedTools,
} from "../../../src/worker/adapters/claude-code-adapter.js";
import type { ClaudeCodeAdapterConfig } from "../../../src/worker/adapters/claude-code-adapter.js";
import {
  WorkerKind,
  WorkerCapability,
  OutputMode,
  WorkerStatus,
} from "../../../src/types/index.js";
import type { WorkerTask } from "../../../src/types/index.js";
import { ProcessManager } from "../../../src/worker/process-manager.js";
import type { ManagedProcess } from "../../../src/worker/process-manager.js";

function makeTask(overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    workerTaskId: "test-task-id",
    workerKind: WorkerKind.CLAUDE_CODE,
    workspaceRef: "/tmp/test-workspace",
    instructions: "Fix the bug in main.ts",
    capabilities: [WorkerCapability.READ, WorkerCapability.EDIT],
    outputMode: OutputMode.STREAM,
    budget: {
      deadlineAt: Date.now() + 60000,
    },
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

function makeDefaultConfig(): Required<ClaudeCodeAdapterConfig> {
  return {
    claudeCommand: "claude",
    defaultArgs: [],
    gracePeriodMs: 5000,
    outputFormat: "json",
  };
}

function makeMockProcess(
  exitCode: number = 0,
  stdoutData: string = "",
  stderrData: string = ""
): ManagedProcess {
  let resolveExit: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const stdoutStream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stdoutData) {
        controller.enqueue(new TextEncoder().encode(stdoutData));
      }
      controller.close();
    },
  });

  const stderrStream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (stderrData) {
        controller.enqueue(new TextEncoder().encode(stderrData));
      }
      controller.close();
    },
  });

  // Resolve the exit after a tick to simulate async
  setTimeout(() => resolveExit!(exitCode), 10);

  return {
    pid: 12345,
    subprocess: {} as any,
    stdout: stdoutStream,
    stderr: stderrStream,
    exitPromise,
    processGroup: false,
  };
}

describe("mapCapabilitiesToAllowedTools", () => {
  test("maps READ to View/Read/Glob/Grep tools", () => {
    const tools = mapCapabilitiesToAllowedTools([WorkerCapability.READ]);
    expect(tools).toContain("View");
    expect(tools).toContain("Read");
    expect(tools).toContain("Glob");
    expect(tools).toContain("Grep");
  });

  test("maps EDIT to Edit/Write/NotebookEdit tools", () => {
    const tools = mapCapabilitiesToAllowedTools([WorkerCapability.EDIT]);
    expect(tools).toContain("Edit");
    expect(tools).toContain("Write");
    expect(tools).toContain("NotebookEdit");
  });

  test("maps RUN_TESTS to restricted Bash tools", () => {
    const tools = mapCapabilitiesToAllowedTools([WorkerCapability.RUN_TESTS]);
    expect(tools.some((t) => t.startsWith("Bash("))).toBe(true);
  });

  test("maps RUN_COMMANDS to Bash", () => {
    const tools = mapCapabilitiesToAllowedTools([WorkerCapability.RUN_COMMANDS]);
    expect(tools).toContain("Bash");
  });

  test("deduplicates tools for overlapping capabilities", () => {
    const tools = mapCapabilitiesToAllowedTools([
      WorkerCapability.RUN_COMMANDS,
      WorkerCapability.RUN_TESTS,
    ]);
    const bashCount = tools.filter((t) => t === "Bash").length;
    expect(bashCount).toBe(1);
  });

  test("returns empty array for no capabilities", () => {
    const tools = mapCapabilitiesToAllowedTools([]);
    expect(tools).toEqual([]);
  });
});

describe("buildArgs", () => {
  test("builds basic args with --print and instructions", () => {
    const task = makeTask();
    const config = makeDefaultConfig();
    const args = buildArgs(task, config);

    expect(args).toContain("--print");
    const printIdx = args.indexOf("--print");
    expect(args[printIdx + 1]).toBe("Fix the bug in main.ts");
  });

  test("uses --output-format stream-json in STREAM mode when outputFormat is json", () => {
    const task = makeTask();
    const config = makeDefaultConfig();
    const args = buildArgs(task, config);

    expect(args).toContain("--output-format");
    const fmtIdx = args.indexOf("--output-format");
    expect(args[fmtIdx + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
  });

  test("omits --output-format when outputFormat is text", () => {
    const task = makeTask();
    const config = { ...makeDefaultConfig(), outputFormat: "text" as const };
    const args = buildArgs(task, config);

    expect(args).not.toContain("--output-format");
  });

  test("includes --allowedTools from capabilities", () => {
    const task = makeTask({
      capabilities: [WorkerCapability.READ, WorkerCapability.EDIT],
    });
    const config = makeDefaultConfig();
    const args = buildArgs(task, config);

    expect(args).toContain("--allowedTools");
    const toolsIdx = args.indexOf("--allowedTools");
    const toolsStr = args[toolsIdx + 1];
    expect(toolsStr).toContain("View");
    expect(toolsStr).toContain("Read");
    expect(toolsStr).toContain("Edit");
    expect(toolsStr).toContain("Write");
  });

  test("includes --max-turns from budget.maxSteps", () => {
    const task = makeTask({
      budget: { deadlineAt: Date.now() + 60000, maxSteps: 10 },
    });
    const config = makeDefaultConfig();
    const args = buildArgs(task, config);

    expect(args).toContain("--max-turns");
    const turnsIdx = args.indexOf("--max-turns");
    expect(args[turnsIdx + 1]).toBe("10");
  });

  test("omits --max-turns when maxSteps is not set", () => {
    const task = makeTask({
      budget: { deadlineAt: Date.now() + 60000 },
    });
    const config = makeDefaultConfig();
    const args = buildArgs(task, config);

    expect(args).not.toContain("--max-turns");
  });

  test("includes defaultArgs from config", () => {
    const task = makeTask();
    const config = {
      ...makeDefaultConfig(),
      defaultArgs: ["--verbose", "--no-telemetry"],
    };
    const args = buildArgs(task, config);

    expect(args).toContain("--verbose");
    expect(args).toContain("--no-telemetry");
  });

  test("includes --model when task.model is set (overrides defaultArgs)", () => {
    const task = makeTask({ model: "claude-opus-4-6" });
    const config = {
      ...makeDefaultConfig(),
      defaultArgs: ["--model", "claude-sonnet-4"],
    };
    const args = buildArgs(task, config);

    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe("claude-opus-4-6");
    expect(args).not.toContain("claude-sonnet-4");
  });

  test("omits --allowedTools when no capabilities", () => {
    const task = makeTask({ capabilities: [] });
    const config = makeDefaultConfig();
    const args = buildArgs(task, config);

    expect(args).not.toContain("--allowedTools");
  });
});

describe("ClaudeCodeAdapter", () => {
  let mockProcessManager: ProcessManager;
  let spawnMock: ReturnType<typeof mock>;
  let gracefulShutdownMock: ReturnType<typeof mock>;

  beforeEach(() => {
    mockProcessManager = new ProcessManager();
    spawnMock = mock(() => makeMockProcess(0, ""));
    gracefulShutdownMock = mock(() => Promise.resolve());
    mockProcessManager.spawn = spawnMock as any;
    mockProcessManager.gracefulShutdown = gracefulShutdownMock as any;
  });

  test("kind is CLAUDE_CODE", () => {
    const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
    expect(adapter.kind).toBe(WorkerKind.CLAUDE_CODE);
  });

  describe("startTask", () => {
    test("spawns process with correct command", async () => {
      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const task = makeTask();

      await adapter.startTask(task);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const callArgs = spawnMock.mock.calls[0]![0];
      expect(callArgs.command[0]).toBe("claude");
      expect(callArgs.command).toContain("--print");
      expect(callArgs.cwd).toBe("/tmp/test-workspace");
    });

    test("uses custom claudeCommand from config", async () => {
      const adapter = new ClaudeCodeAdapter(
        { claudeCommand: "/usr/local/bin/claude" },
        mockProcessManager
      );
      const task = makeTask();

      await adapter.startTask(task);

      const callArgs = spawnMock.mock.calls[0]![0];
      expect(callArgs.command[0]).toBe("/usr/local/bin/claude");
    });

    test("returns a WorkerHandle", async () => {
      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const task = makeTask();

      const handle = await adapter.startTask(task);

      expect(handle.handleId).toBeDefined();
      expect(handle.workerKind).toBe(WorkerKind.CLAUDE_CODE);
      expect(handle.abortSignal).toBe(task.abortSignal);
    });

    test("passes abortSignal to ProcessManager", async () => {
      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const ac = new AbortController();
      const task = makeTask({ abortSignal: ac.signal });

      await adapter.startTask(task);

      const callArgs = spawnMock.mock.calls[0]![0];
      expect(callArgs.abortSignal).toBe(ac.signal);
    });
  });

  describe("streamEvents", () => {
    test("yields stdout events from process", async () => {
      const outputLine = '{"type":"assistant","message":"Working on it"}\n';
      spawnMock.mockImplementation(() => makeMockProcess(0, outputLine));

      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const events: any[] = [];
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      const progressEvent = events.find((e) => e.type === "progress");
      expect(progressEvent).toBeDefined();
      expect(progressEvent.message).toBe("Working on it");
    });

    test("yields stderr events", async () => {
      spawnMock.mockImplementation(() =>
        makeMockProcess(0, "", "Warning: something\n")
      );

      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const events: any[] = [];
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
      }

      const stderrEvent = events.find((e) => e.type === "stderr");
      expect(stderrEvent).toBeDefined();
      expect(stderrEvent.data).toContain("Warning: something");
    });

    test("yields raw stdout in text mode", async () => {
      spawnMock.mockImplementation(() =>
        makeMockProcess(0, "plain text output")
      );

      const adapter = new ClaudeCodeAdapter(
        { outputFormat: "text" },
        mockProcessManager
      );
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const events: any[] = [];
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
      }

      const stdoutEvent = events.find((e) => e.type === "stdout");
      expect(stdoutEvent).toBeDefined();
      expect(stdoutEvent.data).toBe("plain text output");
    });
  });

  describe("cancel", () => {
    test("calls gracefulShutdown on process manager", async () => {
      spawnMock.mockImplementation(() => makeMockProcess(0));

      const adapter = new ClaudeCodeAdapter(
        { gracePeriodMs: 3000 },
        mockProcessManager
      );
      const task = makeTask();
      const handle = await adapter.startTask(task);

      await adapter.cancel(handle);

      expect(gracefulShutdownMock).toHaveBeenCalledTimes(1);
      expect(gracefulShutdownMock.mock.calls[0]![0]).toBe(12345); // pid
      expect(gracefulShutdownMock.mock.calls[0]![1]).toBe(3000); // gracePeriodMs
    });

    test("uses default gracePeriodMs of 5000", async () => {
      spawnMock.mockImplementation(() => makeMockProcess(0));

      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      await adapter.cancel(handle);

      expect(gracefulShutdownMock.mock.calls[0]![1]).toBe(5000);
    });

    test("no-ops for unknown handle", async () => {
      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const fakeHandle = {
        handleId: "nonexistent",
        workerKind: WorkerKind.CLAUDE_CODE,
        abortSignal: new AbortController().signal,
      };

      // Should not throw
      await adapter.cancel(fakeHandle);
      expect(gracefulShutdownMock).not.toHaveBeenCalled();
    });
  });

  describe("awaitResult", () => {
    test("returns SUCCEEDED for exit code 0", async () => {
      spawnMock.mockImplementation(() => makeMockProcess(0, ""));

      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      expect(result.cost.wallTimeMs).toBeGreaterThanOrEqual(0);
    });

    test("returns FAILED for non-zero exit code", async () => {
      spawnMock.mockImplementation(() => makeMockProcess(1, ""));

      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.FAILED);
    });

    test("returns CANCELLED when abortSignal is aborted", async () => {
      const ac = new AbortController();
      spawnMock.mockImplementation(() => makeMockProcess(137, ""));

      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const task = makeTask({ abortSignal: ac.signal });
      const handle = await adapter.startTask(task);

      // Abort before awaiting result
      ac.abort();

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.CANCELLED);
    });

    test("returns FAILED for unknown handle", async () => {
      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const fakeHandle = {
        handleId: "nonexistent",
        workerKind: WorkerKind.CLAUDE_CODE,
        abortSignal: new AbortController().signal,
      };

      const result = await adapter.awaitResult(fakeHandle);

      expect(result.status).toBe(WorkerStatus.FAILED);
      expect(result.cost.wallTimeMs).toBe(0);
    });

    test("parses JSON output for token usage", async () => {
      const jsonOutput =
        '{"type":"result","result":"Done","usage":{"input_tokens":500,"output_tokens":100}}\n';
      spawnMock.mockImplementation(() => makeMockProcess(0, jsonOutput));

      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      expect(result.cost.estimatedTokens).toBe(600);
    });

    test("parses file change artifacts from output", async () => {
      const jsonOutput =
        '{"type":"tool_use","tool":"Edit","filePath":"/tmp/test/main.ts"}\n';
      spawnMock.mockImplementation(() => makeMockProcess(0, jsonOutput));

      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      expect(result.artifacts.length).toBe(1);
      expect(result.artifacts[0]!.type).toBe("file_change");
      expect(result.artifacts[0]!.ref).toBe("/tmp/test/main.ts");
    });

    test("handles text output format", async () => {
      spawnMock.mockImplementation(() =>
        makeMockProcess(0, "The bug has been fixed in main.ts")
      );

      const adapter = new ClaudeCodeAdapter(
        { outputFormat: "text" },
        mockProcessManager
      );
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      expect(result.observations.length).toBeGreaterThan(0);
      expect(result.observations[0]!.summary).toContain("bug has been fixed");
    });

    test("includes wallTimeMs in cost", async () => {
      spawnMock.mockImplementation(() => makeMockProcess(0, ""));

      const adapter = new ClaudeCodeAdapter({}, mockProcessManager);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.cost.wallTimeMs).toBeGreaterThanOrEqual(0);
    });
  });
});
