/**
 * Agents CLI E2E/AT tests.
 *
 * Spawns real CLI processes to test `roboppi agents ...` roundtrip.
 * Asserts JSON-only stdout contract.
 *
 * Covers design §11.3.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = process.cwd();
const TEST_TMP_ROOT = path.join(REPO_ROOT, ".roboppi-loop", "tmp", "at-agents-cli");

type CliResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function createCleanEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
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
    "ROBOPPI_AGENTS_CONTEXT_DIR",
    "ROBOPPI_AGENTS_MEMBER_ID",
    "ROBOPPI_AGENTS_TEAM_ID",
  ]) {
    delete env[key];
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  return env;
}

const CLI_TIMEOUT_MS = 45_000; // hard timeout — must be lower than AT_TIMEOUT so the test runner doesn't race the harness kill

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`;
}

async function runAgentsCli(args: string[], env?: NodeJS.ProcessEnv, stdinData?: string): Promise<CliResult> {
  const stdinDir = stdinData !== undefined
    ? await mkdtemp(path.join(tmpdir(), "roboppi-agents-stdin-"))
    : null;
  const stdinPath = stdinDir ? path.join(stdinDir, "input.json") : null;
  if (stdinPath) {
    await writeFile(stdinPath, stdinData ?? "", "utf8");
  }

  const runOnce = (): Promise<CliResult> => new Promise<CliResult>((resolve) => {
    const command = [
      "exec",
      shellQuote(process.execPath),
      "run",
      "src/cli.ts",
      "--",
      "agents",
      ...args.map(shellQuote),
    ].join(" ");
    const child = spawn(
      "bash",
      [
        "-lc",
        stdinPath ? `${command} < ${shellQuote(stdinPath)}` : command,
      ],
      {
        cwd: REPO_ROOT,
        env: env ?? createCleanEnv(),
        // Always route through `bash -lc exec ...` because Bun 1.3.8 can
        // intermittently hang when a `bun run ...` process is spawned directly
        // under this AT harness on CI.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 1, signal: null, stdout, stderr: stderr + `\n[spawn error] ${err.message}` });
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      const graceTimer = setTimeout(() => {
        resolve({
          code: null,
          signal: "SIGKILL" as NodeJS.Signals,
          stdout,
          stderr: stderr + `\n[test harness] Process killed after ${CLI_TIMEOUT_MS}ms timeout (grace expired)`,
        });
      }, 3_000);
      child.once("close", (code, signal) => {
        clearTimeout(graceTimer);
        resolve({
          code,
          signal: signal ?? ("SIGKILL" as NodeJS.Signals),
          stdout,
          stderr: stderr + `\n[test harness] Process killed after ${CLI_TIMEOUT_MS}ms timeout`,
        });
      });
    }, CLI_TIMEOUT_MS);
  });

  try {
    let lastResult: CliResult | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await runOnce();
      lastResult = result;
      const timedOutWithoutOutput =
        result.signal === "SIGKILL"
        && result.stdout.trim() === ""
        && result.stderr.includes(`[test harness] Process killed after ${CLI_TIMEOUT_MS}ms timeout`);
      if (!timedOutWithoutOutput || attempt === 2) {
        return result;
      }
    }
    return lastResult!;
  } finally {
    await rm(stdinDir ?? "", { recursive: true, force: true });
  }
}

function parseJsonStdout(result: CliResult): any {
  const trimmed = result.stdout.trim();
  if (!trimmed) {
    throw new Error(
      `Expected JSON stdout but got empty. exit=${result.code} signal=${result.signal}\nstderr: ${result.stderr}`,
    );
  }
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new Error(
      `Failed to parse stdout as JSON: ${(e as Error).message}\nstdout: ${trimmed}\nstderr: ${result.stderr}`,
    );
  }
}

let contextDir: string;

beforeEach(async () => {
  await mkdir(TEST_TMP_ROOT, { recursive: true });
  contextDir = await mkdtemp(path.join(TEST_TMP_ROOT, "agents-cli-at-"));
});

afterEach(async () => {
  await rm(contextDir, { recursive: true, force: true });
});

// AT tests spawn real CLI processes — each process startup takes 1-3s due to
// heavy module loading.  Set generous per-test timeouts to avoid flaky failures.
const AT_TIMEOUT = 60_000;

describe("roboppi agents CLI roundtrip", () => {
  it("init + members list", async () => {
    // Init with flag-only (json-stdin requires piped stdin, skip here)
    const initResult2 = await runAgentsCli([
      "init",
      "--context", contextDir,
      "--team", "test-team",
    ]);

    const initJson = parseJsonStdout(initResult2);
    expect(initJson.ok).toBe(true);
    expect(initJson.team_id).toBeTruthy();

    // Members list
    const listResult = await runAgentsCli([
      "members", "list",
      "--context", contextDir,
    ]);
    const listJson = parseJsonStdout(listResult);
    expect(listJson.ok).toBe(true);
    expect(listJson.team_name).toBe("test-team");
    expect(Array.isArray(listJson.members)).toBe(true);
    expect(listJson.members.length).toBeGreaterThanOrEqual(1);
  }, AT_TIMEOUT);

  it("message send + recv + ack roundtrip", async () => {
    // First init with multiple members via json-stdin
    // Use flag-only init (simpler for testing)
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    // We need to add another member. Re-init with full setup using pipe.
    // Actually, the default init creates only the lead. Let's use the store directly
    // to set up the context, then test the CLI operations.

    // For this test, use env-based member identity
    const env = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    // Send a message (lead -> lead, since we only have one member)
    const sendResult = await runAgentsCli([
      "message", "send",
      "--context", contextDir,
      "--from", "lead",
      "--to", "lead",
      "--topic", "test-topic",
      "--body", "hello from test",
    ], env);
    const sendJson = parseJsonStdout(sendResult);
    expect(sendJson.ok).toBe(true);
    expect(sendJson.message_id).toBeTruthy();

    // Recv with claim
    const recvResult = await runAgentsCli([
      "message", "recv",
      "--context", contextDir,
      "--for", "lead",
      "--claim",
    ], env);
    const recvJson = parseJsonStdout(recvResult);
    expect(recvJson.ok).toBe(true);
    expect(recvJson.messages.length).toBe(1);
    expect(recvJson.messages[0].topic).toBe("test-topic");
    expect(recvJson.messages[0].claim).toBeTruthy();
    expect(recvJson.messages[0].claim.token).toBeTruthy();

    // Ack by claim token
    const ackResult = await runAgentsCli([
      "message", "ack",
      "--context", contextDir,
      "--for", "lead",
      "--claim-token", recvJson.messages[0].claim.token,
    ], env);
    const ackJson = parseJsonStdout(ackResult);
    expect(ackJson.ok).toBe(true);

    // Recv again should be empty
    const recv2Result = await runAgentsCli([
      "message", "recv",
      "--context", contextDir,
      "--for", "lead",
    ], env);
    const recv2Json = parseJsonStdout(recv2Result);
    expect(recv2Json.ok).toBe(true);
    expect(recv2Json.messages.length).toBe(0);
  }, AT_TIMEOUT);

  it("status set + get roundtrip", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const env = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const setResult = await runAgentsCli([
      "status", "set",
      "--context", contextDir,
      "--summary", "Implementer is addressing the current blocker.",
      "--blocker", "manual verification missing",
      "--next", "wait for implementer patch",
      "--next", "rerun tester",
    ], env);
    const setJson = parseJsonStdout(setResult);
    expect(setJson.ok).toBe(true);
    expect(setJson.status.owner_member_id).toBe("lead");
    expect(setJson.status.summary).toBe("Implementer is addressing the current blocker.");
    expect(setJson.status.blockers).toEqual(["manual verification missing"]);
    expect(setJson.status.next_actions).toEqual(["wait for implementer patch", "rerun tester"]);

    const getResult = await runAgentsCli([
      "status", "get",
      "--context", contextDir,
    ], env);
    const getJson = parseJsonStdout(getResult);
    expect(getJson.ok).toBe(true);
    expect(getJson.status.summary).toBe("Implementer is addressing the current blocker.");
    expect(getJson.status.owner_member_id).toBe("lead");
  }, AT_TIMEOUT);

  it("message reply sends to original sender and acks the claimed message", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const leadEnv = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    // Add a second member (alice)
    const upsertResult = await runAgentsCli([
      "members", "upsert",
      "--context", contextDir,
      "--member", "alice",
      "--agent", "alice-agent",
      "--name", "Alice",
      "--role", "worker",
    ], leadEnv);
    expect(parseJsonStdout(upsertResult).ok).toBe(true);

    // Send lead -> alice
    const sendResult = await runAgentsCli([
      "message", "send",
      "--context", contextDir,
      "--from", "lead",
      "--to", "alice",
      "--topic", "ping",
      "--body", "hello",
    ], leadEnv);
    expect(parseJsonStdout(sendResult).ok).toBe(true);

    // Alice claims the message
    const aliceEnv = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "alice",
    });
    const recvResult = await runAgentsCli([
      "message", "recv",
      "--context", contextDir,
      "--for", "alice",
      "--claim",
      "--max", "1",
    ], aliceEnv);
    const recvJson = parseJsonStdout(recvResult);
    expect(recvJson.ok).toBe(true);
    expect(recvJson.messages.length).toBe(1);
    const token = recvJson.messages[0].claim.token as string;
    expect(token).toBeTruthy();

    // Alice replies (this should also ack the claimed message)
    const replyResult = await runAgentsCli([
      "message", "reply",
      "--context", contextDir,
      "--for", "alice",
      "--claim-token", token,
      "--topic", "chat",
      "--body", "ack",
    ], aliceEnv);
    const replyJson = parseJsonStdout(replyResult);
    expect(replyJson.ok).toBe(true);
    expect(replyJson.acked).toBe(true);
    expect(replyJson.delivered).toEqual(["lead"]);

    // Lead receives the reply
    const leadRecv = await runAgentsCli([
      "message", "recv",
      "--context", contextDir,
      "--for", "lead",
      "--max", "10",
    ], leadEnv);
    const leadRecvJson = parseJsonStdout(leadRecv);
    expect(leadRecvJson.ok).toBe(true);
    expect(leadRecvJson.messages.some((m: any) => m.from === "alice" && m.body === "ack")).toBe(true);

    // The original claimed message should already be acked by reply (ack again should fail)
    const ackAgain = await runAgentsCli([
      "message", "ack",
      "--context", contextDir,
      "--for", "alice",
      "--claim-token", token,
    ], aliceEnv);
    expect(ackAgain.code).not.toBe(0);
    expect(parseJsonStdout(ackAgain).ok).toBe(false);
  }, AT_TIMEOUT);

  it("tasks add + list + claim + complete roundtrip", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const env = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    // Add task
    const addResult = await runAgentsCli([
      "tasks", "add",
      "--context", contextDir,
      "--title", "Test Task",
      "--description", "Do the thing",
    ], env);
    const addJson = parseJsonStdout(addResult);
    expect(addJson.ok).toBe(true);
    expect(addJson.task_id).toBeTruthy();

    const taskId = addJson.task_id;

    // List tasks
    const listResult = await runAgentsCli([
      "tasks", "list",
      "--context", contextDir,
    ], env);
    const listJson = parseJsonStdout(listResult);
    expect(listJson.ok).toBe(true);
    expect(listJson.tasks.length).toBe(1);
    expect(listJson.tasks[0].task_id).toBe(taskId);
    expect(listJson.tasks[0].status).toBe("pending");

    // Claim task
    const claimResult = await runAgentsCli([
      "tasks", "claim",
      "--context", contextDir,
      "--task-id", taskId,
      "--member", "lead",
    ], env);
    const claimJson = parseJsonStdout(claimResult);
    expect(claimJson.ok).toBe(true);
    expect(claimJson.task.title).toBe("Test Task");
    expect(claimJson.task.description).toBe("Do the thing");
    expect(claimJson.task.status).toBe("in_progress");

    // List in_progress
    const ipResult = await runAgentsCli([
      "tasks", "list",
      "--context", contextDir,
      "--status", "in_progress",
    ], env);
    const ipJson = parseJsonStdout(ipResult);
    expect(ipJson.ok).toBe(true);
    expect(ipJson.tasks.length).toBe(1);

    // Complete task
    const completeResult = await runAgentsCli([
      "tasks", "complete",
      "--context", contextDir,
      "--task-id", taskId,
      "--member", "lead",
    ], env);
    const completeJson = parseJsonStdout(completeResult);
    expect(completeJson.ok).toBe(true);

    // List completed
    const doneResult = await runAgentsCli([
      "tasks", "list",
      "--context", contextDir,
      "--status", "completed",
    ], env);
    const doneJson = parseJsonStdout(doneResult);
    expect(doneJson.ok).toBe(true);
    expect(doneJson.tasks.length).toBe(1);
  }, AT_TIMEOUT);

  it("tasks show returns the full task description", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const env = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const addResult = await runAgentsCli([
      "tasks", "add",
      "--context", contextDir,
      "--title", "Detailed task",
      "--description", "full task body for resident agent execution",
    ], env);
    const addJson = parseJsonStdout(addResult);
    expect(addJson.ok).toBe(true);

    const showResult = await runAgentsCli([
      "tasks", "show",
      "--context", contextDir,
      "--task-id", addJson.task_id,
    ], env);
    const showJson = parseJsonStdout(showResult);
    expect(showJson.ok).toBe(true);
    expect(showJson.task.title).toBe("Detailed task");
    expect(showJson.task.description).toBe("full task body for resident agent execution");
    expect(showJson.task.status).toBe("pending");
  }, AT_TIMEOUT);

  it("tasks supersede roundtrip", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const env = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const addResult = await runAgentsCli([
      "tasks", "add",
      "--context", contextDir,
      "--title", "Supersede CLI Task",
      "--description", "Replace me",
    ], env);
    const addJson = parseJsonStdout(addResult);
    expect(addJson.ok).toBe(true);

    const taskId = addJson.task_id;
    const supersedeResult = await runAgentsCli([
      "tasks", "supersede",
      "--context", contextDir,
      "--task-id", taskId,
      "--member", "lead",
      "--reason", "stale contract",
      "--replacement-task-id", "replacement-task",
    ], env);
    const supersedeJson = parseJsonStdout(supersedeResult);
    expect(supersedeJson.ok).toBe(true);

    const listResult = await runAgentsCli([
      "tasks", "list",
      "--context", contextDir,
      "--status", "superseded",
    ], env);
    const listJson = parseJsonStdout(listResult);
    expect(listJson.ok).toBe(true);
    expect(listJson.tasks.length).toBe(1);
    expect(listJson.tasks[0].task_id).toBe(taskId);
    expect(listJson.tasks[0].status).toBe("superseded");
  }, AT_TIMEOUT);

  it("housekeep returns JSON", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const result = await runAgentsCli([
      "housekeep",
      "--context", contextDir,
    ]);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(true);
    expect(typeof json.requeued).toBe("number");
    expect(typeof json.dead_lettered).toBe("number");
    expect(Array.isArray(json.warnings)).toBe(true);
  }, AT_TIMEOUT);

  it("--help outputs help text to stderr (not stdout)", async () => {
    const result = await runAgentsCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("roboppi agents");
    // stdout should be empty (JSON-only contract)
    expect(result.stdout.trim()).toBe("");
  }, AT_TIMEOUT);

  it("tasks add --assigned-to unknown member returns error", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const result = await runAgentsCli([
      "tasks", "add",
      "--context", contextDir,
      "--title", "Some task",
      "--assigned-to", "nonexistent-member",
    ]);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toBeTruthy();
  }, AT_TIMEOUT);

  it("tasks claim rejects claiming a task assigned to another member", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);
    const leadEnv = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const upsertResult = await runAgentsCli([
      "members", "upsert",
      "--context", contextDir,
      "--member", "manual_verifier",
      "--agent", "manual-verifier-agent",
    ], leadEnv);
    expect(parseJsonStdout(upsertResult).ok).toBe(true);

    const addResult = await runAgentsCli([
      "tasks", "add",
      "--context", contextDir,
      "--title", "Manual preflight",
      "--description", "Run manual verification",
      "--assigned-to", "manual_verifier",
    ], leadEnv);
    const addJson = parseJsonStdout(addResult);
    expect(addJson.ok).toBe(true);

    const claimResult = await runAgentsCli([
      "tasks", "claim",
      "--context", contextDir,
      "--task-id", addJson.task_id,
      "--member", "lead",
    ], leadEnv);
    const claimJson = parseJsonStdout(claimResult);
    expect(claimJson.ok).toBe(false);
    expect(claimJson.error).toContain('assigned to "manual_verifier"');
  }, AT_TIMEOUT);

  it("tasks claim rejects member spoofing when caller identity is set", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);
    const leadEnv = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const upsertResult = await runAgentsCli([
      "members", "upsert",
      "--context", contextDir,
      "--member", "manual_verifier",
      "--agent", "manual-verifier-agent",
    ], leadEnv);
    expect(parseJsonStdout(upsertResult).ok).toBe(true);

    const addResult = await runAgentsCli([
      "tasks", "add",
      "--context", contextDir,
      "--title", "Manual preflight",
      "--description", "Run manual verification",
    ], leadEnv);
    const addJson = parseJsonStdout(addResult);
    expect(addJson.ok).toBe(true);

    const claimResult = await runAgentsCli([
      "tasks", "claim",
      "--context", contextDir,
      "--task-id", addJson.task_id,
      "--member", "manual_verifier",
    ], leadEnv);
    const claimJson = parseJsonStdout(claimResult);
    expect(claimJson.ok).toBe(false);
    expect(claimJson.error).toContain('does not match caller "lead"');
  }, AT_TIMEOUT);

  it("all stdout output is valid JSON", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    // Run several commands and verify stdout is always JSON
    const commands = [
      ["members", "list", "--context", contextDir],
      ["tasks", "list", "--context", contextDir],
      ["housekeep", "--context", contextDir],
    ];

    for (const cmd of commands) {
      const result = await runAgentsCli(cmd);
      if (result.stdout.trim()) {
        expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
      }
    }
  }, AT_TIMEOUT);

  // -----------------------------------------------------------------------
  // Spec 3.1: message recv --wait-ms
  // -----------------------------------------------------------------------

  it("message recv --wait-ms 0 is non-blocking (returns immediately)", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);
    const env = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const start = Date.now();
    const result = await runAgentsCli([
      "message", "recv",
      "--context", contextDir,
      "--for", "lead",
      "--wait-ms", "0",
    ], env);
    const elapsed = Date.now() - start;

    const json = parseJsonStdout(result);
    expect(json.ok).toBe(true);
    expect(json.messages).toEqual([]);
    // --wait-ms 0 should return near-instantly (allow generous margin for process startup)
    expect(elapsed).toBeLessThan(5000);
  }, AT_TIMEOUT);

  it("message recv --wait-ms timeout returns empty messages", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);
    const env = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const result = await runAgentsCli([
      "message", "recv",
      "--context", contextDir,
      "--for", "lead",
      "--wait-ms", "500",
    ], env);

    const json = parseJsonStdout(result);
    expect(result.code).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.messages).toEqual([]);
  }, AT_TIMEOUT);

  it("message recv --wait-ms returns before timeout when message arrives", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);
    const env = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    // Start a long-wait recv in background
    const recvPromise = runAgentsCli([
      "message", "recv",
      "--context", contextDir,
      "--for", "lead",
      "--wait-ms", "10000",
    ], env);

    // After a short delay, send a message
    await new Promise<void>((r) => setTimeout(r, 500));
    const sendResult = await runAgentsCli([
      "message", "send",
      "--context", contextDir,
      "--from", "lead",
      "--to", "lead",
      "--topic", "wake-up",
      "--body", "hello",
    ], env);
    expect(parseJsonStdout(sendResult).ok).toBe(true);

    const recvResult = await recvPromise;
    const json = parseJsonStdout(recvResult);
    expect(json.ok).toBe(true);
    expect(json.messages.length).toBeGreaterThanOrEqual(1);
    expect(json.messages[0].topic).toBe("wake-up");
  }, AT_TIMEOUT);

  // -----------------------------------------------------------------------
  // Spec 3.4: JSON-safe CLI failures
  // -----------------------------------------------------------------------

  it("unknown subcommand returns JSON error + non-zero exit", async () => {
    const result = await runAgentsCli(["wat"]);
    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toBeTruthy();
  }, 15_000);

  it("missing required flag returns JSON error + non-zero exit", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);
    // message send without --topic
    const result = await runAgentsCli([
      "message", "send",
      "--context", contextDir,
      "--from", "lead",
      "--to", "lead",
      "--body", "no topic",
    ]);
    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toBeTruthy();
  }, AT_TIMEOUT);

  it("semantic failure (ack nonexistent) returns JSON error + non-zero exit", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);
    const env = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const result = await runAgentsCli([
      "message", "ack",
      "--context", contextDir,
      "--for", "lead",
      "--message-id", "00000000-0000-0000-0000-000000000000",
    ], env);
    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toBeTruthy();
  }, AT_TIMEOUT);

  // -----------------------------------------------------------------------
  // Spec 3.5: Path safety — traversal-like member IDs
  // -----------------------------------------------------------------------

  it("traversal-like member id (--to ../x) is rejected with JSON error", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);
    const env = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const result = await runAgentsCli([
      "message", "send",
      "--context", contextDir,
      "--from", "lead",
      "--to", "../x",
      "--topic", "test",
      "--body", "test",
    ], env);
    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("path");
  }, AT_TIMEOUT);

  it("traversal-like member id (--from ../../etc) is rejected with JSON error", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const result = await runAgentsCli([
      "message", "send",
      "--context", contextDir,
      "--from", "../../etc",
      "--to", "lead",
      "--topic", "test",
      "--body", "test",
    ]);
    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("path");
  }, AT_TIMEOUT);

  // -----------------------------------------------------------------------
  // Spec 3.5: Symlink escape prevention
  // -----------------------------------------------------------------------

  it("symlink _agents pointing outside context dir is rejected", async () => {
    // Create a context dir where _agents are a symlink to an outside directory
    const outsideDir = await mkdtemp(path.join(TEST_TMP_ROOT, "agents-escape-target-"));
    const symlinkCtxDir = await mkdtemp(path.join(TEST_TMP_ROOT, "agents-symlink-ctx-"));
    await symlink(outsideDir, path.join(symlinkCtxDir, "_agents"));

    const env = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: symlinkCtxDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    try {
      // Attempt message send — should fail because _agents are a symlink outside context
      const result = await runAgentsCli([
        "message", "send",
        "--context", symlinkCtxDir,
        "--from", "lead",
        "--to", "lead",
        "--topic", "test",
        "--body", "test",
      ], env);
      expect(result.code).not.toBe(0);
      const json = parseJsonStdout(result);
      expect(json.ok).toBe(false);
      expect(json.error).toBeTruthy();

      // Also test tasks add
      const tasksResult = await runAgentsCli([
        "tasks", "add",
        "--context", symlinkCtxDir,
        "--title", "test task",
      ], env);
      expect(tasksResult.code).not.toBe(0);
      const tasksJson = parseJsonStdout(tasksResult);
      expect(tasksJson.ok).toBe(false);
      expect(tasksJson.error).toBeTruthy();
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
      await rm(symlinkCtxDir, { recursive: true, force: true });
    }
  }, AT_TIMEOUT);

  // -----------------------------------------------------------------------
  // Spec 3.5: Path safety for `init` subcommand
  // -----------------------------------------------------------------------

  it("init rejects symlinked _agents pointing outside context dir", async () => {
    const outsideDir = await mkdtemp(path.join(TEST_TMP_ROOT, "agents-init-escape-"));
    const symlinkCtxDir = await mkdtemp(path.join(TEST_TMP_ROOT, "agents-init-symctx-"));
    await symlink(outsideDir, path.join(symlinkCtxDir, "_agents"));

    try {
      const result = await runAgentsCli([
        "init",
        "--context", symlinkCtxDir,
        "--team", "test-team",
      ]);
      expect(result.code).not.toBe(0);
      const json = parseJsonStdout(result);
      expect(json.ok).toBe(false);
      expect(json.error).toBeTruthy();
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
      await rm(symlinkCtxDir, { recursive: true, force: true });
    }
  }, AT_TIMEOUT);

  it("init rejects traversal-like --lead id (../x)", async () => {
    const result = await runAgentsCli([
      "init",
      "--context", contextDir,
      "--team", "test-team",
      "--lead", "../x",
    ]);
    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("path");
  }, AT_TIMEOUT);

  it("init rejects traversal-like member ids from --json-stdin", async () => {
    const stdinPayload = JSON.stringify({
      team_name: "test-team",
      lead_member_id: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "team_lead" },
        { member_id: "../escape", name: "Bad", role: "worker" },
      ],
    });

    const result = await runAgentsCli([
      "init",
      "--context", contextDir,
      "--team", "test-team",
      "--json-stdin",
    ], createCleanEnv(), stdinPayload);
    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("path");
  }, AT_TIMEOUT);

  // -----------------------------------------------------------------------
  // Members mutation: set, upsert, remove + lead identity restriction
  // -----------------------------------------------------------------------

  it("members upsert adds a new member (lead-restricted)", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const leadEnv = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const result = await runAgentsCli([
      "members", "upsert",
      "--context", contextDir,
      "--member", "newbie",
      "--agent", "newbie-agent",
      "--name", "Newbie",
      "--role", "worker",
    ], leadEnv);

    const json = parseJsonStdout(result);
    expect(json.ok).toBe(true);
    expect(json.member_id).toBe("newbie");
    expect(json.action).toBe("upserted");

    // Verify member exists in list
    const listResult = await runAgentsCli([
      "members", "list",
      "--context", contextDir,
    ], leadEnv);
    const listJson = parseJsonStdout(listResult);
    expect(listJson.ok).toBe(true);
    const found = listJson.members.find((m: any) => m.member_id === "newbie");
    expect(found).toBeTruthy();
    expect(found.agent).toBe("newbie-agent");
  }, 30_000);

  it("members remove removes a non-lead member (lead-restricted)", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const leadEnv = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    // First add a member
    await runAgentsCli([
      "members", "upsert",
      "--context", contextDir,
      "--member", "temp",
      "--agent", "temp-agent",
    ], leadEnv);

    // Now remove
    const result = await runAgentsCli([
      "members", "remove",
      "--context", contextDir,
      "--member", "temp",
    ], leadEnv);

    const json = parseJsonStdout(result);
    expect(json.ok).toBe(true);
    expect(json.member_id).toBe("temp");
    expect(json.action).toBe("removed");

    // Verify member is gone
    const listResult = await runAgentsCli([
      "members", "list",
      "--context", contextDir,
    ], leadEnv);
    const listJson = parseJsonStdout(listResult);
    const found = listJson.members.find((m: any) => m.member_id === "temp");
    expect(found).toBeUndefined();
  }, 30_000);

  it("members set replaces the full member list atomically (lead-restricted)", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const leadEnv = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const newMembers = JSON.stringify([
      { member_id: "lead", name: "Lead", role: "team_lead" },
      { member_id: "a", name: "A", role: "worker" },
      { member_id: "b", name: "B", role: "worker" },
    ]);

    const result = await runAgentsCli([
      "members", "set",
      "--context", contextDir,
      "--json-stdin",
    ], leadEnv, newMembers);

    const json = parseJsonStdout(result);
    expect(json.ok).toBe(true);
    expect(json.members_count).toBe(3);
  }, 30_000);

  it("non-lead member is rejected from mutating membership", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    // Add a non-lead member first (as lead)
    const leadEnv = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });
    await runAgentsCli([
      "members", "upsert",
      "--context", contextDir,
      "--member", "alice",
      "--agent", "alice-agent",
    ], leadEnv);

    // Try to upsert as non-lead (alice)
    const aliceEnv = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "alice",
    });

    const result = await runAgentsCli([
      "members", "upsert",
      "--context", contextDir,
      "--member", "bob",
      "--agent", "bob-agent",
    ], aliceEnv);

    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("lead");
  }, 30_000);

  it("members remove rejects removal of the lead member", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const leadEnv = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const result = await runAgentsCli([
      "members", "remove",
      "--context", contextDir,
      "--member", "lead",
    ], leadEnv);

    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("lead");
  }, AT_TIMEOUT);

  it("members mutation without ROBOPPI_AGENTS_MEMBER_ID returns JSON error", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const noMemberEnv = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      // ROBOPPI_AGENTS_MEMBER_ID deliberately not set
    });

    const result = await runAgentsCli([
      "members", "upsert",
      "--context", contextDir,
      "--member", "bob",
      "--agent", "bob-agent",
    ], noMemberEnv);

    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toBeTruthy();
  }, 15_000);

  // -----------------------------------------------------------------------
  // Spec 3.4: JSON-safe failures for new members subcommands
  // -----------------------------------------------------------------------

  it("unknown members subcommand returns JSON error", async () => {
    const result = await runAgentsCli(["members", "wat"]);
    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toBeTruthy();
  }, 15_000);

  it("members upsert missing --member flag returns JSON error", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const leadEnv = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const result = await runAgentsCli([
      "members", "upsert",
      "--context", contextDir,
      "--agent", "some-agent",
    ], leadEnv);

    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("--member");
  }, 15_000);

  // -----------------------------------------------------------------------
  // Spec 3.5: Path safety for members mutation inputs
  // -----------------------------------------------------------------------

  it("members upsert rejects traversal-like member id", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const leadEnv = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const result = await runAgentsCli([
      "members", "upsert",
      "--context", contextDir,
      "--member", "../escape",
      "--agent", "some-agent",
    ], leadEnv);

    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("path");
  }, 15_000);
});
