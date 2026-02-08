import { describe, test, expect, mock, beforeEach } from "bun:test";
import { CodexCliAdapter } from "../../../src/worker/adapters/codex-cli-adapter.js";
import { ProcessManager } from "../../../src/worker/process-manager.js";
import type { ManagedProcess, SpawnOptions } from "../../../src/worker/process-manager.js";
import {
  WorkerKind,
  WorkerCapability,
  OutputMode,
  WorkerStatus,
  generateId,
} from "../../../src/types/index.js";
import type { WorkerTask } from "../../../src/types/index.js";

function createMockProcessManager() {
  const spawnMock = mock<(options: SpawnOptions) => ManagedProcess>(() => {
    throw new Error("spawn mock not configured");
  });
  const killMock = mock<(pid: number, signal?: string) => void>(() => {});
  const gracefulShutdownMock = mock<(pid: number, graceMs?: number) => Promise<void>>(
    () => Promise.resolve(),
  );

  const pm = {
    spawn: spawnMock,
    kill: killMock,
    gracefulShutdown: gracefulShutdownMock,
    killAll: mock(() => Promise.resolve()),
    getActiveCount: mock(() => 0),
  } as unknown as ProcessManager;

  return { pm, spawnMock, killMock, gracefulShutdownMock };
}

function createMockManagedProcess(
  exitCode: number = 0,
  stdoutData: string = "",
  stderrData: string = "",
): ManagedProcess {
  let resolveExit!: (code: number) => void;
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

  // Resolve exit after a tick to simulate process ending
  setTimeout(() => resolveExit(exitCode), 5);

  return {
    pid: Math.floor(Math.random() * 100000) + 1000,
    subprocess: {} as ReturnType<typeof Bun.spawn>,
    stdout: stdoutStream,
    stderr: stderrStream,
    exitPromise,
  };
}

function createTask(overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    workerTaskId: generateId(),
    workerKind: WorkerKind.CODEX_CLI,
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

describe("CodexCliAdapter", () => {
  let adapter: CodexCliAdapter;
  let mockPm: ReturnType<typeof createMockProcessManager>;

  beforeEach(() => {
    mockPm = createMockProcessManager();
    adapter = new CodexCliAdapter(mockPm.pm);
  });

  describe("kind", () => {
    test("should be CODEX_CLI", () => {
      expect(adapter.kind).toBe(WorkerKind.CODEX_CLI);
    });
  });

  describe("buildCommand", () => {
    test("should build basic command with prompt", () => {
      const task = createTask({
        instructions: "Fix the bug",
        capabilities: [WorkerCapability.READ],
      });
      const command = adapter.buildCommand(task);
      expect(command).toEqual(["codex", "--prompt", "Fix the bug"]);
    });

    test("should use custom codex command from config", () => {
      const customAdapter = new CodexCliAdapter(mockPm.pm, {
        codexCommand: "/usr/local/bin/codex",
      });
      const task = createTask({ capabilities: [WorkerCapability.READ] });
      const command = customAdapter.buildCommand(task);
      expect(command[0]).toBe("/usr/local/bin/codex");
    });

    test("should include default args from config", () => {
      const customAdapter = new CodexCliAdapter(mockPm.pm, {
        defaultArgs: ["--model", "o3"],
      });
      const task = createTask({ capabilities: [WorkerCapability.READ] });
      const command = customAdapter.buildCommand(task);
      expect(command).toEqual([
        "codex",
        "--model",
        "o3",
        "--prompt",
        "Fix the bug in main.ts",
      ]);
    });

    test("should set full-auto approval mode for EDIT + RUN_COMMANDS", () => {
      const task = createTask({
        capabilities: [
          WorkerCapability.READ,
          WorkerCapability.EDIT,
          WorkerCapability.RUN_COMMANDS,
        ],
      });
      const command = adapter.buildCommand(task);
      expect(command).toContain("--approval-mode=full-auto");
    });

    test("should set auto-edit approval mode for EDIT without RUN_COMMANDS", () => {
      const task = createTask({
        capabilities: [WorkerCapability.READ, WorkerCapability.EDIT],
      });
      const command = adapter.buildCommand(task);
      expect(command).toContain("--approval-mode=auto-edit");
    });

    test("should not set approval mode for READ only", () => {
      const task = createTask({
        capabilities: [WorkerCapability.READ],
      });
      const command = adapter.buildCommand(task);
      const approvalArgs = command.filter((arg) =>
        arg.startsWith("--approval-mode"),
      );
      expect(approvalArgs).toHaveLength(0);
    });
  });

  describe("startTask", () => {
    test("should call ProcessManager.spawn with correct arguments", async () => {
      const managed = createMockManagedProcess();
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask();
      await adapter.startTask(task);

      expect(mockPm.spawnMock).toHaveBeenCalledTimes(1);
      const callArgs = mockPm.spawnMock.mock.calls[0];
      expect(callArgs).toBeDefined();
      const spawnCall = callArgs![0]!;
      expect(spawnCall.cwd).toBe("/tmp/test-workspace");
      expect(spawnCall.command[0]).toBe("codex");
      expect(spawnCall.command).toContain("--prompt");
      expect(spawnCall.abortSignal).toBe(task.abortSignal);
    });

    test("should return a valid WorkerHandle", async () => {
      const managed = createMockManagedProcess();
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask();
      const handle = await adapter.startTask(task);

      expect(handle.handleId).toBeDefined();
      expect(handle.workerKind).toBe(WorkerKind.CODEX_CLI);
      expect(handle.abortSignal).toBe(task.abortSignal);
    });
  });

  describe("awaitResult", () => {
    test("should return SUCCEEDED for exit code 0", async () => {
      const managed = createMockManagedProcess(0, "Done\n");
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask();
      const handle = await adapter.startTask(task);
      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      expect(result.cost.wallTimeMs).toBeGreaterThanOrEqual(0);
    });

    test("should return FAILED for non-zero exit code", async () => {
      const managed = createMockManagedProcess(1, "Error occurred\n");
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask();
      const handle = await adapter.startTask(task);
      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.FAILED);
    });

    test("should return CANCELLED when abort signal is triggered", async () => {
      const ac = new AbortController();
      let resolveExit!: (code: number) => void;
      const exitPromise = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });

      const managed: ManagedProcess = {
        pid: 12345,
        subprocess: {} as ReturnType<typeof Bun.spawn>,
        stdout: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        exitPromise,
      };
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask({ abortSignal: ac.signal });
      const handle = await adapter.startTask(task);

      // Abort and then resolve exit
      ac.abort();
      resolveExit(137);

      const result = await adapter.awaitResult(handle);
      expect(result.status).toBe(WorkerStatus.CANCELLED);
    });

    test("should return FAILED for unknown handle", async () => {
      const handle = {
        handleId: "nonexistent",
        workerKind: WorkerKind.CODEX_CLI,
        abortSignal: new AbortController().signal,
      };
      const result = await adapter.awaitResult(handle);
      expect(result.status).toBe(WorkerStatus.FAILED);
    });

    test("should parse artifacts from JSON patch output", async () => {
      const patchLine = JSON.stringify({
        type: "patch",
        filePath: "src/main.ts",
        diff: "+fixed line",
      });
      const managed = createMockManagedProcess(0, patchLine + "\n");
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask();
      const handle = await adapter.startTask(task);
      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      expect(result.artifacts.length).toBeGreaterThanOrEqual(1);
      const patchArtifact = result.artifacts.find((a) => a.type === "patch");
      expect(patchArtifact).toBeDefined();
      expect(patchArtifact!.ref).toBe("src/main.ts");
    });

    test("should collect observations from stdout", async () => {
      const managed = createMockManagedProcess(0, "Applied fix to main.ts\n");
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask();
      const handle = await adapter.startTask(task);
      const result = await adapter.awaitResult(handle);

      expect(result.observations.length).toBeGreaterThan(0);
      expect(result.observations[0]!.summary).toContain("Applied fix");
    });
  });

  describe("cancel", () => {
    test("should call ProcessManager.gracefulShutdown with correct pid", async () => {
      const managed = createMockManagedProcess();
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask();
      const handle = await adapter.startTask(task);
      await adapter.cancel(handle);

      expect(mockPm.gracefulShutdownMock).toHaveBeenCalledTimes(1);
      expect(mockPm.gracefulShutdownMock).toHaveBeenCalledWith(
        managed.pid,
        5000,
      );
    });

    test("should use custom grace period from config", async () => {
      const customAdapter = new CodexCliAdapter(mockPm.pm, {
        gracePeriodMs: 10000,
      });
      const managed = createMockManagedProcess();
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask();
      const handle = await customAdapter.startTask(task);
      await customAdapter.cancel(handle);

      expect(mockPm.gracefulShutdownMock).toHaveBeenCalledWith(
        managed.pid,
        10000,
      );
    });

    test("should handle cancelling unknown handle gracefully", async () => {
      const handle = {
        handleId: "nonexistent",
        workerKind: WorkerKind.CODEX_CLI,
        abortSignal: new AbortController().signal,
      };
      // Should not throw
      await adapter.cancel(handle);
      expect(mockPm.gracefulShutdownMock).not.toHaveBeenCalled();
    });
  });

  describe("streamEvents", () => {
    test("should yield stdout events for plain text lines", async () => {
      const managed = createMockManagedProcess(0, "line 1\nline 2\n");
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask();
      const handle = await adapter.startTask(task);

      const events = [];
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
      }

      const stdoutEvents = events.filter((e) => e.type === "stdout");
      expect(stdoutEvents.length).toBeGreaterThanOrEqual(2);
      expect(stdoutEvents[0]!.data).toBe("line 1");
      expect(stdoutEvents[1]!.data).toBe("line 2");
    });

    test("should yield stderr events", async () => {
      const managed = createMockManagedProcess(0, "", "warning: something\n");
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask();
      const handle = await adapter.startTask(task);

      const events = [];
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
      }

      const stderrEvents = events.filter((e) => e.type === "stderr");
      expect(stderrEvents.length).toBeGreaterThanOrEqual(1);
      expect(stderrEvents[0]!.data).toBe("warning: something");
    });

    test("should parse JSON patch events from stdout", async () => {
      const patchLine = JSON.stringify({
        type: "patch",
        filePath: "src/app.ts",
        diff: "@@ -1,3 +1,3 @@",
      });
      const managed = createMockManagedProcess(0, patchLine + "\n");
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask();
      const handle = await adapter.startTask(task);

      const events = [];
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
      }

      const patchEvents = events.filter((e) => e.type === "patch");
      expect(patchEvents.length).toBe(1);
      expect((patchEvents[0] as { type: "patch"; filePath: string; diff: string }).filePath).toBe("src/app.ts");
    });

    test("should parse JSON progress events from stdout", async () => {
      const progressLine = JSON.stringify({
        type: "progress",
        message: "Analyzing code",
        percent: 50,
      });
      const managed = createMockManagedProcess(0, progressLine + "\n");
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask();
      const handle = await adapter.startTask(task);

      const events = [];
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
      }

      const progressEvents = events.filter((e) => e.type === "progress");
      expect(progressEvents.length).toBe(1);
      expect((progressEvents[0] as { type: "progress"; message: string; percent?: number }).message).toBe("Analyzing code");
      expect((progressEvents[0] as { type: "progress"; message: string; percent?: number }).percent).toBe(50);
    });

    test("should handle empty stream for unknown handle", async () => {
      const handle = {
        handleId: "nonexistent",
        workerKind: WorkerKind.CODEX_CLI,
        abortSignal: new AbortController().signal,
      };

      const events = [];
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
      }
      expect(events).toHaveLength(0);
    });
  });

  describe("config defaults", () => {
    test("should use default codex command", () => {
      const task = createTask({ capabilities: [WorkerCapability.READ] });
      const command = adapter.buildCommand(task);
      expect(command[0]).toBe("codex");
    });

    test("should use default grace period of 5000ms", async () => {
      const managed = createMockManagedProcess();
      mockPm.spawnMock.mockReturnValue(managed);

      const task = createTask();
      const handle = await adapter.startTask(task);
      await adapter.cancel(handle);

      expect(mockPm.gracefulShutdownMock).toHaveBeenCalledWith(
        managed.pid,
        5000,
      );
    });
  });
});
