/**
 * CLI E2E tests
 *
 * Based on tests/cli-test-plan.md
 *
 * These tests intentionally spawn the CLI as a real process.
 */
import { describe, it, expect } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type CliExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type CliResult = CliExit & {
  stdout: string;
  stderr: string;
};

const REPO_ROOT = process.cwd();

function stripAnsi(input: string): string {
  // Good-enough ANSI stripper for CLI status output.
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

function createCleanEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Keep tests deterministic and avoid accidental dependency on dev shells.
  for (const key of [
    "AGENTCORE_AGENTS_FILE",
    "ROBOPPI_AGENTS_FILE",
    "AGENTCORE_CORE_ENTRYPOINT",
    "ROBOPPI_CORE_ENTRYPOINT",
    "AGENTCORE_SUPERVISED_IPC_TRANSPORT",
    "ROBOPPI_SUPERVISED_IPC_TRANSPORT",
    "AGENTCORE_KEEPALIVE",
    "AGENTCORE_KEEPALIVE_INTERVAL",
    "AGENTCORE_IPC_TRACE",
    "ROBOPPI_IPC_TRACE",
  ]) {
    delete env[key];
  }

  env.PATH = env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  env.HOME = env.HOME ?? "";

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  return env;
}

function spawnCli(args: string[], options?: { env?: NodeJS.ProcessEnv; cwd?: string }): {
  child: ChildProcessWithoutNullStreams;
  waitForExit: () => Promise<CliExit>;
  getStdout: () => string;
  getStderr: () => string;
} {
  const env = options?.env ?? createCleanEnv();
  const cwd = options?.cwd ?? REPO_ROOT;

  const child = spawn(process.execPath, ["run", "src/cli.ts", ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitPromise: Promise<CliExit> = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const waitForExit = (): Promise<CliExit> => exitPromise;

  return {
    child,
    waitForExit,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function killProcess(
  child: ChildProcessWithoutNullStreams,
  waitForExit: () => Promise<CliExit>,
  timeoutMs = 2000,
): Promise<CliExit> {
  if (child.killed) {
    return await waitForExit();
  }

  try {
    child.kill("SIGTERM");
  } catch {
    // best-effort
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      waitForExit(),
      new Promise<CliExit>((resolve) => {
        timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // best-effort
          }
          waitForExit().then(resolve);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runCli(args: string[], options?: { stdin?: string; timeoutMs?: number }): Promise<CliResult> {
  const { child, waitForExit, getStdout, getStderr } = spawnCli(args);
  const timeoutMs = options?.timeoutMs ?? 20_000;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    if (options?.stdin !== undefined) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }

    const exit = await Promise.race([
      waitForExit(),
      new Promise<CliExit>((resolve) => {
        timer = setTimeout(() => {
          killProcess(child, waitForExit, 1000).then(resolve);
        }, timeoutMs);
      }),
    ]);

    return { ...exit, stdout: getStdout(), stderr: getStderr() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createLineReader(stream: NodeJS.ReadableStream): {
  nextLine: (timeoutMs?: number) => Promise<string>;
  close: () => void;
} {
  let buffer = "";
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let ended = false;

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (waiters.length > 0) {
        const w = waiters.shift()!;
        w(line);
      } else {
        queue.push(line);
      }
    }
  };

  const onEnd = () => {
    ended = true;
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w("");
    }
  };

  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("close", onEnd);

  const nextLine = (timeoutMs = 5000): Promise<string> => {
    if (queue.length > 0) return Promise.resolve(queue.shift()!);
    if (ended) return Promise.resolve("");

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const done = (line: string) => {
        if (timer) clearTimeout(timer);
        resolve(line);
      };
      waiters.push(done);
      timer = setTimeout(() => {
        const idx = waiters.indexOf(done);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for next line after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  };

  const close = () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("close", onEnd);
  };

  return { nextLine, close };
}

async function waitForMatch(
  getText: () => string,
  onChunk: (handler: () => void) => () => void,
  pattern: RegExp,
  timeoutMs = 5000,
): Promise<void> {
  if (pattern.test(getText())) return;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  return await new Promise<void>((resolve, reject) => {
    const unsubscribe = onChunk(() => {
      if (done) return;
      if (pattern.test(getText())) {
        done = true;
        if (timer) clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });

    timer = setTimeout(() => {
      if (done) return;
      done = true;
      unsubscribe();
      reject(new Error(`Timed out waiting for pattern: ${String(pattern)}`));
    }, timeoutMs);
  });
}

describe("CLI E2E (bun run src/cli.ts ...)", () => {
  it(
    "TC-CLI-01: root help shows subcommands",
    async () => {
      const res = await runCli(["--help"], { timeoutMs: 10_000 });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("roboppi run");
      expect(res.stdout).toContain("roboppi workflow");
      expect(res.stdout).toContain("roboppi daemon");
      expect(res.stdout).toContain("roboppi agent");
    },
    15_000,
  );

  it(
    "TC-CLI-02: workflow help",
    async () => {
      const res = await runCli(["workflow", "--help"], { timeoutMs: 10_000 });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("roboppi workflow <workflow.yaml>");
    },
    15_000,
  );

  it(
    "TC-CLI-03: daemon help",
    async () => {
      const res = await runCli(["daemon", "--help"], { timeoutMs: 10_000 });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("roboppi daemon <daemon.yaml>");
    },
    15_000,
  );

  it(
    "TC-CLI-04: agent is alias of run (missing required args)",
    async () => {
      const runRes = await runCli(["run"], { timeoutMs: 20_000 });
      const agentRes = await runCli(["agent"], { timeoutMs: 20_000 });

      expect(runRes.code).not.toBe(0);
      expect(agentRes.code).not.toBe(0);

      expect(runRes.code).toBe(agentRes.code);
      expect(runRes.stderr).toContain("--worker is required");
      expect(agentRes.stderr).toContain("--worker is required");
    },
    60_000,
  );

  it(
    "TC-WF-01: workflow (supervised default) runs hello-world",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-wf-"));
      try {
        const ws = path.join(dir, "ws");
        await mkdir(ws, { recursive: true });

        const res = await runCli(
          [
            "workflow",
            "examples/hello-world.yaml",
            "--verbose",
            "--workspace",
            ws,
          ],
          { timeoutMs: 60_000 },
        );

        expect(res.code).toBe(0);
        expect(stripAnsi(res.stdout)).toMatch(/PASS\s+greet/);

        const helloPath = path.join(ws, "hello.txt");
        const content = await readFile(helloPath, "utf-8");
        expect(content).toContain("Hello from AgentCore Workflow!");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "TC-WF-02: workflow (direct) runs hello-world",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-wf-direct-"));
      try {
        const ws = path.join(dir, "ws");
        await mkdir(ws, { recursive: true });

        const res = await runCli(
          [
            "workflow",
            "examples/hello-world.yaml",
            "--direct",
            "--verbose",
            "--workspace",
            ws,
          ],
          { timeoutMs: 60_000 },
        );

        expect(res.code).toBe(0);
        expect(stripAnsi(res.stdout)).toMatch(/PASS\s+greet/);

        const helloPath = path.join(ws, "hello.txt");
        const content = await readFile(helloPath, "utf-8");
        expect(content).toContain("Hello from AgentCore Workflow!");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "TC-DMN-01: daemon starts and can be stopped quickly",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-daemon-"));
      try {
        const ws = path.join(dir, "ws");
        await mkdir(ws, { recursive: true });

        const daemonYamlPath = path.join(dir, "daemon.yaml");
        await writeFile(
          daemonYamlPath,
          [
            "name: e2e-daemon",
            "version: \"1\"",
            "workspace: \"" + ws.replace(/\\/g, "\\\\") + "\"",
            "",
            "events:",
            "  tick:",
            "    type: interval",
            "    every: \"30s\"",
            "",
            "triggers:",
            "  noop:",
            "    on: tick",
            "    workflow: \"./does-not-run.yaml\"",
            "    on_workflow_failure: ignore",
            "",
          ].join("\n"),
          "utf-8",
        );

        const env = createCleanEnv();
        const { child, waitForExit, getStderr } = spawnCli(
          ["daemon", daemonYamlPath, "--direct", "--verbose"],
          { env },
        );

        const unsubscribers: Array<() => void> = [];
        const onStderrChunk = (handler: () => void) => {
          const fn = () => handler();
          child.stderr.on("data", fn);
          const unsub = () => child.stderr.off("data", fn);
          unsubscribers.push(unsub);
          return unsub;
        };

        try {
          await waitForMatch(
            getStderr,
            onStderrChunk,
            /Event loop started, waiting for events\.\.\./,
            10_000,
          );

          const exit = await killProcess(child, waitForExit, 5000);
          expect(exit.code === 0 || exit.signal === "SIGTERM").toBe(true);
        } finally {
          for (const u of unsubscribers) u();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "TC-SRV-01: Core IPC server returns JSONL ack on stdout",
    async () => {
      const env = createCleanEnv();
      const { child, waitForExit, getStdout, getStderr } = spawnCli([], { env });

      const stdoutReader = createLineReader(child.stdout);
      try {
        const job = {
          jobId: "e2e-job-1",
          type: "WORKER_TASK",
          priority: { value: 1, class: "INTERACTIVE" },
          payload: {},
          limits: { timeoutMs: 1000, maxAttempts: 1 },
          context: { traceId: "t", correlationId: "c" },
        };
        const requestId = "e2e-req-1";
        const msg = { type: "submit_job", requestId, job };

        child.stdin.write(JSON.stringify(msg) + "\n");

        const line = await stdoutReader.nextLine(10_000);
        const trimmed = line.trim();
        expect(trimmed.startsWith("{")).toBe(true);
        expect(trimmed.endsWith("}")).toBe(true);
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        expect(parsed["type"]).toBe("ack");
        expect(parsed["requestId"]).toBe(requestId);
        expect(parsed["jobId"]).toBe("e2e-job-1");

        const exit = await killProcess(child, waitForExit, 5000);
        expect(exit.code === 0 || exit.signal === "SIGTERM").toBe(true);
      } catch (err) {
        // Surface child stderr for easier debugging.
        const detail = `stdout=\n${getStdout()}\n\nstderr=\n${getStderr()}`;
        throw new Error(`${err instanceof Error ? err.message : String(err)}\n\n${detail}`);
      } finally {
        stdoutReader.close();
        await killProcess(child, waitForExit, 1000).catch(() => {});
      }
    },
    30_000,
  );
});
