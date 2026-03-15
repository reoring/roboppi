import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROBOPPI_VERSION } from "../../src/version.js";

const REPO_ROOT = process.cwd();
const TEST_TMP_ROOT = path.join(REPO_ROOT, ".roboppi-loop", "tmp", "at-agents-mcp");
const CLI_TIMEOUT_MS = 45_000;
const AT_TIMEOUT = 60_000;

type CliResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
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

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`;
}

async function runAgentsCli(args: string[], env?: NodeJS.ProcessEnv): Promise<CliResult> {
  return await new Promise<CliResult>((resolve) => {
    const child = spawn(process.execPath, ["run", "src/cli.ts", "--", "agents", ...args], {
      cwd: REPO_ROOT,
      env: env ?? createCleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

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
      resolve({
        code: null,
        signal: "SIGKILL",
        stdout,
        stderr: stderr + `\n[test harness] Process killed after ${CLI_TIMEOUT_MS}ms timeout`,
      });
    }, CLI_TIMEOUT_MS);
  });
}

function encodeMcpMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

function parseMcpResponses(stdout: string): JsonRpcResponse[] {
  const buffer = Buffer.from(stdout, "utf8");
  const responses: JsonRpcResponse[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const headerEnd = buffer.indexOf("\r\n\r\n", offset, "utf8");
    if (headerEnd === -1) {
      throw new Error(`Missing MCP header terminator in stdout: ${stdout}`);
    }
    const header = buffer.subarray(offset, headerEnd).toString("utf8");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      throw new Error(`Missing Content-Length header in stdout: ${stdout}`);
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf8");
    responses.push(JSON.parse(body) as JsonRpcResponse);
    offset = bodyEnd;
  }

  return responses;
}

async function runAgentsMcpSession(
  contextDir: string,
  requests: unknown[],
  env?: NodeJS.ProcessEnv,
): Promise<{ responses: JsonRpcResponse[]; stderr: string; code: number | null }> {
  const stdinDir = await mkdtemp(path.join(tmpdir(), "roboppi-agents-mcp-stdin-"));
  const stdinPath = path.join(stdinDir, "mcp.input");
  const payload = Buffer.concat(requests.map((request) => encodeMcpMessage(request)));
  await writeFile(stdinPath, payload);

  const result = await new Promise<CliResult>((resolve) => {
    const child = spawn(
      "bash",
      [
        "-lc",
        `${shellQuote(process.execPath)} run src/cli.ts -- agents mcp --context ${shellQuote(contextDir)} < ${shellQuote(stdinPath)}`,
      ],
      {
        cwd: REPO_ROOT,
        env: env ?? createCleanEnv(),
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
      resolve({
        code: null,
        signal: "SIGKILL",
        stdout,
        stderr: stderr + `\n[test harness] Process killed after ${CLI_TIMEOUT_MS}ms timeout`,
      });
    }, CLI_TIMEOUT_MS);
  });

  await rm(stdinDir, { recursive: true, force: true });
  return {
    responses: parseMcpResponses(result.stdout),
    stderr: result.stderr,
    code: result.code,
  };
}

let contextDir: string;

beforeEach(async () => {
  await mkdir(TEST_TMP_ROOT, { recursive: true });
  contextDir = await mkdtemp(path.join(TEST_TMP_ROOT, "agents-mcp-at-"));
});

afterEach(async () => {
  await rm(contextDir, { recursive: true, force: true });
});

describe("roboppi agents mcp", () => {
  it("initializes and lists the structured tools", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const env = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const { responses, stderr, code } = await runAgentsMcpSession(contextDir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          clientInfo: { name: "test", version: "1.0.0" },
          capabilities: {},
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      },
    ], env);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(responses).toHaveLength(2);
    expect(responses[0]?.error).toBeUndefined();
    expect((responses[0]?.result as any).capabilities.tools).toEqual({});
    expect((responses[0]?.result as any).serverInfo).toMatchObject({
      name: "roboppi-agents-mcp",
      version: ROBOPPI_VERSION,
    });

    const tools = (responses[1]?.result as any).tools as Array<{ name: string }>;
    expect(tools.some((tool) => tool.name === "agents_specialist_activate")).toBe(true);
    expect(tools.some((tool) => tool.name === "agents_status_set")).toBe(true);
    expect(tools.some((tool) => tool.name === "agents_tasks_claim")).toBe(true);
  }, AT_TIMEOUT);

  it("activates and deactivates a specialist and updates workflow status", async () => {
    await runAgentsCli(["init", "--context", contextDir, "--team", "test-team"]);

    const env = createCleanEnv({
      ROBOPPI_AGENTS_CONTEXT_DIR: contextDir,
      ROBOPPI_AGENTS_MEMBER_ID: "lead",
    });

    const { responses, stderr, code } = await runAgentsMcpSession(contextDir, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "agents_specialist_activate",
          arguments: {
            member_id: "manual_verifier",
            agent_id: "manual_verifier",
            name: "manual_verifier",
            task: {
              title: "Run manual verification",
              description: "Bootstrap a fresh kind cluster and capture the first blocker.",
              tags: ["manual", "kind"],
            },
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "agents_list_members",
          arguments: {},
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "agents_status_set",
          arguments: {
            summary: "Manual verification is running.",
            blockers: ["waiting for cluster bootstrap"],
            next_actions: ["watch manual_verifier logs"],
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "agents_status_get",
          arguments: {},
        },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "agents_specialist_deactivate",
          arguments: {
            member_id: "manual_verifier",
          },
        },
      },
    ], env);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(responses).toHaveLength(5);

    const activateContent = (responses[0]?.result as any).structuredContent;
    expect(activateContent.ok).toBe(true);
    expect(activateContent.member_id).toBe("manual_verifier");
    expect(activateContent.task_id).toBeTruthy();

    const roster = (responses[1]?.result as any).structuredContent.members as Array<{ member_id: string; role: string; agent?: string }>;
    expect(roster.find((member) => member.member_id === "manual_verifier")).toEqual(
      expect.objectContaining({ member_id: "manual_verifier", role: "member", agent: "manual_verifier" }),
    );

    expect((responses[2]?.result as any).structuredContent.ok).toBe(true);
    expect((responses[3]?.result as any).structuredContent.status.summary).toBe("Manual verification is running.");
    expect((responses[4]?.result as any).structuredContent.role).toBe("dormant");
  }, AT_TIMEOUT);
});
