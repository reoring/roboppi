/**
 * CLI E2E: subworkflow invocation.
 *
 * This test exercises the real CLI (`bun run src/cli.ts workflow ...`) and
 * verifies that a parent workflow can invoke a child workflow via `workflow:`
 * and export child artifacts back into the parent context.
 *
 * Modes covered:
 * - direct: no Core IPC
 * - direct supervised: supervised + stdio IPC transport
 * - supervised: supervised + socket IPC transport (with Supervisor fallback to TCP if needed)
 */

import { describe, it, expect } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { supportsChildBunStdinPipe } from "../../test/helpers/supervised-ipc-capability.js";

type CliExit = { code: number | null; signal: NodeJS.Signals | null };
type CliResult = CliExit & { stdout: string; stderr: string };

const REPO_ROOT = process.cwd();

function createCleanEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Keep tests deterministic and avoid accidental dependency on dev shells.
  for (const key of [
    "ROBOPPI_AGENTS_FILE",
    "ROBOPPI_CORE_ENTRYPOINT",
    "ROBOPPI_SUPERVISED_IPC_TRANSPORT",
    "ROBOPPI_IPC_SOCKET_PATH",
    "ROBOPPI_IPC_SOCKET_HOST",
    "ROBOPPI_IPC_SOCKET_PORT",
    "ROBOPPI_KEEPALIVE",
    "ROBOPPI_KEEPALIVE_INTERVAL",
    "ROBOPPI_IPC_TRACE",
    "ROBOPPI_TUI",
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

  const child = spawn(process.execPath, ["run", "src/cli.ts", "--", ...args], {
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

  return {
    child,
    waitForExit: () => exitPromise,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

async function killProcess(
  child: ChildProcessWithoutNullStreams,
  waitForExit: () => Promise<CliExit>,
  timeoutMs = 2000,
): Promise<CliExit> {
  if (child.killed) return await waitForExit();

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

async function runCli(
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CliResult> {
  const { child, waitForExit, getStdout, getStderr } = spawnCli(args, { env: options?.env });
  const timeoutMs = options?.timeoutMs ?? 60_000;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    // Avoid hangs on a still-open stdin pipe.
    child.stdin.end();

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

async function writeFixtureWorkflows(ws: string): Promise<{ parentPath: string }>{
  await mkdir(ws, { recursive: true });

  const childYaml = [
    "name: child",
    "version: \"1\"",
    "timeout: \"30s\"",
    "steps:",
    "  generate:",
    "    worker: CUSTOM",
    "    instructions: |",
    "      set -euo pipefail",
    "      echo \"hello-from-child\" > report.txt",
    "    capabilities: [RUN_COMMANDS]",
    "    outputs:",
    "      - name: report",
    "        path: report.txt",
    "",
  ].join("\n");

  const parentYaml = [
    "name: parent",
    "version: \"1\"",
    "timeout: \"30s\"",
    "steps:",
    "  invoke-child:",
    "    workflow: \"./child.yaml\"",
    "    exports:",
    "      - from: generate",
    "        artifact: report",
    "        as: exported-report",
    "",
  ].join("\n");

  await writeFile(path.join(ws, "child.yaml"), childYaml, "utf-8");
  const parentPath = path.join(ws, "parent.yaml");
  await writeFile(parentPath, parentYaml, "utf-8");
  return { parentPath };
}

async function verifyRun(ws: string): Promise<void> {
  const contextDir = path.join(ws, "context");
  const parentStepDir = path.join(contextDir, "invoke-child");

  // Parent metadata exists
  await stat(path.join(parentStepDir, "_meta.json"));
  await stat(path.join(parentStepDir, "_resolved.json"));

  // Exported artifact exists + content matches
  const exported = path.join(parentStepDir, "exported-report", "report.txt");
  await stat(exported);
  const content = (await readFile(exported, "utf-8")).trim();
  expect(content).toBe("hello-from-child");

  // Child context dir exists and has _workflow.json
  const subBase = path.join(contextDir, "_subworkflows", "invoke-child");
  const entries = await readdir(subBase);
  expect(entries.length).toBe(1);
  const runDir = path.join(subBase, entries[0]!);
  const workflowMeta = JSON.parse(await readFile(path.join(runDir, "_workflow.json"), "utf-8")) as Record<string, unknown>;
  expect(workflowMeta["name"]).toBe("child");
  expect(workflowMeta["status"]).toBe("SUCCEEDED");

  // Parent meta references the child context dir
  const parentMeta = JSON.parse(await readFile(path.join(parentStepDir, "_meta.json"), "utf-8")) as any;
  expect(parentMeta.subworkflow).toBeTruthy();
  expect(path.resolve(parentMeta.subworkflow.contextDir)).toBe(path.resolve(runDir));
}

describe("CLI E2E: subworkflow invocation (modes)", () => {
  it(
    "direct",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-subwf-direct-"));
      try {
        const ws = path.join(dir, "ws");
        const { parentPath } = await writeFixtureWorkflows(ws);
        const env = createCleanEnv();

        const res = await runCli(
          ["workflow", parentPath, "--workspace", ws, "--direct", "--no-tui"],
          { env, timeoutMs: 60_000 },
        );
        if (res.code !== 0) {
          throw new Error(`CLI failed: code=${res.code} signal=${res.signal}\nstdout=\n${res.stdout}\nstderr=\n${res.stderr}`);
        }
        await verifyRun(ws);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "direct supervised (supervised + stdio transport)",
    async () => {
      if (!(await supportsChildBunStdinPipe())) {
        return;
      }

      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-subwf-supervised-stdio-"));
      try {
        const ws = path.join(dir, "ws");
        const { parentPath } = await writeFixtureWorkflows(ws);
        const env = createCleanEnv({ ROBOPPI_SUPERVISED_IPC_TRANSPORT: "stdio" });

        const res = await runCli(
          ["workflow", parentPath, "--workspace", ws, "--supervised", "--no-tui"],
          { env, timeoutMs: 60_000 },
        );
        if (res.code !== 0) {
          throw new Error(`CLI failed: code=${res.code} signal=${res.signal}\nstdout=\n${res.stdout}\nstderr=\n${res.stderr}`);
        }
        await verifyRun(ws);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "supervised (supervised + socket transport)",
    async () => {
      if (!(await supportsChildBunStdinPipe())) {
        return;
      }

      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-subwf-supervised-socket-"));
      try {
        const ws = path.join(dir, "ws");
        const { parentPath } = await writeFixtureWorkflows(ws);
        const env = createCleanEnv({ ROBOPPI_SUPERVISED_IPC_TRANSPORT: "socket" });

        const res = await runCli(
          ["workflow", parentPath, "--workspace", ws, "--supervised", "--no-tui"],
          { env, timeoutMs: 60_000 },
        );
        if (res.code !== 0) {
          throw new Error(`CLI failed: code=${res.code} signal=${res.signal}\nstdout=\n${res.stdout}\nstderr=\n${res.stderr}`);
        }
        await verifyRun(ws);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
