import { describe, test, expect } from "bun:test";
import {
  OpenCodeAdapter,
  buildArgs,
} from "../../../src/worker/adapters/opencode-adapter.js";
import {
  WorkerKind,
  WorkerCapability,
  OutputMode,
  WorkerStatus,
} from "../../../src/types/index.js";
import type { WorkerTask } from "../../../src/types/index.js";
import type { ProcessManager, ManagedProcess } from "../../../src/worker/process-manager.js";

function makeTask(overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    workerTaskId: "task-1",
    workerKind: WorkerKind.OPENCODE,
    workspaceRef: "/tmp/workspace",
    instructions: "Fix the bug in main.ts",
    capabilities: [WorkerCapability.EDIT],
    outputMode: OutputMode.STREAM,
    budget: { deadlineAt: Date.now() + 60000 },
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

function makeMockProcess(exitCode: number = 0, stdoutData: string = "", stderrData: string = ""): ManagedProcess {
  let resolveExit!: (code: number) => void;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  // Immediately resolve the exit promise for tests that need it
  setTimeout(() => resolveExit(exitCode), 10);

  return {
    pid: 12345,
    subprocess: {} as any,
    stdout: new ReadableStream({
      start(controller) {
        if (stdoutData) {
          controller.enqueue(new TextEncoder().encode(stdoutData));
        }
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        if (stderrData) {
          controller.enqueue(new TextEncoder().encode(stderrData));
        }
        controller.close();
      },
    }),
    exitPromise,
  };
}

function makeMockProcessManager(): ProcessManager & {
  spawnCalls: Array<{ command: string[]; cwd?: string; abortSignal?: AbortSignal }>;
  gracefulShutdownCalls: Array<{ pid: number; graceMs: number }>;
  killCalls: Array<{ pid: number; signal?: string }>;
  _setMockProcess: (proc: ManagedProcess) => void;
} {
  let mockProcess: ManagedProcess = makeMockProcess();

  const pm = {
    spawnCalls: [] as Array<{ command: string[]; cwd?: string; abortSignal?: AbortSignal }>,
    gracefulShutdownCalls: [] as Array<{ pid: number; graceMs: number }>,
    killCalls: [] as Array<{ pid: number; signal?: string }>,
    _setMockProcess(proc: ManagedProcess) {
      mockProcess = proc;
    },
    spawn(options: any): ManagedProcess {
      pm.spawnCalls.push({
        command: options.command,
        cwd: options.cwd,
        abortSignal: options.abortSignal,
      });
      return mockProcess;
    },
    kill(pid: number, signal?: string) {
      pm.killCalls.push({ pid, signal });
    },
    async gracefulShutdown(pid: number, graceMs: number = 5000) {
      pm.gracefulShutdownCalls.push({ pid, graceMs });
    },
    async killAll() {},
    getActiveCount() {
      return 0;
    },
    processes: new Set<ManagedProcess>(),
  };

  return pm as any;
}

describe("OpenCodeAdapter", () => {
  describe("buildArgs", () => {
    const defaultConfig = {
      openCodeCommand: "opencode",
      defaultArgs: [] as string[],
      gracePeriodMs: 5000,
    };

    test("builds args with run subcommand and instructions", () => {
      const task = makeTask({ capabilities: [WorkerCapability.EDIT] });
      const args = buildArgs(task, defaultConfig);

      expect(args[0]).toBe("run");
      expect(args[1]).toBe("--format");
      expect(args[2]).toBe("json");
      expect(args).toContain("Fix the bug in main.ts");
    });

    test("includes default args from config after run --format json", () => {
      const config = { ...defaultConfig, defaultArgs: ["--verbose"] };
      const task = makeTask();
      const args = buildArgs(task, config);

      expect(args[0]).toBe("run");
      expect(args[1]).toBe("--format");
      expect(args[2]).toBe("json");
      expect(args[3]).toBe("--verbose");
    });

    test("places instructions as the last argument", () => {
      const task = makeTask({ instructions: "Do something special" });
      const args = buildArgs(task, defaultConfig);

      expect(args[args.length - 1]).toBe("Do something special");
    });

    test("includes --model when task.model is set (overrides defaultArgs)", () => {
      const task = makeTask({ model: "openai/gpt-5.2" });
      const config = { ...defaultConfig, defaultArgs: ["--model", "openai/gpt-4.1"] };
      const args = buildArgs(task, config);

      // Should contain the task-level model, and not the default model
      const modelIdx = args.indexOf("--model");
      expect(modelIdx).toBeGreaterThanOrEqual(0);
      expect(args[modelIdx + 1]).toBe("openai/gpt-5.2");
      expect(args).not.toContain("openai/gpt-4.1");
    });
  });

  describe("startTask", () => {
    test("spawns process with correct command", async () => {
      const pm = makeMockProcessManager();
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();

      await adapter.startTask(task);

      expect(pm.spawnCalls).toHaveLength(1);
      expect(pm.spawnCalls[0]!.command[0]).toBe("opencode");
      expect(pm.spawnCalls[0]!.command[1]).toBe("run");
      expect(pm.spawnCalls[0]!.command).toContain("--format");
    });

    test("uses custom command from config", async () => {
      const pm = makeMockProcessManager();
      const adapter = new OpenCodeAdapter(pm, {
        openCodeCommand: "/usr/local/bin/opencode",
      });
      const task = makeTask();

      await adapter.startTask(task);

      expect(pm.spawnCalls[0]!.command[0]).toBe("/usr/local/bin/opencode");
    });

    test("sets cwd to workspaceRef", async () => {
      const pm = makeMockProcessManager();
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask({ workspaceRef: "/home/user/project" });

      await adapter.startTask(task);

      expect(pm.spawnCalls[0]!.cwd).toBe("/home/user/project");
    });

    test("passes abort signal to process manager", async () => {
      const pm = makeMockProcessManager();
      const adapter = new OpenCodeAdapter(pm);
      const ac = new AbortController();
      const task = makeTask({ abortSignal: ac.signal });

      await adapter.startTask(task);

      expect(pm.spawnCalls[0]!.abortSignal).toBe(ac.signal);
    });

    test("returns a WorkerHandle with OPENCODE kind", async () => {
      const pm = makeMockProcessManager();
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();

      const handle = await adapter.startTask(task);

      expect(handle.workerKind).toBe(WorkerKind.OPENCODE);
      expect(handle.handleId).toBeTruthy();
      expect(handle.abortSignal).toBe(task.abortSignal);
    });
  });

  describe("streamEvents", () => {
    test("yields stdout lines as stdout events", async () => {
      const pm = makeMockProcessManager();
      pm._setMockProcess(makeMockProcess(0, "line1\nline2\n", ""));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const events: any[] = [];
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
      }

      const stdoutEvents = events.filter((e) => e.type === "stdout");
      expect(stdoutEvents).toHaveLength(2);
      expect(stdoutEvents[0].data).toBe("line1");
      expect(stdoutEvents[1].data).toBe("line2");
    });

    test("yields stderr lines as stderr events", async () => {
      const pm = makeMockProcessManager();
      pm._setMockProcess(makeMockProcess(0, "", "error output\n"));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const events: any[] = [];
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
      }

      const stderrEvents = events.filter((e) => e.type === "stderr");
      expect(stderrEvents).toHaveLength(1);
      expect(stderrEvents[0].data).toBe("error output");
    });

    test("parses structured JSON progress output", async () => {
      const pm = makeMockProcessManager();
      const jsonLine = JSON.stringify({ type: "progress", message: "Working...", percent: 50 });
      pm._setMockProcess(makeMockProcess(0, jsonLine + "\n", ""));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const events: any[] = [];
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
      }

      const progressEvents = events.filter((e) => e.type === "progress");
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0].message).toBe("Working...");
      expect(progressEvents[0].percent).toBe(50);
    });

    test("parses structured JSON patch output", async () => {
      const pm = makeMockProcessManager();
      const jsonLine = JSON.stringify({ type: "patch", filePath: "src/main.ts", diff: "+added line" });
      pm._setMockProcess(makeMockProcess(0, jsonLine + "\n", ""));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const events: any[] = [];
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
      }

      const patchEvents = events.filter((e) => e.type === "patch");
      expect(patchEvents).toHaveLength(1);
      expect(patchEvents[0].filePath).toBe("src/main.ts");
      expect(patchEvents[0].diff).toBe("+added line");
    });

    test("returns empty for unknown handle", async () => {
      const pm = makeMockProcessManager();
      const adapter = new OpenCodeAdapter(pm);

      const events: any[] = [];
      for await (const event of adapter.streamEvents({
        handleId: "unknown",
        workerKind: WorkerKind.OPENCODE,
        abortSignal: new AbortController().signal,
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(0);
    });
  });

  describe("cancel", () => {
    test("calls gracefulShutdown with the process pid", async () => {
      const pm = makeMockProcessManager();
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      await adapter.cancel(handle);

      expect(pm.gracefulShutdownCalls).toHaveLength(1);
      expect(pm.gracefulShutdownCalls[0]!.pid).toBe(12345);
    });

    test("uses configured grace period", async () => {
      const pm = makeMockProcessManager();
      const adapter = new OpenCodeAdapter(pm, { gracePeriodMs: 10000 });
      const task = makeTask();
      const handle = await adapter.startTask(task);

      await adapter.cancel(handle);

      expect(pm.gracefulShutdownCalls[0]!.graceMs).toBe(10000);
    });

    test("uses default grace period of 5000ms", async () => {
      const pm = makeMockProcessManager();
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      await adapter.cancel(handle);

      expect(pm.gracefulShutdownCalls[0]!.graceMs).toBe(5000);
    });

    test("does not throw for unknown handle", async () => {
      const pm = makeMockProcessManager();
      const adapter = new OpenCodeAdapter(pm);

      await adapter.cancel({
        handleId: "unknown",
        workerKind: WorkerKind.OPENCODE,
        abortSignal: new AbortController().signal,
      });

      expect(pm.gracefulShutdownCalls).toHaveLength(0);
    });
  });

  describe("awaitResult", () => {
    test("returns SUCCEEDED for exit code 0", async () => {
      const pm = makeMockProcessManager();
      pm._setMockProcess(makeMockProcess(0));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      expect(result.artifacts).toEqual([]);
      expect(result.observations).toEqual([]);
      expect(result.cost.wallTimeMs).toBeGreaterThanOrEqual(0);
    });

    test("returns FAILED for non-zero exit code", async () => {
      const pm = makeMockProcessManager();
      pm._setMockProcess(makeMockProcess(1));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.FAILED);
    });

    test("returns CANCELLED when abort signal is fired", async () => {
      const pm = makeMockProcessManager();
      pm._setMockProcess(makeMockProcess(137));
      const adapter = new OpenCodeAdapter(pm);
      const ac = new AbortController();
      const task = makeTask({ abortSignal: ac.signal });
      const handle = await adapter.startTask(task);

      ac.abort();

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.CANCELLED);
    });

    test("returns FAILED for unknown handle", async () => {
      const pm = makeMockProcessManager();
      const adapter = new OpenCodeAdapter(pm);

      const result = await adapter.awaitResult({
        handleId: "unknown",
        workerKind: WorkerKind.OPENCODE,
        abortSignal: new AbortController().signal,
      });

      expect(result.status).toBe(WorkerStatus.FAILED);
      expect(result.cost.wallTimeMs).toBe(0);
    });

    test("includes wall time in cost", async () => {
      const pm = makeMockProcessManager();
      pm._setMockProcess(makeMockProcess(0));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.cost.wallTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("kind", () => {
    test("reports OPENCODE as worker kind", () => {
      const pm = makeMockProcessManager();
      const adapter = new OpenCodeAdapter(pm);
      expect(adapter.kind).toBe(WorkerKind.OPENCODE);
    });
  });

  describe("output parsing", () => {
    test("parses patch artifacts from JSON stdout", async () => {
      const pm = makeMockProcessManager();
      const patchLine = JSON.stringify({ type: "patch", filePath: "src/main.ts", diff: "+new line" });
      pm._setMockProcess(makeMockProcess(0, patchLine + "\n"));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      expect(result.artifacts.length).toBe(1);
      expect(result.artifacts[0]!.type).toBe("patch");
      expect(result.artifacts[0]!.ref).toBe("src/main.ts");
      expect(result.artifacts[0]!.content).toBe("+new line");
    });

    test("parses file_change artifacts from JSON stdout", async () => {
      const pm = makeMockProcessManager();
      const changeLine = JSON.stringify({ type: "file_change", path: "src/utils.ts" });
      pm._setMockProcess(makeMockProcess(0, changeLine + "\n"));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      expect(result.artifacts.length).toBe(1);
      expect(result.artifacts[0]!.ref).toBe("src/utils.ts");
    });

    test("parses result observations from JSON stdout", async () => {
      const pm = makeMockProcessManager();
      const resultLine = JSON.stringify({ type: "result", result: "Task completed successfully" });
      pm._setMockProcess(makeMockProcess(0, resultLine + "\n"));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      expect(result.observations.length).toBe(1);
      expect(result.observations[0]!.summary).toBe("Task completed successfully");
    });

    test("handles empty stdout gracefully", async () => {
      const pm = makeMockProcessManager();
      pm._setMockProcess(makeMockProcess(0, ""));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      expect(result.artifacts).toEqual([]);
      expect(result.observations).toEqual([]);
    });

    test("handles malformed JSON lines gracefully", async () => {
      const pm = makeMockProcessManager();
      const output = "not json at all\n{bad json\nplain text output\n";
      pm._setMockProcess(makeMockProcess(0, output));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      // Should have a summary observation from non-JSON output
      expect(result.observations.length).toBeGreaterThanOrEqual(1);
    });

    test("handles mixed JSON and plain text output", async () => {
      const pm = makeMockProcessManager();
      const patchLine = JSON.stringify({ type: "patch", filePath: "a.ts", diff: "+line" });
      const output = `${patchLine}\nsome plain text\n`;
      pm._setMockProcess(makeMockProcess(0, output));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      expect(result.artifacts.length).toBe(1);
    });

    test("includes durationMs in result", async () => {
      const pm = makeMockProcessManager();
      pm._setMockProcess(makeMockProcess(0));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      const result = await adapter.awaitResult(handle);

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.durationMs).toBe("number");
    });
  });

  describe("deadline enforcement", () => {
    test("passes timeoutMs to ProcessManager based on deadlineAt", async () => {
      const pm = makeMockProcessManager();
      const futureDeadline = Date.now() + 30000;
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask({ budget: { deadlineAt: futureDeadline } });

      await adapter.startTask(task);

      expect(pm.spawnCalls).toHaveLength(1);
      expect(pm.spawnCalls[0]).toBeDefined();
    });

    test("adapter converts deadline to spawn options", async () => {
      // Create a more detailed mock that captures all spawn options
      let capturedOptions: any = null;
      const pm = {
        spawn(options: any) {
          capturedOptions = options;
          return makeMockProcess(0);
        },
        async gracefulShutdown() {},
        kill() {},
        async killAll() {},
        getActiveCount() { return 0; },
        processes: new Set(),
      } as any;

      const futureDeadline = Date.now() + 45000;
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask({ budget: { deadlineAt: futureDeadline } });

      await adapter.startTask(task);

      expect(capturedOptions).toBeDefined();
      expect(capturedOptions.timeoutMs).toBeDefined();
      // Timeout should be approximately 45 seconds (within a second of tolerance)
      expect(capturedOptions.timeoutMs).toBeGreaterThan(44000);
      expect(capturedOptions.timeoutMs).toBeLessThanOrEqual(45000);
    });
  });

  describe("stream then await pattern", () => {
    test("awaitResult uses collected data after streamEvents", async () => {
      const pm = makeMockProcessManager();
      const patchLine = JSON.stringify({ type: "patch", filePath: "file.ts", diff: "+new" });
      pm._setMockProcess(makeMockProcess(0, patchLine + "\n"));
      const adapter = new OpenCodeAdapter(pm);
      const task = makeTask();
      const handle = await adapter.startTask(task);

      // Consume stream first
      const events: any[] = [];
      for await (const event of adapter.streamEvents(handle)) {
        events.push(event);
      }

      // Then get result — should still parse artifacts from collected stdout
      const result = await adapter.awaitResult(handle);
      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
      expect(result.artifacts.length).toBe(1);
    });
  });
});
