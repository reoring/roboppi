/**
 * Swarm CLI — `roboppi swarm ...` subcommand group.
 *
 * All stdout output is JSON-only for deterministic tool use.
 * Spec 3.4: failures emit `{ "ok": false, "error": "..." }` on stdout with non-zero exit.
 */
import {
  initSwarmContext,
  readTeam,
  readMembers,
  validateMember,
  deliverMessage,
  broadcastMessage,
  recvMessages,
  ackMessage,
  ackMessageByClaimToken,
} from "./store.js";
import {
  addTask,
  listTasks,
  claimTask,
  completeTask,
} from "./task-store.js";
import { housekeepMailbox, housekeepTasksInProgress } from "./housekeeping.js";
import { DEFAULT_RECV_POLL_INTERVAL_MS } from "./constants.js";
import { assertSwarmRootSafe, validateMemberIdPath, validateIdPath } from "./path-safety.js";
import type { MemberEntry, MessageKind, TaskStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Emit a JSON error on stdout and exit with code 1.
 * Spec 3.4: all failures MUST produce `{ "ok": false, "error": "..." }` on stdout.
 */
function die(msg: string): never {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(1);
}

function jsonOut(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function requireArg(argv: string[], i: number, flag: string): string {
  const val = argv[i + 1];
  if (val === undefined || val.startsWith("-")) {
    die(`${flag} requires a value`);
  }
  return val;
}

function resolveContextDir(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === "--context" && next) return next;
  }
  const env = process.env.ROBOPPI_SWARM_CONTEXT_DIR;
  if (env) return env;
  return die("--context <dir> is required (or set ROBOPPI_SWARM_CONTEXT_DIR)");
}

function resolveEnvDefault(argv: string[], flag: string, envVar: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    if (argv[i] === flag && next) return next;
  }
  return process.env[envVar];
}

async function readJsonStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

async function validateFromMember(contextDir: string, memberId: string): Promise<MemberEntry> {
  return validateMember(contextDir, memberId);
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function handleInit(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let teamName = "";
  let leadMemberId = "lead";
  const memberEntries: MemberEntry[] = [];
  let useJsonStdin = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--team") teamName = requireArg(argv, i, "--team");
    if (argv[i] === "--lead") leadMemberId = requireArg(argv, i, "--lead");
    if (argv[i] === "--json-stdin") useJsonStdin = true;
  }

  if (useJsonStdin) {
    const input = await readJsonStdin() as Record<string, unknown>;
    teamName = (input.team_name as string) ?? teamName;
    leadMemberId = (input.lead_member_id as string) ?? leadMemberId;
    if (Array.isArray(input.members)) {
      for (const m of input.members) {
        memberEntries.push(m as MemberEntry);
      }
    }
  }

  if (!teamName) die("--team <name> is required");

  // Spec 3.5: path safety — validate before any filesystem mutations
  await assertSwarmRootSafe(contextDir);
  validateMemberIdPath(leadMemberId);

  if (memberEntries.length === 0) {
    // Create a minimal lead member
    memberEntries.push({
      member_id: leadMemberId,
      name: leadMemberId,
      role: "team_lead",
    });
  } else {
    // Validate all user-supplied member IDs from JSON stdin
    for (const m of memberEntries) {
      validateMemberIdPath(m.member_id);
    }
  }

  const { teamId } = await initSwarmContext({
    contextDir,
    teamName,
    leadMemberId,
    members: memberEntries,
  });

  jsonOut({ ok: true, team_id: teamId });
}

async function handleMembersList(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  const team = await readTeam(contextDir);
  const { members } = await readMembers(contextDir);

  // Sort deterministically by member_id
  const sorted = [...members].sort((a, b) => a.member_id.localeCompare(b.member_id));
  jsonOut({
    ok: true,
    team_id: team.team_id,
    team_name: team.name,
    lead_member_id: team.lead_member_id,
    members: sorted,
  });
}

async function handleMessageSend(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let fromMemberId = resolveEnvDefault(argv, "--from", "ROBOPPI_SWARM_MEMBER_ID") ?? "";
  let toMemberId = "";
  let topic = "";
  let body = "";
  let kind: string | undefined;
  let useJsonStdin = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") fromMemberId = requireArg(argv, i, "--from");
    if (argv[i] === "--to") toMemberId = requireArg(argv, i, "--to");
    if (argv[i] === "--topic") topic = requireArg(argv, i, "--topic");
    if (argv[i] === "--body") body = requireArg(argv, i, "--body");
    if (argv[i] === "--kind") kind = requireArg(argv, i, "--kind");
    if (argv[i] === "--json-stdin") useJsonStdin = true;
  }

  if (useJsonStdin) {
    const input = await readJsonStdin() as Record<string, unknown>;
    fromMemberId = (input.from as string) ?? fromMemberId;
    toMemberId = (input.to as string) ?? toMemberId;
    topic = (input.topic as string) ?? topic;
    body = (input.body as string) ?? body;
    kind = (input.kind as string) ?? kind;
  }

  if (!fromMemberId) die("--from is required (or set ROBOPPI_SWARM_MEMBER_ID)");
  if (!toMemberId) die("--to is required");
  if (!topic) die("--topic is required");

  // Spec 3.5: path safety
  await assertSwarmRootSafe(contextDir);
  validateMemberIdPath(fromMemberId);
  validateMemberIdPath(toMemberId);

  const sender = await validateFromMember(contextDir, fromMemberId);
  await validateMember(contextDir, toMemberId);
  const team = await readTeam(contextDir);

  const result = await deliverMessage({
    contextDir,
    teamId: team.team_id,
    fromMemberId,
    fromName: sender.name,
    toMemberId,
    topic,
    body,
    kind: kind as MessageKind | undefined,
  });

  jsonOut({ ok: true, message_id: result.messageId, delivered: [toMemberId] });
}

async function handleMessageBroadcast(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let fromMemberId = resolveEnvDefault(argv, "--from", "ROBOPPI_SWARM_MEMBER_ID") ?? "";
  let topic = "";
  let body = "";
  let kind: string | undefined;
  let useJsonStdin = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--from") fromMemberId = requireArg(argv, i, "--from");
    if (argv[i] === "--topic") topic = requireArg(argv, i, "--topic");
    if (argv[i] === "--body") body = requireArg(argv, i, "--body");
    if (argv[i] === "--kind") kind = requireArg(argv, i, "--kind");
    if (argv[i] === "--json-stdin") useJsonStdin = true;
  }

  if (useJsonStdin) {
    const input = await readJsonStdin() as Record<string, unknown>;
    fromMemberId = (input.from as string) ?? fromMemberId;
    topic = (input.topic as string) ?? topic;
    body = (input.body as string) ?? body;
    kind = (input.kind as string) ?? kind;
  }

  if (!fromMemberId) die("--from is required (or set ROBOPPI_SWARM_MEMBER_ID)");
  if (!topic) die("--topic is required");

  // Spec 3.5: path safety
  await assertSwarmRootSafe(contextDir);
  validateMemberIdPath(fromMemberId);

  const sender = await validateFromMember(contextDir, fromMemberId);
  const team = await readTeam(contextDir);

  const result = await broadcastMessage({
    contextDir,
    teamId: team.team_id,
    fromMemberId,
    fromName: sender.name,
    topic,
    body,
    kind: kind as MessageKind | undefined,
  });

  jsonOut({ ok: true, message_id: result.messageId, delivered: result.delivered });
}

async function handleMessageRecv(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let forMemberId = resolveEnvDefault(argv, "--for", "ROBOPPI_SWARM_MEMBER_ID") ?? "";
  let claim = false;
  let max: number | undefined;
  let waitMs: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--for") forMemberId = requireArg(argv, i, "--for");
    if (argv[i] === "--claim") claim = true;
    if (argv[i] === "--max") max = parseInt(requireArg(argv, i, "--max"), 10);
    if (argv[i] === "--wait-ms") {
      const raw = requireArg(argv, i, "--wait-ms");
      waitMs = parseInt(raw, 10);
      if (!Number.isInteger(waitMs) || waitMs < 0) {
        die("--wait-ms must be an integer >= 0");
      }
    }
  }

  if (!forMemberId) die("--for is required (or set ROBOPPI_SWARM_MEMBER_ID)");

  // Spec 3.5: path safety
  await assertSwarmRootSafe(contextDir);
  validateMemberIdPath(forMemberId);

  await validateMember(contextDir, forMemberId);

  // Spec 3.1: bounded polling with --wait-ms
  const deadline = waitMs !== undefined ? Date.now() + waitMs : 0;
  let messages = await recvMessages({
    contextDir,
    memberId: forMemberId,
    claim,
    max,
  });

  if (messages.length === 0 && waitMs !== undefined && waitMs > 0) {
    const pollInterval = DEFAULT_RECV_POLL_INTERVAL_MS;
    while (messages.length === 0 && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const sleepTime = Math.min(pollInterval, remaining);
      if (sleepTime <= 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, sleepTime));
      messages = await recvMessages({
        contextDir,
        memberId: forMemberId,
        claim,
        max,
      });
    }
  }

  jsonOut({
    ok: true,
    messages: messages.map((m) => ({
      message_id: m.messageId,
      from: m.message.from.member_id,
      topic: m.message.topic,
      kind: m.message.kind,
      body: m.message.body,
      ...(m.claim ? { claim: m.claim } : {}),
    })),
  });
}

async function handleMessageAck(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let forMemberId = resolveEnvDefault(argv, "--for", "ROBOPPI_SWARM_MEMBER_ID") ?? "";
  let messageId = "";
  let claimToken = "";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--for") forMemberId = requireArg(argv, i, "--for");
    if (argv[i] === "--message-id") messageId = requireArg(argv, i, "--message-id");
    if (argv[i] === "--claim-token") claimToken = requireArg(argv, i, "--claim-token");
  }

  if (!forMemberId) die("--for is required (or set ROBOPPI_SWARM_MEMBER_ID)");

  // Spec 3.5: path safety
  await assertSwarmRootSafe(contextDir);
  validateMemberIdPath(forMemberId);
  if (messageId) validateIdPath(messageId, "message-id");

  await validateMember(contextDir, forMemberId);

  let success: boolean;
  if (claimToken) {
    success = await ackMessageByClaimToken(contextDir, forMemberId, claimToken);
  } else if (messageId) {
    success = await ackMessage(contextDir, forMemberId, messageId);
  } else {
    die("--message-id or --claim-token is required");
  }

  if (!success) {
    jsonOut({ ok: false, error: "Message not found or claim token expired" });
    process.exit(1);
    return;
  }
  jsonOut({ ok: true });
}

async function handleTasksAdd(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let title = "";
  let description = "";
  let assignedTo: string | undefined;
  const dependsOn: string[] = [];
  const tags: string[] = [];
  let useJsonStdin = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--title") title = requireArg(argv, i, "--title");
    if (argv[i] === "--description") description = requireArg(argv, i, "--description");
    if (argv[i] === "--assigned-to") assignedTo = requireArg(argv, i, "--assigned-to");
    if (argv[i] === "--depends-on") dependsOn.push(requireArg(argv, i, "--depends-on"));
    if (argv[i] === "--tag") tags.push(requireArg(argv, i, "--tag"));
    if (argv[i] === "--json-stdin") useJsonStdin = true;
  }

  if (useJsonStdin) {
    const input = await readJsonStdin() as Record<string, unknown>;
    title = (input.title as string) ?? title;
    description = (input.description as string) ?? description;
    assignedTo = (input.assigned_to as string) ?? assignedTo;
    if (Array.isArray(input.depends_on)) {
      dependsOn.push(...(input.depends_on as string[]));
    }
    if (Array.isArray(input.tags)) {
      tags.push(...(input.tags as string[]));
    }
  }

  if (!title) die("--title is required");

  // Spec 3.5: path safety
  await assertSwarmRootSafe(contextDir);
  if (assignedTo) {
    validateMemberIdPath(assignedTo);
    await validateMember(contextDir, assignedTo);
  }

  const result = await addTask({
    contextDir,
    title,
    description: description || "",
    dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    assignedTo,
    tags: tags.length > 0 ? tags : undefined,
  });

  jsonOut({ ok: true, task_id: result.taskId });
}

async function handleTasksList(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let status: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--status") status = requireArg(argv, i, "--status");
  }

  const tasks = await listTasks(
    contextDir,
    status as TaskStatus | undefined,
  );

  // Sort deterministically by created_at then task_id
  tasks.sort((a, b) => a.created_at - b.created_at || a.task_id.localeCompare(b.task_id));

  jsonOut({
    ok: true,
    tasks: tasks.map((t) => ({
      task_id: t.task_id,
      title: t.title,
      status: t.status,
      assigned_to: t.assigned_to,
      claimed_by: t.claimed_by,
      depends_on: t.depends_on,
      tags: t.tags,
    })),
  });
}

async function handleTasksClaim(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let taskId = "";
  let memberId = resolveEnvDefault(argv, "--member", "ROBOPPI_SWARM_MEMBER_ID") ?? "";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task-id") taskId = requireArg(argv, i, "--task-id");
    if (argv[i] === "--member") memberId = requireArg(argv, i, "--member");
  }

  if (!taskId) die("--task-id is required");
  if (!memberId) die("--member is required (or set ROBOPPI_SWARM_MEMBER_ID)");

  // Spec 3.5: path safety
  await assertSwarmRootSafe(contextDir);
  validateMemberIdPath(memberId);
  validateIdPath(taskId, "task-id");
  await validateMember(contextDir, memberId);

  const result = await claimTask(contextDir, taskId, memberId);
  jsonOut(result);
  if (!result.ok) process.exit(1);
}

async function handleTasksComplete(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let taskId = "";
  let memberId = resolveEnvDefault(argv, "--member", "ROBOPPI_SWARM_MEMBER_ID") ?? "";
  const artifacts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task-id") taskId = requireArg(argv, i, "--task-id");
    if (argv[i] === "--member") memberId = requireArg(argv, i, "--member");
    if (argv[i] === "--artifact") artifacts.push(requireArg(argv, i, "--artifact"));
  }

  if (!taskId) die("--task-id is required");
  if (!memberId) die("--member is required (or set ROBOPPI_SWARM_MEMBER_ID)");

  // Spec 3.5: path safety
  await assertSwarmRootSafe(contextDir);
  validateMemberIdPath(memberId);
  validateIdPath(taskId, "task-id");
  await validateMember(contextDir, memberId);

  const result = await completeTask(
    contextDir,
    taskId,
    memberId,
    artifacts.length > 0 ? artifacts : undefined,
  );
  jsonOut(result);
  if (!result.ok) process.exit(1);
}

async function handleHousekeep(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);

  // Spec 3.5: path safety
  await assertSwarmRootSafe(contextDir);

  const mailboxResult = await housekeepMailbox({ contextDir });
  const taskResult = await housekeepTasksInProgress({ contextDir });
  jsonOut({
    ok: true,
    requeued: mailboxResult.requeued,
    dead_lettered: mailboxResult.deadLettered,
    tasks_requeued: taskResult.requeued,
    warnings: [...mailboxResult.warnings, ...taskResult.warnings],
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const SWARM_HELP = `
roboppi swarm — swarm team coordination tools

USAGE
  roboppi swarm init --context <dir> --team <name> [--json-stdin]
  roboppi swarm members list --context <dir>
  roboppi swarm message send --context <dir> --from <id> --to <id> --topic <t> --body <text>
  roboppi swarm message broadcast --context <dir> --from <id> --topic <t> --body <text>
  roboppi swarm message recv --context <dir> --for <id> [--claim] [--max N] [--wait-ms M]
  roboppi swarm message ack --context <dir> --for <id> --message-id <uuid>|--claim-token <token>
  roboppi swarm tasks add --context <dir> --title <t> --description <d> [--json-stdin]
  roboppi swarm tasks list --context <dir> [--status pending|in_progress|completed|blocked]
  roboppi swarm tasks claim --context <dir> --task-id <uuid> --member <id>
  roboppi swarm tasks complete --context <dir> --task-id <uuid> --member <id> [--artifact <p>]
  roboppi swarm housekeep --context <dir>

NOTES
  All stdout output is JSON-only for deterministic tool use.
  --context defaults to ROBOPPI_SWARM_CONTEXT_DIR env var.
  --from/--for/--member defaults to ROBOPPI_SWARM_MEMBER_ID env var.
  Body-heavy commands support --json-stdin to read input from stdin.
`.trim();

export async function runSwarmCli(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stderr.write(SWARM_HELP + "\n");
    process.exit(0);
  }

  try {
    const sub = argv[0];
    const rest = argv.slice(1);

    switch (sub) {
      case "init":
        await handleInit(rest);
        break;

      case "members":
        if (rest[0] === "list") {
          await handleMembersList(rest.slice(1));
        } else {
          die(`Unknown members subcommand: ${rest[0]}. Use: members list`);
        }
        break;

      case "message":
        switch (rest[0]) {
          case "send":
            await handleMessageSend(rest.slice(1));
            break;
          case "broadcast":
            await handleMessageBroadcast(rest.slice(1));
            break;
          case "recv":
            await handleMessageRecv(rest.slice(1));
            break;
          case "ack":
            await handleMessageAck(rest.slice(1));
            break;
          default:
            die(`Unknown message subcommand: ${rest[0]}. Use: send|broadcast|recv|ack`);
        }
        break;

      case "tasks":
        switch (rest[0]) {
          case "add":
            await handleTasksAdd(rest.slice(1));
            break;
          case "list":
            await handleTasksList(rest.slice(1));
            break;
          case "claim":
            await handleTasksClaim(rest.slice(1));
            break;
          case "complete":
            await handleTasksComplete(rest.slice(1));
            break;
          default:
            die(`Unknown tasks subcommand: ${rest[0]}. Use: add|list|claim|complete`);
        }
        break;

      case "housekeep":
        await handleHousekeep(rest);
        break;

      default:
        die(`Unknown swarm subcommand: ${sub}\n${SWARM_HELP}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jsonOut({ ok: false, error: msg });
    process.exit(1);
  }
}
