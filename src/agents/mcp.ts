import { readTeam, readMembers, validateMember, deliverMessage, broadcastMessage, recvMessages, ackMessage, ackMessageByClaimToken, upsertMember } from "./store.js";
import { addTask, claimTask, completeTask, listTasks, supersedeTask } from "./task-store.js";
import { readWorkflowStatus, writeWorkflowStatus, clearWorkflowStatus } from "./status-store.js";
import { assertAgentsRootSafe, validateIdPath, validateMemberIdPath } from "./path-safety.js";
import type { MemberEntry, MessageKind, TaskStatus } from "./types.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "roboppi-agents-mcp";
const SERVER_VERSION = "0.1.0";

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: Json;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: Json;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, env: ServerEnv) => Promise<unknown>;
}

interface ServerEnv {
  defaultContextDir?: string;
  callerMemberId?: string;
}

class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JsonRpcError(-32602, `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function getOptionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new JsonRpcError(-32602, `"${key}" must be a string`);
  }
  return value;
}

function getRequiredString(obj: Record<string, unknown>, key: string): string {
  const value = getOptionalString(obj, key);
  if (!value) {
    throw new JsonRpcError(-32602, `"${key}" is required`);
  }
  return value;
}

function getOptionalBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new JsonRpcError(-32602, `"${key}" must be a boolean`);
  }
  return value;
}

function getOptionalNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new JsonRpcError(-32602, `"${key}" must be a finite number`);
  }
  return value;
}

function getOptionalStringArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new JsonRpcError(-32602, `"${key}" must be an array of strings`);
  }
  return value as string[];
}

function getOptionalRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = obj[key];
  if (value === undefined || value === null) return undefined;
  return assertObject(value, key);
}

function resolveContextDir(args: Record<string, unknown>, env: ServerEnv): string {
  const value = getOptionalString(args, "context_dir") ?? env.defaultContextDir ?? process.env.ROBOPPI_AGENTS_CONTEXT_DIR;
  if (!value) {
    throw new JsonRpcError(-32602, `"context_dir" is required (or set ROBOPPI_AGENTS_CONTEXT_DIR)`);
  }
  return value;
}

function resolveCallerMemberId(args: Record<string, unknown>, key: string, env: ServerEnv): string {
  const value = getOptionalString(args, key) ?? env.callerMemberId ?? process.env.ROBOPPI_AGENTS_MEMBER_ID;
  if (!value) {
    throw new JsonRpcError(-32602, `"${key}" is required (or set ROBOPPI_AGENTS_MEMBER_ID)`);
  }
  return value;
}

function memberName(entry: MemberEntry): string {
  return entry.name || entry.member_id;
}

async function requireLeadIdentity(contextDir: string, env: ServerEnv): Promise<string> {
  const team = await readTeam(contextDir);
  const callerMemberId = env.callerMemberId ?? process.env.ROBOPPI_AGENTS_MEMBER_ID;
  if (!callerMemberId) {
    throw new JsonRpcError(-32602, "ROBOPPI_AGENTS_MEMBER_ID is not set; this tool requires lead identity");
  }
  if (team.lead_member_id !== callerMemberId) {
    throw new JsonRpcError(-32602, `Only the lead ("${team.lead_member_id}") may use this tool. Caller: "${callerMemberId}"`);
  }
  return callerMemberId;
}

function renderToolResult(result: unknown): { content: Array<{ type: "text"; text: string }>; structuredContent: unknown; isError?: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function renderToolError(error: unknown): { content: Array<{ type: "text"; text: string }>; structuredContent: { ok: false; error: string }; isError: true } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { ok: false, error: message },
    isError: true,
  };
}

function buildTools(): McpTool[] {
  return [
    {
      name: "agents_list_members",
      description: "List current agent team members from members.json.",
      inputSchema: {
        type: "object",
        properties: {
          context_dir: { type: "string" },
        },
      },
      handler: async (args, env) => {
        const contextDir = resolveContextDir(args, env);
        const team = await readTeam(contextDir);
        const { members } = await readMembers(contextDir);
        return {
          ok: true,
          team_id: team.team_id,
          team_name: team.name,
          lead_member_id: team.lead_member_id,
          members,
        };
      },
    },
    {
      name: "agents_send_message",
      description: "Deliver a direct message to a teammate inbox.",
      inputSchema: {
        type: "object",
        properties: {
          context_dir: { type: "string" },
          from_member_id: { type: "string" },
          to_member_id: { type: "string" },
          topic: { type: "string" },
          body: { type: "string" },
          kind: { type: "string" },
          correlation_id: { type: "string" },
          reply_to: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["to_member_id", "topic", "body"],
      },
      handler: async (args, env) => {
        const contextDir = resolveContextDir(args, env);
        const team = await readTeam(contextDir);
        const fromMemberId = resolveCallerMemberId(args, "from_member_id", env);
        const fromEntry = await validateMember(contextDir, fromMemberId);
        const toMemberId = getRequiredString(args, "to_member_id");
        validateMemberIdPath(toMemberId);
        await validateMember(contextDir, toMemberId);
        const result = await deliverMessage({
          contextDir,
          teamId: team.team_id,
          fromMemberId,
          fromName: memberName(fromEntry),
          toMemberId,
          kind: getOptionalString(args, "kind") as MessageKind | undefined,
          topic: getRequiredString(args, "topic"),
          body: getRequiredString(args, "body"),
          correlationId: getOptionalString(args, "correlation_id"),
          replyTo: getOptionalString(args, "reply_to"),
          metadata: getOptionalRecord(args, "metadata"),
        });
        return { ok: true, message_id: result.messageId };
      },
    },
    {
      name: "agents_broadcast",
      description: "Broadcast a message to all teammates.",
      inputSchema: {
        type: "object",
        properties: {
          context_dir: { type: "string" },
          from_member_id: { type: "string" },
          topic: { type: "string" },
          body: { type: "string" },
          kind: { type: "string" },
          metadata: { type: "object" },
          include_self: { type: "boolean" },
        },
        required: ["topic", "body"],
      },
      handler: async (args, env) => {
        const contextDir = resolveContextDir(args, env);
        const team = await readTeam(contextDir);
        const fromMemberId = resolveCallerMemberId(args, "from_member_id", env);
        const fromEntry = await validateMember(contextDir, fromMemberId);
        const result = await broadcastMessage({
          contextDir,
          teamId: team.team_id,
          fromMemberId,
          fromName: memberName(fromEntry),
          topic: getRequiredString(args, "topic"),
          body: getRequiredString(args, "body"),
          kind: getOptionalString(args, "kind") as MessageKind | undefined,
          metadata: getOptionalRecord(args, "metadata"),
          includeSelf: getOptionalBoolean(args, "include_self"),
        });
        return { ok: true, message_id: result.messageId, delivered: result.delivered };
      },
    },
    {
      name: "agents_recv",
      description: "Receive inbox messages for a member, optionally claiming them.",
      inputSchema: {
        type: "object",
        properties: {
          context_dir: { type: "string" },
          member_id: { type: "string" },
          claim: { type: "boolean" },
          max: { type: "number" },
        },
      },
      handler: async (args, env) => {
        const contextDir = resolveContextDir(args, env);
        const memberId = resolveCallerMemberId(args, "member_id", env);
        validateMemberIdPath(memberId);
        await validateMember(contextDir, memberId);
        const messages = await recvMessages({
          contextDir,
          memberId,
          claim: getOptionalBoolean(args, "claim"),
          max: getOptionalNumber(args, "max"),
        });
        return { ok: true, messages };
      },
    },
    {
      name: "agents_ack",
      description: "Acknowledge a claimed or delivered message.",
      inputSchema: {
        type: "object",
        properties: {
          context_dir: { type: "string" },
          member_id: { type: "string" },
          message_id: { type: "string" },
          claim_token: { type: "string" },
        },
      },
      handler: async (args, env) => {
        const contextDir = resolveContextDir(args, env);
        const memberId = resolveCallerMemberId(args, "member_id", env);
        validateMemberIdPath(memberId);
        await validateMember(contextDir, memberId);
        const claimToken = getOptionalString(args, "claim_token");
        const messageId = getOptionalString(args, "message_id");
        if (!claimToken && !messageId) {
          throw new JsonRpcError(-32602, "\"claim_token\" or \"message_id\" is required");
        }
        if (claimToken) {
          const ok = await ackMessageByClaimToken(contextDir, memberId, claimToken);
          return { ok };
        }
        validateIdPath(messageId!, "message ID");
        const ok = await ackMessage(contextDir, memberId, messageId!);
        return { ok };
      },
    },
    {
      name: "agents_tasks_list",
      description: "List agent tasks, optionally filtered by status.",
      inputSchema: {
        type: "object",
        properties: {
          context_dir: { type: "string" },
          status: { type: "string" },
        },
      },
      handler: async (args, env) => {
        const contextDir = resolveContextDir(args, env);
        const status = getOptionalString(args, "status") as TaskStatus | undefined;
        const tasks = await listTasks(contextDir, status);
        return { ok: true, tasks };
      },
    },
    {
      name: "agents_tasks_claim",
      description: "Claim a pending task for a member.",
      inputSchema: {
        type: "object",
        properties: {
          context_dir: { type: "string" },
          task_id: { type: "string" },
          member_id: { type: "string" },
        },
        required: ["task_id"],
      },
      handler: async (args, env) => {
        const contextDir = resolveContextDir(args, env);
        const taskId = getRequiredString(args, "task_id");
        const memberId = resolveCallerMemberId(args, "member_id", env);
        validateIdPath(taskId, "task ID");
        validateMemberIdPath(memberId);
        const result = await claimTask(contextDir, taskId, memberId);
        return result;
      },
    },
    {
      name: "agents_tasks_complete",
      description: "Complete an in-progress task.",
      inputSchema: {
        type: "object",
        properties: {
          context_dir: { type: "string" },
          task_id: { type: "string" },
          member_id: { type: "string" },
          artifacts: { type: "array", items: { type: "string" } },
        },
        required: ["task_id"],
      },
      handler: async (args, env) => {
        const contextDir = resolveContextDir(args, env);
        const taskId = getRequiredString(args, "task_id");
        const memberId = resolveCallerMemberId(args, "member_id", env);
        validateIdPath(taskId, "task ID");
        validateMemberIdPath(memberId);
        return completeTask(contextDir, taskId, memberId, getOptionalStringArray(args, "artifacts"));
      },
    },
    {
      name: "agents_tasks_supersede",
      description: "Supersede a pending, blocked, or in-progress task.",
      inputSchema: {
        type: "object",
        properties: {
          context_dir: { type: "string" },
          task_id: { type: "string" },
          member_id: { type: "string" },
          reason: { type: "string" },
          replacement_task_id: { type: "string" },
        },
        required: ["task_id"],
      },
      handler: async (args, env) => {
        const contextDir = resolveContextDir(args, env);
        const taskId = getRequiredString(args, "task_id");
        const memberId = resolveCallerMemberId(args, "member_id", env);
        validateIdPath(taskId, "task ID");
        validateMemberIdPath(memberId);
        const replacementTaskId = getOptionalString(args, "replacement_task_id");
        if (replacementTaskId) {
          validateIdPath(replacementTaskId, "replacement task ID");
        }
        return supersedeTask(
          contextDir,
          taskId,
          memberId,
          getOptionalString(args, "reason"),
          replacementTaskId,
        );
      },
    },
    {
      name: "agents_status_get",
      description: "Read the current workflow status summary.",
      inputSchema: {
        type: "object",
        properties: {
          context_dir: { type: "string" },
        },
      },
      handler: async (args, env) => {
        const contextDir = resolveContextDir(args, env);
        return { ok: true, status: await readWorkflowStatus(contextDir) };
      },
    },
    {
      name: "agents_status_set",
      description: "Set or clear the workflow status summary.",
      inputSchema: {
        type: "object",
        properties: {
          context_dir: { type: "string" },
          owner_member_id: { type: "string" },
          summary: { type: "string" },
          blockers: { type: "array", items: { type: "string" } },
          next_actions: { type: "array", items: { type: "string" } },
          clear: { type: "boolean" },
        },
      },
      handler: async (args, env) => {
        const contextDir = resolveContextDir(args, env);
        if (getOptionalBoolean(args, "clear")) {
          await clearWorkflowStatus(contextDir);
          return { ok: true, cleared: true };
        }
        const ownerMemberId = resolveCallerMemberId(args, "owner_member_id", env);
        const status = await writeWorkflowStatus({
          contextDir,
          ownerMemberId,
          summary: getRequiredString(args, "summary"),
          blockers: getOptionalStringArray(args, "blockers"),
          nextActions: getOptionalStringArray(args, "next_actions"),
        });
        return { ok: true, status };
      },
    },
    {
      name: "agents_specialist_activate",
      description: "Lead-only helper to wake a dormant specialist and optionally seed a task for it.",
      inputSchema: {
        type: "object",
        properties: {
          context_dir: { type: "string" },
          member_id: { type: "string" },
          agent_id: { type: "string" },
          name: { type: "string" },
          role: { type: "string" },
          task: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              depends_on: { type: "array", items: { type: "string" } },
              tags: { type: "array", items: { type: "string" } },
              requires_plan_approval: { type: "boolean" },
            },
            required: ["title", "description"],
          },
        },
        required: ["member_id", "agent_id"],
      },
      handler: async (args, env) => {
        const contextDir = resolveContextDir(args, env);
        await assertAgentsRootSafe(contextDir);
        await requireLeadIdentity(contextDir, env);
        const memberId = getRequiredString(args, "member_id");
        validateMemberIdPath(memberId);
        const agentId = getRequiredString(args, "agent_id");
        const role = getOptionalString(args, "role") ?? "member";
        const name = getOptionalString(args, "name") ?? memberId;
        await upsertMember(contextDir, {
          member_id: memberId,
          name,
          role,
          agent: agentId,
        });

        const task = getOptionalRecord(args, "task");
        let taskId: string | undefined;
        if (task) {
          const result = await addTask({
            contextDir,
            title: getRequiredString(task, "title"),
            description: getRequiredString(task, "description"),
            assignedTo: memberId,
            dependsOn: getOptionalStringArray(task, "depends_on"),
            tags: getOptionalStringArray(task, "tags"),
            requiresPlanApproval: getOptionalBoolean(task, "requires_plan_approval"),
          });
          taskId = result.taskId;
        }

        return { ok: true, member_id: memberId, role, task_id: taskId ?? null };
      },
    },
    {
      name: "agents_specialist_deactivate",
      description: "Lead-only helper to return a specialist to dormant state without deleting it from the roster.",
      inputSchema: {
        type: "object",
        properties: {
          context_dir: { type: "string" },
          member_id: { type: "string" },
          role: { type: "string" },
        },
        required: ["member_id"],
      },
      handler: async (args, env) => {
        const contextDir = resolveContextDir(args, env);
        await assertAgentsRootSafe(contextDir);
        await requireLeadIdentity(contextDir, env);
        const memberId = getRequiredString(args, "member_id");
        validateMemberIdPath(memberId);
        const existing = await validateMember(contextDir, memberId);
        const role = getOptionalString(args, "role") ?? "dormant";
        await upsertMember(contextDir, {
          ...existing,
          role,
        });
        return { ok: true, member_id: memberId, role };
      },
    },
  ];
}

function parseContextArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--context") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new JsonRpcError(-32602, "--context requires a value");
      }
      return value;
    }
    if (argv[i] === "--help" || argv[i] === "-h") {
      process.stderr.write("roboppi agents mcp [--context <dir>]\n");
      process.exit(0);
    }
  }
  return undefined;
}

async function dispatchRequest(
  request: JsonRpcRequest,
  tools: Map<string, McpTool>,
  env: ServerEnv,
): Promise<JsonRpcResponse | null> {
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    throw new JsonRpcError(-32600, "Invalid JSON-RPC request");
  }

  const id = request.id;
  const params = request.params ?? {};

  switch (request.method) {
    case "initialize": {
      if (id === undefined) return null;
      const initParams = assertObject(params, "initialize params");
      const protocolVersion = getOptionalString(initParams, "protocolVersion") ?? MCP_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION,
          },
        },
      };
    }
    case "notifications/initialized":
      return null;
    case "ping":
      if (id === undefined) return null;
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      if (id === undefined) return null;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [...tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      };
    case "tools/call": {
      if (id === undefined) return null;
      const callParams = assertObject(params, "tools/call params");
      const name = getRequiredString(callParams, "name");
      const tool = tools.get(name);
      if (!tool) {
        throw new JsonRpcError(-32602, `Unknown tool "${name}"`);
      }
      const args = getOptionalRecord(callParams, "arguments") ?? {};
      try {
        const result = await tool.handler(args, env);
        return { jsonrpc: "2.0", id, result: renderToolResult(result) };
      } catch (err) {
        return { jsonrpc: "2.0", id, result: renderToolError(err) };
      }
    }
    default:
      throw new JsonRpcError(-32601, `Method not found: ${request.method}`);
  }
}

function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, body]);
}

async function readLoop(
  onMessage: (request: JsonRpcRequest) => Promise<void>,
): Promise<void> {
  let buffer = Buffer.alloc(0);
  let contentLength: number | null = null;

  const processBuffer = async (): Promise<void> => {
    while (true) {
      if (contentLength === null) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) break;
        const headerText = buffer.subarray(0, headerEnd).toString("utf8");
        buffer = buffer.subarray(headerEnd + 4);
        const headers = headerText.split("\r\n");
        const contentLengthHeader = headers.find((line) => line.toLowerCase().startsWith("content-length:"));
        if (!contentLengthHeader) {
          throw new JsonRpcError(-32600, "Missing Content-Length header");
        }
        const rawLength = contentLengthHeader.split(":")[1]?.trim();
        const parsedLength = Number(rawLength);
        if (!Number.isFinite(parsedLength) || parsedLength < 0) {
          throw new JsonRpcError(-32600, `Invalid Content-Length: ${rawLength ?? ""}`);
        }
        contentLength = parsedLength;
      }

      if (contentLength === null || buffer.length < contentLength) break;

      const payload = buffer.subarray(0, contentLength);
      buffer = buffer.subarray(contentLength);
      contentLength = null;

      const data = JSON.parse(payload.toString("utf8")) as JsonRpcRequest;
      await onMessage(data);
    }
  };

  await new Promise<void>((resolve, reject) => {
    let chain = Promise.resolve();

    process.stdin.on("data", (chunk: Buffer | string) => {
      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = Buffer.concat([buffer, piece]);
      chain = chain.then(() => processBuffer()).catch(reject);
    });

    process.stdin.on("end", () => {
      chain.then(() => resolve()).catch(reject);
    });

    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

export async function runAgentsMcp(argv: string[]): Promise<void> {
  const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
  const env: ServerEnv = {
    defaultContextDir: parseContextArg(argv),
    callerMemberId: process.env.ROBOPPI_AGENTS_MEMBER_ID,
  };

  const send = (message: JsonRpcResponse): void => {
    process.stdout.write(encodeMessage(message));
  };

  await readLoop(async (request) => {
    try {
      const response = await dispatchRequest(request, tools, env);
      if (response) send(response);
    } catch (err) {
      const id = request && typeof request === "object" && "id" in request ? (request as JsonRpcRequest).id ?? null : null;
      const error = err instanceof JsonRpcError
        ? err
        : new JsonRpcError(-32000, err instanceof Error ? err.message : String(err));
      if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: error.code,
            message: error.message,
            data: error.data,
          },
        });
      }
    }
  });
}
