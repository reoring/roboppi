/**
 * Swarm CLI E2E/AT tests.
 *
 * Spawns real CLI processes to test `roboppi swarm ...` roundtrip.
 * Asserts JSON-only stdout contract.
 *
 * Covers design §11.3.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = process.cwd();

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
    "ROBOPPI_SWARM_CONTEXT_DIR",
    "ROBOPPI_SWARM_MEMBER_ID",
    "ROBOPPI_SWARM_TEAM_ID",
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

async function runSwarmCli(args: string[], env?: NodeJS.ProcessEnv, stdinData?: string): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    const child = spawn(process.execPath, ["run", "src/cli.ts", "--", "swarm", ...args], {
      cwd: REPO_ROOT,
      env: env ?? createCleanEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    if (stdinData !== undefined) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();

    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseJsonStdout(result: CliResult): any {
  expect(result.stdout.trim()).toBeTruthy();
  // Verify JSON-only stdout
  const parsed = JSON.parse(result.stdout.trim());
  return parsed;
}

let contextDir: string;

beforeEach(async () => {
  contextDir = await mkdtemp(path.join(tmpdir(), "swarm-cli-at-"));
});

afterEach(async () => {
  await rm(contextDir, { recursive: true, force: true });
});

describe("roboppi swarm CLI roundtrip", () => {
  it("init + members list", async () => {
    // Init with flag-only (json-stdin requires piped stdin, skip here)
    const initResult2 = await runSwarmCli([
      "init",
      "--context", contextDir,
      "--team", "test-team",
    ]);

    const initJson = parseJsonStdout(initResult2);
    expect(initJson.ok).toBe(true);
    expect(initJson.team_id).toBeTruthy();

    // Members list
    const listResult = await runSwarmCli([
      "members", "list",
      "--context", contextDir,
    ]);
    const listJson = parseJsonStdout(listResult);
    expect(listJson.ok).toBe(true);
    expect(listJson.team_name).toBe("test-team");
    expect(Array.isArray(listJson.members)).toBe(true);
    expect(listJson.members.length).toBeGreaterThanOrEqual(1);
  });

  it("message send + recv + ack roundtrip", async () => {
    // First init with multiple members via json-stdin
    // Use flag-only init (simpler for testing)
    await runSwarmCli(["init", "--context", contextDir, "--team", "test-team"]);

    // We need to add another member. Re-init with full setup using pipe.
    // Actually, the default init creates only the lead. Let's use the store directly
    // to set up the context, then test the CLI operations.

    // For this test, use env-based member identity
    const env = createCleanEnv({
      ROBOPPI_SWARM_CONTEXT_DIR: contextDir,
      ROBOPPI_SWARM_MEMBER_ID: "lead",
    });

    // Send a message (lead -> lead, since we only have one member)
    const sendResult = await runSwarmCli([
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
    const recvResult = await runSwarmCli([
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
    const ackResult = await runSwarmCli([
      "message", "ack",
      "--context", contextDir,
      "--for", "lead",
      "--claim-token", recvJson.messages[0].claim.token,
    ], env);
    const ackJson = parseJsonStdout(ackResult);
    expect(ackJson.ok).toBe(true);

    // Recv again should be empty
    const recv2Result = await runSwarmCli([
      "message", "recv",
      "--context", contextDir,
      "--for", "lead",
    ], env);
    const recv2Json = parseJsonStdout(recv2Result);
    expect(recv2Json.ok).toBe(true);
    expect(recv2Json.messages.length).toBe(0);
  });

  it("tasks add + list + claim + complete roundtrip", async () => {
    await runSwarmCli(["init", "--context", contextDir, "--team", "test-team"]);

    const env = createCleanEnv({
      ROBOPPI_SWARM_CONTEXT_DIR: contextDir,
      ROBOPPI_SWARM_MEMBER_ID: "lead",
    });

    // Add task
    const addResult = await runSwarmCli([
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
    const listResult = await runSwarmCli([
      "tasks", "list",
      "--context", contextDir,
    ], env);
    const listJson = parseJsonStdout(listResult);
    expect(listJson.ok).toBe(true);
    expect(listJson.tasks.length).toBe(1);
    expect(listJson.tasks[0].task_id).toBe(taskId);
    expect(listJson.tasks[0].status).toBe("pending");

    // Claim task
    const claimResult = await runSwarmCli([
      "tasks", "claim",
      "--context", contextDir,
      "--task-id", taskId,
      "--member", "lead",
    ], env);
    const claimJson = parseJsonStdout(claimResult);
    expect(claimJson.ok).toBe(true);

    // List in_progress
    const ipResult = await runSwarmCli([
      "tasks", "list",
      "--context", contextDir,
      "--status", "in_progress",
    ], env);
    const ipJson = parseJsonStdout(ipResult);
    expect(ipJson.ok).toBe(true);
    expect(ipJson.tasks.length).toBe(1);

    // Complete task
    const completeResult = await runSwarmCli([
      "tasks", "complete",
      "--context", contextDir,
      "--task-id", taskId,
      "--member", "lead",
    ], env);
    const completeJson = parseJsonStdout(completeResult);
    expect(completeJson.ok).toBe(true);

    // List completed
    const doneResult = await runSwarmCli([
      "tasks", "list",
      "--context", contextDir,
      "--status", "completed",
    ], env);
    const doneJson = parseJsonStdout(doneResult);
    expect(doneJson.ok).toBe(true);
    expect(doneJson.tasks.length).toBe(1);
  });

  it("housekeep returns JSON", async () => {
    await runSwarmCli(["init", "--context", contextDir, "--team", "test-team"]);

    const result = await runSwarmCli([
      "housekeep",
      "--context", contextDir,
    ]);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(true);
    expect(typeof json.requeued).toBe("number");
    expect(typeof json.dead_lettered).toBe("number");
    expect(Array.isArray(json.warnings)).toBe(true);
  });

  it("--help outputs help text to stderr (not stdout)", async () => {
    const result = await runSwarmCli(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("roboppi swarm");
    // stdout should be empty (JSON-only contract)
    expect(result.stdout.trim()).toBe("");
  });

  it("tasks add --assigned-to unknown member returns error", async () => {
    await runSwarmCli(["init", "--context", contextDir, "--team", "test-team"]);

    const result = await runSwarmCli([
      "tasks", "add",
      "--context", contextDir,
      "--title", "Some task",
      "--assigned-to", "nonexistent-member",
    ]);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toBeTruthy();
  });

  it("all stdout output is valid JSON", async () => {
    await runSwarmCli(["init", "--context", contextDir, "--team", "test-team"]);

    // Run several commands and verify stdout is always JSON
    const commands = [
      ["members", "list", "--context", contextDir],
      ["tasks", "list", "--context", contextDir],
      ["housekeep", "--context", contextDir],
    ];

    for (const cmd of commands) {
      const result = await runSwarmCli(cmd);
      if (result.stdout.trim()) {
        expect(() => JSON.parse(result.stdout.trim())).not.toThrow();
      }
    }
  });

  // -----------------------------------------------------------------------
  // Spec 3.1: message recv --wait-ms
  // -----------------------------------------------------------------------

  it("message recv --wait-ms 0 is non-blocking (returns immediately)", async () => {
    await runSwarmCli(["init", "--context", contextDir, "--team", "test-team"]);
    const env = createCleanEnv({
      ROBOPPI_SWARM_CONTEXT_DIR: contextDir,
      ROBOPPI_SWARM_MEMBER_ID: "lead",
    });

    const start = Date.now();
    const result = await runSwarmCli([
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
  });

  it("message recv --wait-ms timeout returns empty messages", async () => {
    await runSwarmCli(["init", "--context", contextDir, "--team", "test-team"]);
    const env = createCleanEnv({
      ROBOPPI_SWARM_CONTEXT_DIR: contextDir,
      ROBOPPI_SWARM_MEMBER_ID: "lead",
    });

    const result = await runSwarmCli([
      "message", "recv",
      "--context", contextDir,
      "--for", "lead",
      "--wait-ms", "500",
    ], env);

    const json = parseJsonStdout(result);
    expect(result.code).toBe(0);
    expect(json.ok).toBe(true);
    expect(json.messages).toEqual([]);
  });

  it("message recv --wait-ms returns before timeout when message arrives", async () => {
    await runSwarmCli(["init", "--context", contextDir, "--team", "test-team"]);
    const env = createCleanEnv({
      ROBOPPI_SWARM_CONTEXT_DIR: contextDir,
      ROBOPPI_SWARM_MEMBER_ID: "lead",
    });

    // Start a long-wait recv in background
    const recvPromise = runSwarmCli([
      "message", "recv",
      "--context", contextDir,
      "--for", "lead",
      "--wait-ms", "10000",
    ], env);

    // After a short delay, send a message
    await new Promise<void>((r) => setTimeout(r, 500));
    const sendResult = await runSwarmCli([
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
  });

  // -----------------------------------------------------------------------
  // Spec 3.4: JSON-safe CLI failures
  // -----------------------------------------------------------------------

  it("unknown subcommand returns JSON error + non-zero exit", async () => {
    const result = await runSwarmCli(["wat"]);
    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toBeTruthy();
  });

  it("missing required flag returns JSON error + non-zero exit", async () => {
    await runSwarmCli(["init", "--context", contextDir, "--team", "test-team"]);
    // message send without --topic
    const result = await runSwarmCli([
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
  });

  it("semantic failure (ack nonexistent) returns JSON error + non-zero exit", async () => {
    await runSwarmCli(["init", "--context", contextDir, "--team", "test-team"]);
    const env = createCleanEnv({
      ROBOPPI_SWARM_CONTEXT_DIR: contextDir,
      ROBOPPI_SWARM_MEMBER_ID: "lead",
    });

    const result = await runSwarmCli([
      "message", "ack",
      "--context", contextDir,
      "--for", "lead",
      "--message-id", "00000000-0000-0000-0000-000000000000",
    ], env);
    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // Spec 3.5: Path safety — traversal-like member IDs
  // -----------------------------------------------------------------------

  it("traversal-like member id (--to ../x) is rejected with JSON error", async () => {
    await runSwarmCli(["init", "--context", contextDir, "--team", "test-team"]);
    const env = createCleanEnv({
      ROBOPPI_SWARM_CONTEXT_DIR: contextDir,
      ROBOPPI_SWARM_MEMBER_ID: "lead",
    });

    const result = await runSwarmCli([
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
  });

  it("traversal-like member id (--from ../../etc) is rejected with JSON error", async () => {
    await runSwarmCli(["init", "--context", contextDir, "--team", "test-team"]);

    const result = await runSwarmCli([
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
  });

  // -----------------------------------------------------------------------
  // Spec 3.5: Symlink escape prevention
  // -----------------------------------------------------------------------

  it("symlink _swarm pointing outside context dir is rejected", async () => {
    // Create a context dir where _swarm is a symlink to an outside directory
    const outsideDir = await mkdtemp(path.join(tmpdir(), "swarm-escape-target-"));
    const symlinkCtxDir = await mkdtemp(path.join(tmpdir(), "swarm-symlink-ctx-"));
    await symlink(outsideDir, path.join(symlinkCtxDir, "_swarm"));

    const env = createCleanEnv({
      ROBOPPI_SWARM_CONTEXT_DIR: symlinkCtxDir,
      ROBOPPI_SWARM_MEMBER_ID: "lead",
    });

    try {
      // Attempt message send — should fail because _swarm is a symlink outside context
      const result = await runSwarmCli([
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
      const tasksResult = await runSwarmCli([
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
  });

  // -----------------------------------------------------------------------
  // Spec 3.5: Path safety for `init` subcommand
  // -----------------------------------------------------------------------

  it("init rejects symlinked _swarm pointing outside context dir", async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "swarm-init-escape-"));
    const symlinkCtxDir = await mkdtemp(path.join(tmpdir(), "swarm-init-symctx-"));
    await symlink(outsideDir, path.join(symlinkCtxDir, "_swarm"));

    try {
      const result = await runSwarmCli([
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
  });

  it("init rejects traversal-like --lead id (../x)", async () => {
    const result = await runSwarmCli([
      "init",
      "--context", contextDir,
      "--team", "test-team",
      "--lead", "../x",
    ]);
    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("path");
  });

  it("init rejects traversal-like member ids from --json-stdin", async () => {
    const stdinPayload = JSON.stringify({
      team_name: "test-team",
      lead_member_id: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "team_lead" },
        { member_id: "../escape", name: "Bad", role: "worker" },
      ],
    });

    const result = await runSwarmCli([
      "init",
      "--context", contextDir,
      "--team", "test-team",
      "--json-stdin",
    ], createCleanEnv(), stdinPayload);
    expect(result.code).not.toBe(0);
    const json = parseJsonStdout(result);
    expect(json.ok).toBe(false);
    expect(json.error).toContain("path");
  });
});
