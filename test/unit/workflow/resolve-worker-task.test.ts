import { describe, it, expect } from "bun:test";
import path from "node:path";
import {
  resolveTaskLike,
  buildWorkerTask,
  DEFAULT_STEP_TIMEOUT_MS,
  type ResolvedWorkerTaskDef,
} from "../../../src/workflow/resolve-worker-task.js";
import {
  WorkerKind,
  WorkerCapability,
  OutputMode,
} from "../../../src/types/index.js";

describe("resolveTaskLike", () => {
  const baseWorkspace = "/home/user/project";

  it("resolves workspace to absolute path", () => {
    const resolved = resolveTaskLike(
      {
        worker: "CODEX_CLI",
        workspace: "src",
        instructions: "do work",
        capabilities: ["READ"],
      },
      baseWorkspace,
    );
    expect(resolved.workspaceRef).toBe(path.resolve(baseWorkspace, "src"));
  });

  it("uses workspaceDir when workspace is not specified", () => {
    const resolved = resolveTaskLike(
      {
        worker: "CODEX_CLI",
        instructions: "do work",
        capabilities: ["READ"],
      },
      baseWorkspace,
    );
    expect(resolved.workspaceRef).toBe(baseWorkspace);
  });

  it("parses timeout DurationString to ms", () => {
    const resolved = resolveTaskLike(
      {
        worker: "CODEX_CLI",
        instructions: "do work",
        capabilities: ["READ"],
        timeout: "5m",
      },
      baseWorkspace,
    );
    expect(resolved.timeoutMs).toBe(300_000);
  });

  it("parses compound timeout (1h30m)", () => {
    const resolved = resolveTaskLike(
      {
        worker: "CODEX_CLI",
        instructions: "do work",
        capabilities: ["READ"],
        timeout: "1h30m",
      },
      baseWorkspace,
    );
    expect(resolved.timeoutMs).toBe(5_400_000);
  });

  it("uses default timeout when not specified", () => {
    const resolved = resolveTaskLike(
      {
        worker: "CODEX_CLI",
        instructions: "do work",
        capabilities: ["READ"],
      },
      baseWorkspace,
    );
    expect(resolved.timeoutMs).toBe(DEFAULT_STEP_TIMEOUT_MS);
    expect(resolved.timeoutMs).toBe(24 * 60 * 60 * 1000);
  });

  it("parses max_command_time DurationString", () => {
    const resolved = resolveTaskLike(
      {
        worker: "CODEX_CLI",
        instructions: "do work",
        capabilities: ["READ"],
        max_command_time: "30s",
      },
      baseWorkspace,
    );
    expect(resolved.maxCommandTimeMs).toBe(30_000);
  });

  it("omits maxCommandTimeMs when max_command_time is not specified", () => {
    const resolved = resolveTaskLike(
      {
        worker: "CODEX_CLI",
        instructions: "do work",
        capabilities: ["READ"],
      },
      baseWorkspace,
    );
    expect(resolved.maxCommandTimeMs).toBeUndefined();
  });

  it("maps capabilities strings to WorkerCapability enums", () => {
    const resolved = resolveTaskLike(
      {
        worker: "CODEX_CLI",
        instructions: "do work",
        capabilities: ["READ", "EDIT", "RUN_TESTS", "RUN_COMMANDS"],
      },
      baseWorkspace,
    );
    expect(resolved.capabilities).toEqual([
      WorkerCapability.READ,
      WorkerCapability.EDIT,
      WorkerCapability.RUN_TESTS,
      WorkerCapability.RUN_COMMANDS,
    ]);
  });

  it.each([
    ["CODEX_CLI", WorkerKind.CODEX_CLI],
    ["CLAUDE_CODE", WorkerKind.CLAUDE_CODE],
    ["OPENCODE", WorkerKind.OPENCODE],
    ["CUSTOM", WorkerKind.CUSTOM],
  ] as const)("maps worker %s to WorkerKind enum", (worker, expected) => {
    const resolved = resolveTaskLike(
      {
        worker,
        instructions: "do work",
        capabilities: ["READ"],
      },
      baseWorkspace,
    );
    expect(resolved.workerKind).toBe(expected);
  });

  it("passes through model when specified", () => {
    const resolved = resolveTaskLike(
      {
        worker: "CODEX_CLI",
        instructions: "do work",
        capabilities: ["READ"],
        model: "gpt-4",
      },
      baseWorkspace,
    );
    expect(resolved.model).toBe("gpt-4");
  });

  it("omits model when not specified", () => {
    const resolved = resolveTaskLike(
      {
        worker: "CODEX_CLI",
        instructions: "do work",
        capabilities: ["READ"],
      },
      baseWorkspace,
    );
    expect(resolved.model).toBeUndefined();
  });

  it("passes through max_steps", () => {
    const resolved = resolveTaskLike(
      {
        worker: "CODEX_CLI",
        instructions: "do work",
        capabilities: ["READ"],
        max_steps: 100,
      },
      baseWorkspace,
    );
    expect(resolved.maxSteps).toBe(100);
  });

  it("passes through env", () => {
    const env = { FOO: "bar", BAZ: "qux" };
    const resolved = resolveTaskLike(
      {
        worker: "CODEX_CLI",
        instructions: "do work",
        capabilities: ["READ"],
      },
      baseWorkspace,
      env,
    );
    expect(resolved.env).toEqual(env);
  });

  it("omits env when not provided", () => {
    const resolved = resolveTaskLike(
      {
        worker: "CODEX_CLI",
        instructions: "do work",
        capabilities: ["READ"],
      },
      baseWorkspace,
    );
    expect(resolved.env).toBeUndefined();
  });
});

describe("buildWorkerTask", () => {
  const baseResolved: ResolvedWorkerTaskDef = {
    workerKind: WorkerKind.CODEX_CLI,
    workspaceRef: "/home/user/project",
    instructions: "do work",
    capabilities: [WorkerCapability.READ, WorkerCapability.EDIT],
    timeoutMs: 300_000,
  };

  it("creates a WorkerTask with a unique id", () => {
    const ac = new AbortController();
    const task = buildWorkerTask(baseResolved, ac.signal);
    expect(task.workerTaskId).toBeDefined();
    expect(typeof task.workerTaskId).toBe("string");
    expect(task.workerTaskId.length).toBeGreaterThan(0);
  });

  it("sets deadlineAt based on timeoutMs", () => {
    const ac = new AbortController();
    const before = Date.now();
    const task = buildWorkerTask(baseResolved, ac.signal);
    const after = Date.now();

    expect(task.budget.deadlineAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(task.budget.deadlineAt).toBeLessThanOrEqual(after + 300_000);
  });

  it("sets outputMode to BATCH", () => {
    const ac = new AbortController();
    const task = buildWorkerTask(baseResolved, ac.signal);
    expect(task.outputMode).toBe(OutputMode.BATCH);
  });

  it("includes model when present", () => {
    const ac = new AbortController();
    const task = buildWorkerTask({ ...baseResolved, model: "gpt-4" }, ac.signal);
    expect(task.model).toBe("gpt-4");
  });

  it("includes maxSteps in budget when present", () => {
    const ac = new AbortController();
    const task = buildWorkerTask({ ...baseResolved, maxSteps: 50 }, ac.signal);
    expect(task.budget.maxSteps).toBe(50);
  });

  it("includes maxCommandTimeMs in budget when present", () => {
    const ac = new AbortController();
    const task = buildWorkerTask(
      { ...baseResolved, maxCommandTimeMs: 60_000 },
      ac.signal,
    );
    expect(task.budget.maxCommandTimeMs).toBe(60_000);
  });

  it("passes env to WorkerTask", () => {
    const ac = new AbortController();
    const env = { KEY: "val" };
    const task = buildWorkerTask({ ...baseResolved, env }, ac.signal);
    expect(task.env).toEqual(env);
  });

  it("passes abortSignal to WorkerTask", () => {
    const ac = new AbortController();
    const task = buildWorkerTask(baseResolved, ac.signal);
    expect(task.abortSignal).toBe(ac.signal);
  });

  it("generates unique ids across calls", () => {
    const ac = new AbortController();
    const t1 = buildWorkerTask(baseResolved, ac.signal);
    const t2 = buildWorkerTask(baseResolved, ac.signal);
    expect(t1.workerTaskId).not.toBe(t2.workerTaskId);
  });
});
