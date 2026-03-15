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
import { supportsChildBunStdinPipe } from "../../test/helpers/supervised-ipc-capability.js";
import { ROBOPPI_VERSION } from "../../src/version.js";

type CliExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type CliResult = CliExit & {
  stdout: string;
  stderr: string;
};

const REPO_ROOT = process.cwd();

function exitedAcceptablyForResidentCleanup(exit: CliExit): boolean {
  return exit.signal === "SIGTERM" || exit.signal === "SIGKILL" || exit.code === 0 || exit.code === 143;
}

function stripAnsi(input: string): string {
  // Good-enough ANSI stripper for CLI status output.
  return input.replace(/\x1b\[[0-9;]*m/g, "");
}

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

  // NOTE: Use `--` to ensure Bun forwards positional args (e.g. "run")
  // to the CLI script, rather than interpreting them as Bun subcommands.
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
      child.stdin.end(options.stdin);
    } else {
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

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
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
      expect(res.stdout).toContain("roboppi task-orchestrator run");
      expect(res.stdout).toContain("roboppi task-orchestrator serve");
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
    "TC-CLI-02b: version output matches release version",
    async () => {
      const res = await runCli(["--version"], { timeoutMs: 10_000 });
      expect(res.code).toBe(0);
      expect(res.stdout.trim()).toBe(`roboppi ${ROBOPPI_VERSION}`);
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
    "TC-CLI-03b: task-orchestrator help",
    async () => {
      const res = await runCli(["task-orchestrator", "--help"], { timeoutMs: 10_000 });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("roboppi task-orchestrator run <config.yaml>");
      expect(res.stdout).toContain("roboppi task-orchestrator serve <config.yaml>");
      expect(res.stdout).toContain("roboppi task-orchestrator status <config.yaml>");
      expect(res.stdout).toContain("roboppi task-orchestrator intent emit");
      expect(res.stdout).toContain("roboppi task-orchestrator github record-pr-open-request");
      expect(res.stdout).toContain("roboppi task-orchestrator github record-review-result");
      expect(res.stdout).toContain("roboppi task-orchestrator github apply-pr-open");
      expect(res.stdout).toContain("roboppi task-orchestrator github apply-pr-review");
    },
    15_000,
  );

  it(
    "TC-CLI-03c: task-orchestrator intent emit records a materialized verdict",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-intent-"));
      try {
        const contextDir = path.join(dir, "context");
        await mkdir(path.join(contextDir, "_task"), { recursive: true });
        await writeFile(
          path.join(contextDir, "_task", "run.json"),
          JSON.stringify({
            version: "1",
            task_id: "github:pull_request:owner/repo#45",
            run_id: "run-123",
          }, null, 2) + "\n",
        );
        await writeFile(
          path.join(contextDir, "_task", "task-policy.json"),
          JSON.stringify({
            version: "1",
            members: {
              reviewer: { roles: ["reviewer"] },
            },
            intents: {
              review_verdict: {
                allowed_members: ["reviewer"],
                allowed_roles: ["reviewer"],
              },
            },
          }, null, 2) + "\n",
        );

        const res = await runCli([
          "task-orchestrator",
          "intent",
          "emit",
          "--context",
          contextDir,
          "--kind",
          "review_verdict",
          "--payload-json",
          '{"decision":"approve","rationale":"Looks good"}',
          "--member-id",
          "reviewer",
          "--json",
        ], { timeoutMs: 20_000 });

        expect(res.code).toBe(0);
        expect(JSON.parse(res.stdout)).toMatchObject({
          kind: "review_verdict",
          member_id: "reviewer",
          accepted: true,
        });

        const verdict = JSON.parse(
          await readFile(path.join(contextDir, "_task", "review-verdict.json"), "utf-8"),
        );
        expect(verdict).toMatchObject({
          decision: "approve",
          rationale: "Looks good",
          member_id: "reviewer",
          source: "intent",
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "TC-CLI-03c1: task-orchestrator intent emit accepts --payload-mailbox-body",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-intent-mailbox-"));
      try {
        const contextDir = path.join(dir, "context");
        const mailboxDir = path.join(dir, "mailbox");
        await mkdir(path.join(contextDir, "_task"), { recursive: true });
        await mkdir(mailboxDir, { recursive: true });
        await writeFile(
          path.join(contextDir, "_task", "run.json"),
          JSON.stringify({
            version: "1",
            task_id: "github:issue:owner/repo#45",
            run_id: "run-123",
          }, null, 2) + "\n",
        );
        await writeFile(
          path.join(contextDir, "_task", "task-policy.json"),
          JSON.stringify({
            version: "1",
            members: {
              lead: { roles: ["lead"] },
            },
            intents: {
              pr_open_request: {
                allowed_members: ["lead"],
                allowed_roles: ["lead"],
              },
            },
          }, null, 2) + "\n",
        );
        const mailboxMessagePath = path.join(mailboxDir, "review-required.json");
        await writeFile(
          mailboxMessagePath,
          JSON.stringify({
            version: "1",
            body: JSON.stringify({
              pr_title: "Fix issue #45: tighten README",
              pr_body: "Implements the README tweak.\n\nCloses #45",
              head_ref: "roboppi/issue-45-tighten-readme",
              base_ref: "main",
              labels: ["roboppi-live-e2e-pr"],
            }),
          }, null, 2) + "\n",
        );

        const res = await runCli([
          "task-orchestrator",
          "intent",
          "emit",
          "--context",
          contextDir,
          "--kind",
          "pr_open_request",
          "--payload-mailbox-body",
          mailboxMessagePath,
          "--member-id",
          "lead",
          "--json",
        ], { timeoutMs: 20_000 });

        expect(res.code).toBe(0);
        expect(JSON.parse(res.stdout)).toMatchObject({
          kind: "pr_open_request",
          member_id: "lead",
          accepted: true,
        });

        const openRequest = JSON.parse(
          await readFile(path.join(contextDir, "_task", "pr-open-request.json"), "utf-8"),
        );
        expect(openRequest).toMatchObject({
          title: "Fix issue #45: tighten README",
          head_ref: "roboppi/issue-45-tighten-readme",
          base_ref: "main",
          labels: ["roboppi-live-e2e-pr"],
          member_id: "lead",
          source: "intent",
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "TC-CLI-03c2: task-orchestrator activity emit accepts --mailbox-message",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-activity-mailbox-"));
      try {
        const contextDir = path.join(dir, "context");
        const mailboxDir = path.join(dir, "mailbox");
        await mkdir(path.join(contextDir, "_task"), { recursive: true });
        await mkdir(mailboxDir, { recursive: true });
        await writeFile(
          path.join(contextDir, "_task", "run.json"),
          JSON.stringify({
            version: "1",
            task_id: "github:issue:owner/repo#45",
            run_id: "run-123",
          }, null, 2) + "\n",
        );
        await writeFile(
          path.join(contextDir, "_task", "task-policy.json"),
          JSON.stringify({
            version: "1",
            members: {
              reporter: { roles: ["publisher"] },
            },
            intents: {
              activity: {
                allowed_members: ["reporter"],
                allowed_roles: ["publisher"],
              },
            },
          }, null, 2) + "\n",
        );
        const mailboxMessagePath = path.join(mailboxDir, "task-activity.json");
        await writeFile(
          mailboxMessagePath,
          JSON.stringify({
            version: "1",
            body: JSON.stringify({
              kind: "review_required",
              phase: "implement",
              message: "Branch is ready for PR creation",
              metadata: {
                branch: "roboppi/issue-45-tighten-readme",
              },
            }),
          }, null, 2) + "\n",
        );

        const res = await runCli([
          "task-orchestrator",
          "activity",
          "emit",
          "--context",
          contextDir,
          "--mailbox-message",
          mailboxMessagePath,
          "--member-id",
          "reporter",
          "--json",
        ], { timeoutMs: 20_000 });

        expect(res.code).toBe(0);
        expect(JSON.parse(res.stdout)).toMatchObject({
          kind: "review_required",
          phase: "implement",
          message: "Branch is ready for PR creation",
          member_id: "reporter",
          metadata: {
            branch: "roboppi/issue-45-tighten-readme",
          },
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "TC-CLI-03c3: task-orchestrator github record-pr-open-request auto-discovers review_required mailbox",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-gh-record-open-"));
      try {
        const contextDir = path.join(dir, "context");
        const taskDir = path.join(contextDir, "_task");
        const agentsDir = path.join(contextDir, "_agents");
        const leadInboxDir = path.join(agentsDir, "mailbox", "inbox", "lead", "cur");
        await mkdir(taskDir, { recursive: true });
        await mkdir(leadInboxDir, { recursive: true });

        await writeFile(
          path.join(taskDir, "run.json"),
          JSON.stringify({
            version: "1",
            task_id: "github:issue:owner/repo#45",
            run_id: "run-123",
          }, null, 2) + "\n",
        );
        await writeFile(
          path.join(taskDir, "task-policy.json"),
          JSON.stringify({
            version: "1",
            members: {
              lead: { roles: ["lead"] },
            },
            intents: {
              pr_open_request: {
                allowed_members: ["lead"],
                allowed_roles: ["lead"],
              },
            },
          }, null, 2) + "\n",
        );
        const reviewRequiredMailboxPath = path.join(
          leadInboxDir,
          "123-review-required.json",
        );
        await writeFile(
          reviewRequiredMailboxPath,
          JSON.stringify({
            version: "1",
            body: JSON.stringify({
              kind: "review_required",
              phase: "implement",
              message: "Branch is ready for PR creation",
              head_ref: "roboppi/issue-45-tighten-readme",
              pr_title: "Fix issue #45: tighten README",
              pr_body: "Implements the README tweak.\n\nCloses #45",
              base_ref: "main",
              labels: ["roboppi-live-e2e-pr"],
            }),
          }, null, 2) + "\n",
        );
        await writeFile(
          path.join(agentsDir, "inbox-summary.json"),
          JSON.stringify({
            version: "1",
            entries: [
              {
                topic: "implementation_milestone",
                mailbox_path: "_agents/mailbox/inbox/lead/cur/123-review-required.json",
              },
            ],
          }, null, 2) + "\n",
        );

        const res = await runCli([
          "task-orchestrator",
          "github",
          "record-pr-open-request",
          "--context",
          contextDir,
          "--member-id",
          "lead",
          "--json",
        ], { timeoutMs: 20_000 });

        expect(res.code).toBe(0);
        expect(JSON.parse(res.stdout)).toMatchObject({
          task_id: "github:issue:owner/repo#45",
          run_id: "run-123",
          payload: {
            title: "Fix issue #45: tighten README",
            head_ref: "roboppi/issue-45-tighten-readme",
            base_ref: "main",
            labels: ["roboppi-live-e2e-pr"],
          },
        });

        const openRequest = JSON.parse(
          await readFile(path.join(taskDir, "pr-open-request.json"), "utf-8"),
        );
        expect(openRequest).toMatchObject({
          title: "Fix issue #45: tighten README",
          body: "Implements the README tweak.\n\nCloses #45",
          head_ref: "roboppi/issue-45-tighten-readme",
          base_ref: "main",
          labels: ["roboppi-live-e2e-pr"],
          member_id: "lead",
          source: "intent",
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "TC-CLI-03c4: task-orchestrator github record-review-result auto-discovers review_result mailbox",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-gh-record-review-"));
      try {
        const contextDir = path.join(dir, "context");
        const taskDir = path.join(contextDir, "_task");
        const agentsDir = path.join(contextDir, "_agents");
        const leadInboxDir = path.join(agentsDir, "mailbox", "inbox", "lead", "cur");
        await mkdir(taskDir, { recursive: true });
        await mkdir(leadInboxDir, { recursive: true });

        await writeFile(
          path.join(taskDir, "run.json"),
          JSON.stringify({
            version: "1",
            task_id: "github:pull_request:owner/repo#50",
            run_id: "run-456",
          }, null, 2) + "\n",
        );
        await writeFile(
          path.join(taskDir, "task-policy.json"),
          JSON.stringify({
            version: "1",
            members: {
              lead: { roles: ["lead"] },
            },
            intents: {
              review_verdict: {
                allowed_members: ["lead"],
                allowed_roles: ["lead"],
              },
              merge_request: {
                allowed_members: ["lead"],
                allowed_roles: ["lead"],
              },
            },
          }, null, 2) + "\n",
        );
        const reviewMailboxPath = path.join(
          leadInboxDir,
          "123-review-result.json",
        );
        await writeFile(
          reviewMailboxPath,
          JSON.stringify({
            version: "1",
            body: JSON.stringify({
              decision: "approve",
              message: "Reviewed the PR and found no blocking issues",
            }),
          }, null, 2) + "\n",
        );
        await writeFile(
          path.join(agentsDir, "inbox-summary.json"),
          JSON.stringify({
            version: "1",
            entries: [
              {
                topic: "review_result",
                mailbox_path: "_agents/mailbox/inbox/lead/cur/123-review-result.json",
              },
            ],
          }, null, 2) + "\n",
        );

        const res = await runCli([
          "task-orchestrator",
          "github",
          "record-review-result",
          "--context",
          contextDir,
          "--member-id",
          "lead",
          "--json",
        ], { timeoutMs: 20_000 });

        expect(res.code).toBe(0);
        expect(JSON.parse(res.stdout)).toMatchObject({
          task_id: "github:pull_request:owner/repo#50",
          run_id: "run-456",
          decision: "approve",
          review_verdict: {
            decision: "approve",
          },
          merge_request: {
            strategy: "squash",
          },
        });

        const reviewVerdict = JSON.parse(
          await readFile(path.join(taskDir, "review-verdict.json"), "utf-8"),
        );
        expect(reviewVerdict).toMatchObject({
          decision: "approve",
          rationale: "Reviewed the PR and found no blocking issues",
          member_id: "lead",
          source: "intent",
        });

        const mergeRequest = JSON.parse(
          await readFile(path.join(taskDir, "merge-request.json"), "utf-8"),
        );
        expect(mergeRequest).toMatchObject({
          strategy: "squash",
          rationale: "Reviewed the PR and found no blocking issues",
          member_id: "lead",
          source: "intent",
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "TC-CLI-03d: task-orchestrator github apply-pr-open applies accepted PR-open intent",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-gh-open-"));
      try {
        const contextDir = path.join(dir, "context");
        const taskDir = path.join(contextDir, "_task");
        const mockBinDir = path.join(dir, "mock-bin");
        const artifactDir = path.join(dir, "artifacts");
        await mkdir(taskDir, { recursive: true });
        await mkdir(mockBinDir, { recursive: true });
        await mkdir(artifactDir, { recursive: true });

        await writeFile(
          path.join(taskDir, "run.json"),
          JSON.stringify({
            version: "1",
            task_id: "github:issue:owner/repo#45",
            run_id: "run-123",
          }, null, 2) + "\n",
        );
        await writeFile(
          path.join(taskDir, "task.json"),
          JSON.stringify({
            version: "1",
            task_id: "github:issue:owner/repo#45",
            source: {
              kind: "github_issue",
              system_id: "github",
              external_id: "owner/repo#45",
              url: "https://github.com/owner/repo/issues/45",
            },
            title: "Issue #45",
            body: "Fix it",
            labels: ["bug"],
            priority: "normal",
            repository: {
              id: "owner/repo",
              default_branch: "main",
            },
            requested_action: "implement",
            requested_by: "octocat",
            timestamps: {
              created_at: 1000,
              updated_at: 2000,
            },
          }, null, 2) + "\n",
        );
        await writeFile(
          path.join(taskDir, "pr-open-request.json"),
          JSON.stringify({
            version: "1",
            title: "Fix issue #45: tighten README",
            body: "Implements the requested README tweak.\n\nCloses #45",
            head_ref: "roboppi/issue-45-tighten-readme",
            base_ref: "main",
            labels: ["roboppi-live-e2e-pr"],
            member_id: "lead",
            ts: 100,
            source: "intent",
          }, null, 2) + "\n",
        );

        await writeFile(
          path.join(mockBinDir, "gh"),
          `#!/usr/bin/env bash
set -euo pipefail
ARTIFACT_DIR=${JSON.stringify(artifactDir)}
printf '%s\\n' "$*" >> "$ARTIFACT_DIR/gh-calls.log"
if [[ "$1" == "pr" && "$2" == "create" ]]; then
  printf '%s\\n' 'https://github.com/owner/repo/pull/91'
  exit 0
fi
echo "unsupported gh call: $*" >&2
exit 1
`,
          { mode: 0o755 },
        );

        const env = createCleanEnv({
          PATH: `${mockBinDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
        });
        const { child, waitForExit, getStdout, getStderr } = spawnCli(
          [
            "task-orchestrator",
            "github",
            "apply-pr-open",
            "--context",
            contextDir,
            "--json",
          ],
          { env },
        );
        child.stdin.end();
        const exit = await waitForExit();
        expect(exit.code).toBe(0);
        expect(getStderr()).toBe("");

        expect(JSON.parse(getStdout())).toMatchObject({
          landing_lifecycle: "review_required",
          pull_request: {
            repository: "owner/repo",
            number: 91,
          },
        });

        const landing = JSON.parse(
          await readFile(path.join(taskDir, "landing.json"), "utf-8"),
        );
        expect(landing).toMatchObject({
          lifecycle: "review_required",
          metadata: {
            pr_url: "https://github.com/owner/repo/pull/91",
            pr_number: 91,
          },
        });

        const ghCalls = await readFile(path.join(artifactDir, "gh-calls.log"), "utf-8");
        expect(ghCalls).toContain("pr create --repo owner/repo --title Fix issue #45: tighten README");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "TC-CLI-03e: task-orchestrator github apply-pr-review applies accepted intents",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-gh-actuation-"));
      try {
        const contextDir = path.join(dir, "context");
        const taskDir = path.join(contextDir, "_task");
        const mockBinDir = path.join(dir, "mock-bin");
        const artifactDir = path.join(dir, "artifacts");
        await mkdir(taskDir, { recursive: true });
        await mkdir(mockBinDir, { recursive: true });
        await mkdir(artifactDir, { recursive: true });

        await writeFile(
          path.join(taskDir, "run.json"),
          JSON.stringify({
            version: "1",
            task_id: "github:pull_request:owner/repo#45",
            run_id: "run-123",
          }, null, 2) + "\n",
        );
        await writeFile(
          path.join(taskDir, "task.json"),
          JSON.stringify({
            version: "1",
            task_id: "github:pull_request:owner/repo#45",
            source: {
              kind: "github_pull_request",
              system_id: "github",
              external_id: "owner/repo#45",
              url: "https://github.com/owner/repo/pull/45",
            },
            title: "Review PR #45",
            body: "Implements the fix",
            labels: ["review"],
            priority: "normal",
            repository: {
              id: "owner/repo",
              default_branch: "main",
            },
            requested_action: "review",
            requested_by: "octocat",
            timestamps: {
              created_at: 1000,
              updated_at: 2000,
            },
          }, null, 2) + "\n",
        );
        await writeFile(
          path.join(taskDir, "review-verdict.json"),
          JSON.stringify({
            version: "1",
            decision: "approve",
            rationale: "Looks good",
            member_id: "lead",
            ts: 100,
            source: "intent",
          }, null, 2) + "\n",
        );
        await writeFile(
          path.join(taskDir, "merge-request.json"),
          JSON.stringify({
            version: "1",
            strategy: "squash",
            rationale: "Ready to land",
            member_id: "lead",
            ts: 101,
            source: "intent",
          }, null, 2) + "\n",
        );

        await writeFile(
          path.join(mockBinDir, "gh"),
          `#!/usr/bin/env bash
set -euo pipefail
ARTIFACT_DIR=${JSON.stringify(artifactDir)}
printf '%s\\n' "$*" >> "$ARTIFACT_DIR/gh-calls.log"
if [[ "$1" == "pr" && "$2" == "review" ]]; then
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "merge" ]]; then
  exit 0
fi
if [[ "$1" == "pr" && "$2" == "view" ]]; then
  printf '%s\\n' '{"state":"MERGED","reviews":[{"state":"APPROVED"}]}'
  exit 0
fi
echo "unsupported gh call: $*" >&2
exit 1
`,
          { mode: 0o755 },
        );

        const env = createCleanEnv({
          PATH: `${mockBinDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
        });
        const { child, waitForExit, getStdout, getStderr } = spawnCli(
          [
            "task-orchestrator",
            "github",
            "apply-pr-review",
            "--context",
            contextDir,
            "--json",
          ],
          { env },
        );
        child.stdin.end();
        const exit = await waitForExit();
        expect(exit.code).toBe(0);
        expect(getStderr()).toBe("");

        expect(JSON.parse(getStdout())).toMatchObject({
          decision: "approve",
          merged: true,
          landing_lifecycle: "landed",
        });

        const landing = JSON.parse(
          await readFile(path.join(taskDir, "landing.json"), "utf-8"),
        );
        expect(landing).toMatchObject({
          lifecycle: "landed",
          rationale: "Looks good",
        });

        const ghCalls = await readFile(path.join(artifactDir, "gh-calls.log"), "utf-8");
        expect(ghCalls).toContain("pr review 45 --repo owner/repo --approve --body Looks good");
        expect(ghCalls).toContain("pr merge 45 --repo owner/repo --delete-branch --squash");
        expect(ghCalls).toContain("pr view 45 --repo owner/repo --json state,reviews");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    "TC-CLI-04: agent is alias of run (missing required args)",
    async () => {
      const runRes = await runCli(["run"], { timeoutMs: 20_000 });
      const agentRes = await runCli(["agent"], { timeoutMs: 20_000 });

      expect(runRes.signal).toBeNull();
      expect(agentRes.signal).toBeNull();
      expect(runRes.code).not.toBeNull();
      expect(agentRes.code).not.toBeNull();

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
      if (!(await supportsChildBunStdinPipe())) {
        return;
      }

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
    "TC-TO-01: task-orchestrator run (direct) processes file inbox task",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-orchestrator-"));
      try {
        const inboxDir = path.join(dir, "inbox");
        const repoDir = path.join(dir, "repo");
        const workflowDir = path.join(repoDir, "workflows");
        await mkdir(inboxDir, { recursive: true });
        await mkdir(workflowDir, { recursive: true });

        await writeFile(
          path.join(workflowDir, "task.yaml"),
          `
name: task-workflow
version: "1"
timeout: "5m"
steps:
  implement:
    worker: CUSTOM
    instructions: |
      test -f "$ROBOPPI_TASK_CONTEXT_DIR/_task/task.json"
      printf "%s" "$ROBOPPI_TASK_ID" > task-id.txt
    capabilities: [READ]
    outputs:
      - name: task-id
        path: task-id.txt
`,
        );

        await writeFile(
          path.join(inboxDir, "task.json"),
          JSON.stringify({
            title: "CLI task",
            labels: ["bug"],
            repository: {
              id: "owner/repo",
              local_path: "../repo",
            },
          }) + "\n",
        );

        await writeFile(
          path.join(dir, "task-orchestrator.yaml"),
          `
name: cli-task-orchestrator
version: "1"
state_dir: ./.roboppi-task
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  bugfix:
    when:
      source: file_inbox
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
landing:
  mode: manual
`,
        );

        const res = await runCli(
          [
            "task-orchestrator",
            "run",
            path.join(dir, "task-orchestrator.yaml"),
            "--direct",
          ],
          { timeoutMs: 60_000 },
        );

        expect(res.code).toBe(0);
        expect(stripAnsi(res.stdout)).toContain("Task Orchestrator: cli-task-orchestrator");
        expect(stripAnsi(res.stdout)).toContain("Totals: candidates=1 dispatched=1 skipped_active=0 skipped_unchanged=0 unmatched=0 failed=0 acked=1 ack_failed=0");

        const taskId = await readFile(path.join(repoDir, "task-id.txt"), "utf-8");
        expect(taskId).toBe("file_inbox:inbox:task.json");

        const ackPath = path.join(inboxDir, ".roboppi-acks", "task.json.ack.json");
        const ackText = await readFile(ackPath, "utf-8");
        expect(ackText).toContain('"state": "review_required"');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "TC-TO-02: task-orchestrator run --json emits machine-readable summary",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-orchestrator-json-"));
      try {
        const inboxDir = path.join(dir, "inbox");
        const repoDir = path.join(dir, "repo");
        const workflowDir = path.join(repoDir, "workflows");
        await mkdir(inboxDir, { recursive: true });
        await mkdir(workflowDir, { recursive: true });

        await writeFile(
          path.join(workflowDir, "task.yaml"),
          `
name: task-workflow
version: "1"
timeout: "5m"
steps:
  implement:
    worker: CUSTOM
    instructions: |
      printf "%s" "$ROBOPPI_TASK_ID" > task-id.txt
    capabilities: [READ]
`,
        );

        await writeFile(
          path.join(inboxDir, "task.json"),
          JSON.stringify({
            title: "CLI task",
            labels: ["bug"],
            repository: {
              id: "owner/repo",
              local_path: "../repo",
            },
          }) + "\n",
        );

        await writeFile(
          path.join(dir, "task-orchestrator.yaml"),
          `
name: cli-task-orchestrator-json
version: "1"
state_dir: ./.roboppi-task
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  bugfix:
    when:
      source: file_inbox
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
landing:
  mode: manual
`,
        );

        const res = await runCli(
          [
            "task-orchestrator",
            "run",
            path.join(dir, "task-orchestrator.yaml"),
            "--direct",
            "--json",
          ],
          { timeoutMs: 60_000 },
        );

        expect(res.code).toBe(0);
        const parsed = JSON.parse(res.stdout);
        expect(parsed.config).toEqual({
          name: "cli-task-orchestrator-json",
          sources: 1,
          routes: 1,
        });
        expect(parsed.result.totals).toEqual({
          candidates: 1,
          dispatched: 1,
          skipped_active: 0,
          skipped_unchanged: 0,
          unmatched: 0,
          failed: 0,
          acked: 1,
          ack_failed: 0,
        });
        expect(parsed.result.sources[0].sourceId).toBe("inbox");
        expect(parsed.result.sources[0].errors).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "TC-TO-03: task-orchestrator status reports persisted task state",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-orchestrator-status-"));
      try {
        const inboxDir = path.join(dir, "inbox");
        const repoDir = path.join(dir, "repo");
        const workflowDir = path.join(repoDir, "workflows");
        await mkdir(inboxDir, { recursive: true });
        await mkdir(workflowDir, { recursive: true });

        await writeFile(
          path.join(workflowDir, "task.yaml"),
          `
name: task-workflow
version: "1"
timeout: "5m"
steps:
  implement:
    worker: CUSTOM
    instructions: |
      printf '%s\\n' '{"version":"1","lifecycle":"ready_to_land","rationale":"PR opened"}' > "$ROBOPPI_TASK_CONTEXT_DIR/_task/landing.json"
    capabilities: [READ]
`,
        );

        await writeFile(
          path.join(inboxDir, "task.json"),
          JSON.stringify({
            title: "CLI status task",
            labels: ["bug"],
            repository: {
              id: "owner/repo",
              local_path: "../repo",
            },
          }) + "\n",
        );

        await writeFile(
          path.join(dir, "task-orchestrator.yaml"),
          `
name: cli-task-orchestrator-status
version: "1"
state_dir: ./.roboppi-task
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  bugfix:
    when:
      source: file_inbox
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
landing:
  mode: manual
`,
        );

        const runRes = await runCli(
          [
            "task-orchestrator",
            "run",
            path.join(dir, "task-orchestrator.yaml"),
            "--direct",
          ],
          { timeoutMs: 60_000 },
        );
        expect(runRes.code).toBe(0);

        const statusRes = await runCli(
          [
            "task-orchestrator",
            "status",
            path.join(dir, "task-orchestrator.yaml"),
            "--json",
            "--task-id",
            "file_inbox:inbox:task.json",
          ],
          { timeoutMs: 60_000 },
        );

        expect(statusRes.code).toBe(0);
        const parsed = JSON.parse(statusRes.stdout);
        expect(parsed.config).toEqual({
          name: "cli-task-orchestrator-status",
          state_dir: path.join(dir, ".roboppi-task"),
        });
        expect(parsed.filters).toEqual({
          active: false,
          task_id: "file_inbox:inbox:task.json",
          limit: 20,
        });
        expect(parsed.tasks).toHaveLength(1);
        expect(parsed.tasks[0]).toMatchObject({
          task_id: "file_inbox:inbox:task.json",
          lifecycle: "ready_to_land",
          title: "CLI status task",
          latest_summary: {
            final_lifecycle: "ready_to_land",
          },
          latest_landing: {
            lifecycle: "ready_to_land",
            source: "workflow",
          },
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "TC-TO-04: task-orchestrator serve keeps polling while a task workflow runs in background",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-orchestrator-serve-"));
      let child: ChildProcessWithoutNullStreams | undefined;
      let waitForExit: (() => Promise<CliExit>) | undefined;
      let getStderr: (() => string) | undefined;
      try {
        const inboxDir = path.join(dir, "inbox");
        const repoDir = path.join(dir, "repo");
        const workflowDir = path.join(repoDir, "workflows");
        await mkdir(inboxDir, { recursive: true });
        await mkdir(workflowDir, { recursive: true });

        await writeFile(
          path.join(workflowDir, "task.yaml"),
          `
name: task-workflow
version: "1"
timeout: "5m"
steps:
  implement:
    worker: CUSTOM
    instructions: |
      test -f "$ROBOPPI_TASK_CONTEXT_DIR/_task/task.json"
      printf "%s" "$ROBOPPI_TASK_ID" > task-id.txt
      sleep 30
    capabilities: [READ]
    outputs:
      - name: task-id
        path: task-id.txt
`,
        );

        await writeFile(
          path.join(inboxDir, "task.json"),
          JSON.stringify({
            title: "CLI serve task",
            labels: ["bug"],
            repository: {
              id: "owner/repo",
              local_path: "../repo",
            },
          }) + "\n",
        );

        await writeFile(
          path.join(dir, "task-orchestrator.yaml"),
          `
name: cli-task-orchestrator-serve
version: "1"
runtime:
  poll_every: 1s
state_dir: ./.roboppi-task
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  bugfix:
    when:
      source: file_inbox
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
landing:
  mode: manual
`,
        );

        const spawned = spawnCli([
          "task-orchestrator",
          "serve",
          path.join(dir, "task-orchestrator.yaml"),
          "--direct",
          "--poll-every",
          "200ms",
        ]);
        child = spawned.child;
        waitForExit = spawned.waitForExit;
        getStderr = spawned.getStderr;
        const liveChild = spawned.child;

        liveChild.stdin.end();

        await waitForMatch(
          spawned.getStdout,
          (handler) => {
            liveChild.stdout.on("data", handler);
            return () => liveChild.stdout.off("data", handler);
          },
          /\[cycle\].*dispatched=1/,
          20_000,
        );

        const statusRes = await runCli(
          [
            "task-orchestrator",
            "status",
            path.join(dir, "task-orchestrator.yaml"),
            "--json",
            "--task-id",
            "file_inbox:inbox:task.json",
          ],
          { timeoutMs: 20_000 },
        );
        expect(statusRes.code).toBe(0);
        const parsed = JSON.parse(statusRes.stdout);
        expect(parsed.tasks).toHaveLength(1);
        expect(parsed.tasks[0]?.task_id).toBe("file_inbox:inbox:task.json");
        expect(parsed.tasks[0]?.active_run_id).not.toBeNull();

        const taskId = await readFile(path.join(repoDir, "task-id.txt"), "utf-8");
        expect(taskId).toBe("file_inbox:inbox:task.json");
      } finally {
        if (child && waitForExit && getStderr) {
          const exit = await killProcess(child, waitForExit, 4000);
          expect(exitedAcceptablyForResidentCleanup(exit)).toBe(true);
          const stderr = stripAnsi(getStderr());
          expect(stderr).not.toContain("Error:");
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "TC-TO-05: task-orchestrator serve updates GitHub issue status comments from activity events",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-orchestrator-bridge-"));
      let child: ChildProcessWithoutNullStreams | undefined;
      let waitForExit: (() => Promise<CliExit>) | undefined;
      let getStderr: (() => string) | undefined;
      try {
        const workflowDir = path.join(dir, "workflows");
        const mockBinDir = path.join(dir, "mock-bin");
        const bridgeDir = path.join(dir, "bridge-artifacts");
        await mkdir(workflowDir, { recursive: true });
        await mkdir(mockBinDir, { recursive: true });
        await mkdir(bridgeDir, { recursive: true });

        await writeFile(
          path.join(workflowDir, "task.yaml"),
          `
name: task-workflow
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "issue-team"
  members:
    lead:
      agent: lead_agent
      roles: [lead, publisher]
    reporter:
      agent: github_reporter
      roles: [publisher, github_reporter]
reporting:
  default_publisher: lead
  sinks:
    github:
      enabled: true
      publisher_member: reporter
      allowed_members: [reporter]
      allowed_roles: [publisher]
      events: [progress]
      projection: status_comment
      aggregate: latest
steps:
  implement:
    agent: lead_agent
    instructions: |
      for _ in $(seq 1 50); do
        if [[ -f reporter-progress.txt ]]; then
          break
        fi
        sleep 0.1
      done
      test -f reporter-progress.txt
      sleep 30
`,
        );

        await writeFile(
          path.join(workflowDir, "agents.yaml"),
          `
version: "1"
agents:
  lead_agent:
    worker: CUSTOM
    capabilities: [READ, RUN_COMMANDS]
  github_reporter:
    worker: CUSTOM
    capabilities: [READ, RUN_COMMANDS]
    base_instructions: |
      printf "%s\\n" "$ROBOPPI_AGENTS_MEMBER_ID" > reporter-progress.txt
      bun run --cwd "${REPO_ROOT}" src/cli.ts -- task-orchestrator activity emit \\
        --context "$ROBOPPI_TASK_CONTEXT_DIR" \\
        --kind progress \\
        --message "Started work on issue #12" \\
        --phase implement \\
        --member-id "$ROBOPPI_AGENTS_MEMBER_ID"
`,
        );

        await writeFile(
          path.join(dir, "task-orchestrator.yaml"),
          `
name: cli-task-orchestrator-bridge
version: "1"
runtime:
  poll_every: 1s
activity:
  github:
    enabled: true
state_dir: ./.roboppi-task
sources:
  github-main:
    type: github_issue
    repo: acme/widgets
    labels: [roboppi]
routes:
  issue-team:
    when:
      source: github_issue
      repository: acme/widgets
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
landing:
  mode: manual
`,
        );

        await writeFile(
          path.join(mockBinDir, "gh"),
          `#!/usr/bin/env bash
set -euo pipefail
ARTIFACT_DIR=${JSON.stringify(bridgeDir)}
if [[ "\${1:-}" != "api" ]]; then
  echo "fake gh only supports api" >&2
  exit 1
fi
shift
if [[ "\${1:-}" == "--paginate" ]]; then
  cat <<'EOF'
[[{"number":12,"html_url":"https://github.com/acme/widgets/issues/12","created_at":"2026-03-01T00:00:00Z","updated_at":"2026-03-02T00:00:00Z","title":"Fix flaky widget test"}]]
EOF
  exit 0
fi
if [[ "\${1:-}" == "repos/acme/widgets/issues/12" ]]; then
  cat <<'EOF'
{"number":12,"html_url":"https://github.com/acme/widgets/issues/12","title":"Fix flaky widget test","body":"Investigate","labels":[{"name":"bug"},{"name":"roboppi"}],"user":{"login":"octocat"},"created_at":"2026-03-01T00:00:00Z","updated_at":"2026-03-02T12:34:56Z","state":"open"}
EOF
  exit 0
fi
if [[ "\${1:-}" == "repos/acme/widgets/issues/12/comments?per_page=100" ]]; then
  cat <<'EOF'
[]
EOF
  exit 0
fi
if [[ "\${1:-}" == "-X" && "\${2:-}" == "POST" && "\${3:-}" == "repos/acme/widgets/issues/12/comments" && "\${4:-}" == "-f" ]]; then
  printf '%s\\n' "\${5#body=}" > "${bridgeDir}/status-comment.md"
  cat <<'EOF'
{"id":12345}
EOF
  exit 0
fi
if [[ "\${1:-}" == "-X" && "\${2:-}" == "PATCH" && "\${3:-}" == "repos/acme/widgets/issues/comments/12345" && "\${4:-}" == "-f" ]]; then
  printf '%s\\n' "\${5#body=}" > "${bridgeDir}/status-comment.md"
  cat <<'EOF'
{"id":12345}
EOF
  exit 0
fi
echo "unsupported gh api args: $*" >&2
exit 1
`,
          { mode: 0o755 },
        );

        const env = createCleanEnv({
          PATH: `${mockBinDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
        });
        const spawned = spawnCli(
          [
            "task-orchestrator",
            "serve",
            path.join(dir, "task-orchestrator.yaml"),
            "--direct",
            "--poll-every",
            "200ms",
          ],
          { env },
        );
        child = spawned.child;
        waitForExit = spawned.waitForExit;
        getStderr = spawned.getStderr;
        child.stdin.end();

        await waitForCondition(async () => {
          const text = await readFile(
            path.join(bridgeDir, "status-comment.md"),
            "utf-8",
          ).catch(() => "");
          return text.includes("Started work on issue #12");
        }, 20_000, 100);

        const statusComment = await readFile(
          path.join(bridgeDir, "status-comment.md"),
          "utf-8",
        );
        expect(statusComment).toContain("Roboppi issue status");
        expect(statusComment).toContain("Started work on issue #12");
        expect(statusComment).toContain("task_id=github:issue:acme/widgets#12");
        expect(statusComment).toContain("Publisher policy: `reporter`");
        expect(statusComment).toContain("Member: `reporter`");
      } finally {
        if (child && waitForExit && getStderr) {
          const exit = await killProcess(child, waitForExit, 4000);
          expect(exitedAcceptablyForResidentCleanup(exit)).toBe(true);
          expect(stripAnsi(getStderr())).not.toContain("Error:");
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "TC-TO-06: task-orchestrator serve bridges new GitHub operator comments into the lead inbox",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-orchestrator-operator-comment-"));
      let child: ChildProcessWithoutNullStreams | undefined;
      let waitForExit: (() => Promise<CliExit>) | undefined;
      let getStderr: (() => string) | undefined;
      try {
        const workflowDir = path.join(dir, "workflows");
        const mockBinDir = path.join(dir, "mock-bin");
        await mkdir(workflowDir, { recursive: true });
        await mkdir(mockBinDir, { recursive: true });

        const commentsPath = path.join(dir, "comments.json");
        await writeFile(commentsPath, "[]\n");

        await writeFile(
          path.join(workflowDir, "task.yaml"),
          `
name: operator-comment-workflow
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "issue-team"
  members:
    lead:
      agent: lead_agent
      roles: [lead]
steps:
  wait:
    agent: lead_agent
    instructions: |
      sleep 30
`,
        );

        await writeFile(
          path.join(workflowDir, "agents.yaml"),
          `
version: "1"
agents:
  lead_agent:
    worker: CUSTOM
    capabilities: [READ, RUN_COMMANDS, MAILBOX]
`,
        );

        await writeFile(
          path.join(dir, "task-orchestrator.yaml"),
          `
name: cli-task-orchestrator-operator-comment
version: "1"
runtime:
  poll_every: 1s
activity:
  github:
    enabled: true
state_dir: ./.roboppi-task
sources:
  github-main:
    type: github_issue
    repo: acme/widgets
    labels: [roboppi]
routes:
  issue-team:
    when:
      source: github_issue
      repository: acme/widgets
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
landing:
  mode: manual
`,
        );

        await writeFile(
          path.join(mockBinDir, "gh"),
          `#!/usr/bin/env bash
set -euo pipefail
COMMENTS_PATH=${JSON.stringify(commentsPath)}
if [[ "\${1:-}" != "api" ]]; then
  echo "fake gh only supports api" >&2
  exit 1
fi
shift
if [[ "\${1:-}" == "--paginate" ]]; then
  cat <<'EOF'
[[{"number":12,"html_url":"https://github.com/acme/widgets/issues/12","created_at":"2026-03-01T00:00:00Z","updated_at":"2026-03-02T00:00:00Z","title":"Clarify widget behavior"}]]
EOF
  exit 0
fi
if [[ "\${1:-}" == "repos/acme/widgets/issues/12" ]]; then
  cat <<'EOF'
{"number":12,"html_url":"https://github.com/acme/widgets/issues/12","title":"Clarify widget behavior","body":"Please update the widget docs","labels":[{"name":"bug"},{"name":"roboppi"}],"user":{"login":"octocat"},"created_at":"2026-03-01T00:00:00Z","updated_at":"2026-03-02T12:34:56Z","state":"open"}
EOF
  exit 0
fi
if [[ "\${1:-}" == "repos/acme/widgets/issues/12/comments?per_page=100" ]]; then
  cat "$COMMENTS_PATH"
  exit 0
fi
if [[ "\${1:-}" == "-X" && "\${2:-}" == "POST" && "\${3:-}" == "repos/acme/widgets/issues/12/comments" && "\${4:-}" == "-f" ]]; then
  cat <<'EOF'
{"id":12345}
EOF
  exit 0
fi
if [[ "\${1:-}" == "-X" && "\${2:-}" == "PATCH" && "\${3:-}" == "repos/acme/widgets/issues/comments/12345" && "\${4:-}" == "-f" ]]; then
  cat <<'EOF'
{"id":12345}
EOF
  exit 0
fi
echo "unsupported gh api args: $*" >&2
exit 1
`,
          { mode: 0o755 },
        );

        const env = createCleanEnv({
          PATH: `${mockBinDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
        });
        const spawned = spawnCli(
          [
            "task-orchestrator",
            "serve",
            path.join(dir, "task-orchestrator.yaml"),
            "--direct",
            "--poll-every",
            "200ms",
          ],
          { env },
        );
        child = spawned.child;
        waitForExit = spawned.waitForExit;
        getStderr = spawned.getStderr;
        child.stdin.end();

        const taskId = "github:issue:acme/widgets#12";
        const taskDir = path.join(
          dir,
          ".roboppi-task",
          "tasks",
          encodeURIComponent(taskId),
        );

        await waitForCondition(async () => {
          const stateText = await readFile(path.join(taskDir, "state.json"), "utf-8").catch(() => "");
          if (!stateText) return false;
          const state = JSON.parse(stateText) as { active_run_id?: string | null };
          return typeof state.active_run_id === "string" && state.active_run_id.length > 0;
        }, 20_000, 100);

        await writeFile(
          commentsPath,
          JSON.stringify([
            {
              id: 9001,
              body: "Please also document the failure mode.",
              html_url: "https://github.com/acme/widgets/issues/12#issuecomment-9001",
              created_at: "2026-03-10T01:00:00Z",
              updated_at: "2026-03-10T01:00:00Z",
              author_association: "OWNER",
              user: { login: "octocat" },
            },
          ]) + "\n",
        );

        const getInboxSummary = async (): Promise<{
          entries?: Array<{ topic?: string; mailbox_path?: string }>;
        } | null> => {
          const stateText = await readFile(path.join(taskDir, "state.json"), "utf-8").catch(() => "");
          if (!stateText) return null;
          const state = JSON.parse(stateText) as { active_run_id?: string | null; latest_run_id?: string | null };
          const runId = typeof state.active_run_id === "string" && state.active_run_id
            ? state.active_run_id
            : state.latest_run_id;
          if (!runId) return null;
          const summaryPath = path.join(
            taskDir,
            "runs",
            encodeURIComponent(runId),
            "context",
            "_agents",
            "inbox-summary.json",
          );
          const text = await readFile(summaryPath, "utf-8").catch(() => "");
          if (!text) return null;
          return JSON.parse(text) as {
            entries?: Array<{ topic?: string; mailbox_path?: string }>;
          };
        };

        await waitForCondition(async () => {
          const summary = await getInboxSummary();
          return Boolean(summary?.entries?.some((entry) => entry.topic === "operator_comment"));
        }, 20_000, 100);

        const summary = await getInboxSummary();
        const operatorEntries = (summary?.entries ?? []).filter(
          (entry) => entry.topic === "operator_comment",
        );
        expect(operatorEntries).toHaveLength(1);
        expect(operatorEntries[0]?.mailbox_path).toContain("_agents/mailbox/inbox/lead/cur/");

        await new Promise((resolve) => setTimeout(resolve, 750));
        const summaryAfterSecondPoll = await getInboxSummary();
        const operatorEntriesAfterSecondPoll = (summaryAfterSecondPoll?.entries ?? []).filter(
          (entry) => entry.topic === "operator_comment",
        );
        expect(operatorEntriesAfterSecondPoll).toHaveLength(1);
      } finally {
        if (child && waitForExit && getStderr) {
          const exit = await killProcess(child, waitForExit, 4000);
          expect(exitedAcceptablyForResidentCleanup(exit)).toBe(true);
          expect(stripAnsi(getStderr())).not.toContain("Error:");
        }
        await rm(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it(
    "TC-TO-07: task-orchestrator serve resumes a clarification flow after an operator comment",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cli-e2e-task-orchestrator-clarification-resume-"));
      let child: ChildProcessWithoutNullStreams | undefined;
      let waitForExit: (() => Promise<CliExit>) | undefined;
      let getStderr: (() => string) | undefined;
      try {
        const workflowDir = path.join(dir, "workflows");
        const mockBinDir = path.join(dir, "mock-bin");
        await mkdir(workflowDir, { recursive: true });
        await mkdir(mockBinDir, { recursive: true });

        const commentsPath = path.join(dir, "comments.json");
        const prCreatePath = path.join(dir, "pr-create.txt");
        const clarificationCommentPath = path.join(dir, "clarification-comment.md");
        await writeFile(commentsPath, "[]\n");

        await writeFile(
          path.join(workflowDir, "task.yaml"),
          `
name: clarification-resume-workflow
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "issue-team"
  members:
    lead:
      agent: lead_agent
      roles: [lead]
reporting:
  default_publisher: lead
  sinks:
    github:
      enabled: true
      publisher_member: lead
      allowed_members: [lead]
      allowed_roles: [lead]
      events: [progress, waiting_for_input, review_required]
      projection: status_comment
      aggregate: latest
task_policy:
  intents:
    activity:
      allowed_members: [lead]
      allowed_roles: [lead]
    clarification_request:
      allowed_members: [lead]
      allowed_roles: [lead]
    pr_open_request:
      allowed_members: [lead]
      allowed_roles: [lead]
steps:
  orchestrate:
    agent: lead_agent
    instructions: |
      set -euo pipefail
      sleep 3
      SUMMARY="$ROBOPPI_TASK_CONTEXT_DIR/_agents/inbox-summary.json"
      if [[ -f "$SUMMARY" ]] && grep -q '"topic": "operator_comment"' "$SUMMARY"; then
        bun run --cwd "${REPO_ROOT}" src/cli.ts -- task-orchestrator activity emit \\
          --context "$ROBOPPI_TASK_CONTEXT_DIR" \\
          --kind progress \\
          --message "Clarification received from the operator" \\
          --phase implement \\
          --member-id "$ROBOPPI_AGENTS_MEMBER_ID"
        bun run --cwd "${REPO_ROOT}" src/cli.ts -- task-orchestrator intent emit \\
          --context "$ROBOPPI_TASK_CONTEXT_DIR" \\
          --kind pr_open_request \\
          --payload-json '{"title":"Fix issue #12: clarified widget behavior","body":"Closes #12","head_ref":"roboppi/issue-12-clarified","base_ref":"main","labels":["roboppi-live-e2e-pr"]}' \\
          --member-id "$ROBOPPI_AGENTS_MEMBER_ID"
      else
        bun run --cwd "${REPO_ROOT}" src/cli.ts -- task-orchestrator activity emit \\
          --context "$ROBOPPI_TASK_CONTEXT_DIR" \\
          --kind waiting_for_input \\
          --message "Waiting for clarification from the issue author" \\
          --phase implement \\
          --member-id "$ROBOPPI_AGENTS_MEMBER_ID"
        bun run --cwd "${REPO_ROOT}" src/cli.ts -- task-orchestrator intent emit \\
          --context "$ROBOPPI_TASK_CONTEXT_DIR" \\
          --kind clarification_request \\
          --payload-json '{"summary":"Need clarification before implementation can proceed","questions":["What exact widget behavior should be documented?"],"resume_hints":["Reply on this issue with the expected behavior"]}' \\
          --member-id "$ROBOPPI_AGENTS_MEMBER_ID"
      fi
    completion_check:
      worker: CUSTOM
      instructions: |
        test -f "$ROBOPPI_TASK_CONTEXT_DIR/_task/pr-open-request.json" || \\
          test -f "$ROBOPPI_TASK_CONTEXT_DIR/_task/clarification-request.json"
      capabilities: [READ, RUN_COMMANDS]
      timeout: "10s"
    max_iterations: 5

  apply-pr-open:
    worker: CUSTOM
    depends_on: [orchestrate]
    instructions: |
      set -euo pipefail
      if [[ ! -f "$ROBOPPI_TASK_CONTEXT_DIR/_task/pr-open-request.json" ]]; then
        exit 0
      fi
      bun run --cwd "${REPO_ROOT}" src/cli.ts -- task-orchestrator github apply-pr-open \\
        --context "$ROBOPPI_TASK_CONTEXT_DIR"
    capabilities: [READ, RUN_COMMANDS]
    timeout: "1m"
`,
        );

        await writeFile(
          path.join(workflowDir, "agents.yaml"),
          `
version: "1"
agents:
  lead_agent:
    worker: CUSTOM
    capabilities: [READ, RUN_COMMANDS, MAILBOX]
`,
        );

        await writeFile(
          path.join(dir, "task-orchestrator.yaml"),
          `
name: cli-task-orchestrator-clarification-resume
version: "1"
runtime:
  poll_every: 1s
activity:
  github:
    enabled: true
state_dir: ./.roboppi-task
sources:
  github-main:
    type: github_issue
    repo: acme/widgets
    labels: [roboppi]
routes:
  issue-team:
    when:
      source: github_issue
      repository: acme/widgets
      labels_any: [bug]
    workflow: workflows/task.yaml
    agents_files:
      - workflows/agents.yaml
    workspace_mode: shared
landing:
  mode: manual
`,
        );

        await writeFile(
          path.join(mockBinDir, "gh"),
          `#!/usr/bin/env bash
set -euo pipefail
COMMENTS_PATH=${JSON.stringify(commentsPath)}
PR_CREATE_PATH=${JSON.stringify(prCreatePath)}
CLARIFICATION_COMMENT_PATH=${JSON.stringify(clarificationCommentPath)}
if [[ "\${1:-}" == "api" ]]; then
  shift
  if [[ "\${1:-}" == "--paginate" ]]; then
    cat <<'EOF'
[[{"number":12,"html_url":"https://github.com/acme/widgets/issues/12","created_at":"2026-03-01T00:00:00Z","updated_at":"2026-03-02T00:00:00Z","title":"Clarify widget behavior"}]]
EOF
    exit 0
  fi
  if [[ "\${1:-}" == "repos/acme/widgets/issues/12" ]]; then
    cat <<'EOF'
{"number":12,"html_url":"https://github.com/acme/widgets/issues/12","title":"Clarify widget behavior","body":"Document the widget behavior, but the expected behavior is missing.","labels":[{"name":"bug"},{"name":"roboppi"}],"user":{"login":"octocat"},"created_at":"2026-03-01T00:00:00Z","updated_at":"2026-03-02T12:34:56Z","state":"open"}
EOF
    exit 0
  fi
  if [[ "\${1:-}" == "repos/acme/widgets/issues/12/comments?per_page=100" ]]; then
    cat "$COMMENTS_PATH"
    exit 0
  fi
  if [[ "\${1:-}" == "-X" && "\${2:-}" == "POST" && "\${3:-}" == "repos/acme/widgets/issues/12/comments" && "\${4:-}" == "-f" ]]; then
    BODY="\${5#body=}"
    if [[ "$BODY" == *"<!-- roboppi:clarification-request"* ]]; then
      printf '%s\\n' "$BODY" > "$CLARIFICATION_COMMENT_PATH"
      cat <<'EOF'
{"id":12346}
EOF
    else
      cat <<'EOF'
{"id":12345}
EOF
    fi
    exit 0
  fi
  if [[ "\${1:-}" == "-X" && "\${2:-}" == "PATCH" && "\${3:-}" == "repos/acme/widgets/issues/comments/12345" && "\${4:-}" == "-f" ]]; then
    cat <<'EOF'
{"id":12345}
EOF
    exit 0
  fi
  if [[ "\${1:-}" == "-X" && "\${2:-}" == "PATCH" && "\${3:-}" == "repos/acme/widgets/issues/comments/12346" && "\${4:-}" == "-f" ]]; then
    BODY="\${5#body=}"
    printf '%s\\n' "$BODY" > "$CLARIFICATION_COMMENT_PATH"
    cat <<'EOF'
{"id":12346}
EOF
    exit 0
  fi
  echo "unsupported gh api args: $*" >&2
  exit 1
fi
if [[ "\${1:-}" == "pr" && "\${2:-}" == "create" ]]; then
  printf '%s\\n' "$*" > "$PR_CREATE_PATH"
  echo "https://github.com/acme/widgets/pull/34"
  exit 0
fi
echo "unsupported gh args: $*" >&2
exit 1
`,
          { mode: 0o755 },
        );

        const env = createCleanEnv({
          PATH: `${mockBinDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
        });
        const spawned = spawnCli(
          [
            "task-orchestrator",
            "serve",
            path.join(dir, "task-orchestrator.yaml"),
            "--direct",
            "--poll-every",
            "200ms",
          ],
          { env },
        );
        child = spawned.child;
        waitForExit = spawned.waitForExit;
        getStderr = spawned.getStderr;
        child.stdin.end();

        const taskId = "github:issue:acme/widgets#12";
        const taskDir = path.join(
          dir,
          ".roboppi-task",
          "tasks",
          encodeURIComponent(taskId),
        );

        const readTaskState = async (): Promise<{
          lifecycle?: string;
          latest_run_id?: string | null;
          active_run_id?: string | null;
        } | null> => {
          const text = await readFile(path.join(taskDir, "state.json"), "utf-8").catch(() => "");
          if (!text) return null;
          return JSON.parse(text) as {
            lifecycle?: string;
            latest_run_id?: string | null;
            active_run_id?: string | null;
          };
        };

        await waitForCondition(async () => {
          const state = await readTaskState();
          return state?.lifecycle === "waiting_for_input";
        }, 20_000, 100);

        const waitingState = await readTaskState();
        const waitingRunId = waitingState?.latest_run_id;
        expect(waitingRunId).toBeTruthy();
        const clarificationComment = await readFile(clarificationCommentPath, "utf-8");
        expect(clarificationComment).toContain("Need clarification before implementation can proceed");

        await writeFile(
          commentsPath,
          JSON.stringify([
            {
              id: 9001,
              body: "The expected behavior is: document that widgets fail closed when config is missing.",
              html_url: "https://github.com/acme/widgets/issues/12#issuecomment-9001",
              created_at: "2026-03-10T01:00:00Z",
              updated_at: "2026-03-10T01:00:00Z",
              author_association: "OWNER",
              user: { login: "octocat" },
            },
          ]) + "\n",
        );

        await waitForCondition(async () => {
          const state = await readTaskState();
          return state?.lifecycle === "review_required" && state.latest_run_id !== waitingRunId;
        }, 30_000, 100);

        const resumedState = await readTaskState();
        const resumedRunId = resumedState?.latest_run_id;
        expect(resumedRunId).toBeTruthy();
        const prOpenResultText = await readFile(
          path.join(
            taskDir,
            "runs",
            encodeURIComponent(resumedRunId!),
            "context",
            "_task",
            "pr-open-result.json",
          ),
          "utf-8",
        );
        expect(prOpenResultText).toContain('"landing_lifecycle": "review_required"');
        expect(prOpenResultText).toContain("https://github.com/acme/widgets/pull/34");

        const inboxSummaryText = await readFile(
          path.join(
            taskDir,
            "runs",
            encodeURIComponent(resumedRunId!),
            "context",
            "_agents",
            "inbox-summary.json",
          ),
          "utf-8",
        );
        expect(inboxSummaryText).toContain('"topic": "operator_comment"');

        const prCreateText = await readFile(prCreatePath, "utf-8");
        expect(prCreateText).toContain("pr create");
        expect(prCreateText).toContain("--head roboppi/issue-12-clarified");
      } finally {
        if (child && waitForExit && getStderr) {
          const exit = await killProcess(child, waitForExit, 4000);
          expect(exitedAcceptablyForResidentCleanup(exit)).toBe(true);
          expect(stripAnsi(getStderr())).not.toContain("Error:");
        }
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
      if (!(await supportsChildBunStdinPipe())) {
        return;
      }

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
