/**
 * Agents CLI — `roboppi agents ...` subcommand group.
 *
 * All stdout output is JSON-only for deterministic tool use.
 * Spec 3.4: failures emit `{ "ok": false, "error": "..." }` on stdout with non-zero exit.
 */
import {
  initAgentsContext,
  readTeam,
  readMembers,
  validateMember,
  deliverMessage,
  broadcastMessage,
  recvMessages,
  ackMessage,
  ackMessageByClaimToken,
  getClaimedMessageByClaimToken,
  writeMembersConfig,
  upsertMember,
  removeMember,
} from "./store.js";
import {
  addTask,
  listTasks,
  claimTask,
  completeTask,
} from "./task-store.js";
import { housekeepMailbox, housekeepTasksInProgress } from "./housekeeping.js";
import { runChat } from "./chat.js";
import { DEFAULT_RECV_POLL_INTERVAL_MS, DEFAULT_CHAT_POLL_INTERVAL_MS } from "./constants.js";
import { assertAgentsRootSafe, validateMemberIdPath, validateIdPath } from "./path-safety.js";
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
  const env = process.env.ROBOPPI_AGENTS_CONTEXT_DIR;
  if (env) return env;
  return die("--context <dir> is required (or set ROBOPPI_AGENTS_CONTEXT_DIR)");
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

/**
 * Enforce that the caller is the lead member.
 * Compares team.json.lead_member_id with ROBOPPI_AGENTS_MEMBER_ID env var.
 */
async function requireLeadIdentity(contextDir: string): Promise<void> {
  const team = await readTeam(contextDir);
  const callerMemberId = process.env.ROBOPPI_AGENTS_MEMBER_ID;
  if (!callerMemberId) {
    die("ROBOPPI_AGENTS_MEMBER_ID is not set; membership mutations require lead identity");
  }
  if (team.lead_member_id !== callerMemberId) {
    die(`Only the lead ("${team.lead_member_id}") may mutate membership. Caller: "${callerMemberId}"`);
  }
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
  await assertAgentsRootSafe(contextDir);
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

  const { teamId } = await initAgentsContext({
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

async function handleMembersSet(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);

  // Spec 3.5: path safety
  await assertAgentsRootSafe(contextDir);

  // Identity restriction: only lead may mutate
  await requireLeadIdentity(contextDir);

  const input = await readJsonStdin() as unknown;
  let members: MemberEntry[];
  if (Array.isArray(input)) {
    members = input as MemberEntry[];
  } else if (input && typeof input === "object" && Array.isArray((input as Record<string, unknown>).members)) {
    members = (input as Record<string, unknown>).members as MemberEntry[];
  } else {
    die("--json-stdin must provide a JSON array of members or { members: [...] }");
  }

  // Validate all member IDs
  for (const m of members) {
    if (!m.member_id) die("Each member must have a member_id");
    validateMemberIdPath(m.member_id);
  }

  await writeMembersConfig(contextDir, members);
  jsonOut({ ok: true, members_count: members.length });
}

async function handleMembersUpsert(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let memberId = "";
  let agentId = "";
  let name = "";
  let role = "";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--member") memberId = requireArg(argv, i, "--member");
    if (argv[i] === "--agent") agentId = requireArg(argv, i, "--agent");
    if (argv[i] === "--name") name = requireArg(argv, i, "--name");
    if (argv[i] === "--role") role = requireArg(argv, i, "--role");
  }

  if (!memberId) die("--member <id> is required");
  if (!agentId) die("--agent <agentId> is required");

  // Spec 3.5: path safety
  await assertAgentsRootSafe(contextDir);
  validateMemberIdPath(memberId);

  // Identity restriction: only lead may mutate
  await requireLeadIdentity(contextDir);

  const entry: MemberEntry = {
    member_id: memberId,
    name: name || memberId,
    role: role || "member",
    agent: agentId,
  };

  await upsertMember(contextDir, entry);
  jsonOut({ ok: true, member_id: memberId, action: "upserted" });
}

async function handleMembersRemove(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let memberId = "";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--member") memberId = requireArg(argv, i, "--member");
  }

  if (!memberId) die("--member <id> is required");

  // Spec 3.5: path safety
  await assertAgentsRootSafe(contextDir);
  validateMemberIdPath(memberId);

  // Identity restriction: only lead may mutate
  await requireLeadIdentity(contextDir);

  await removeMember(contextDir, memberId);
  jsonOut({ ok: true, member_id: memberId, action: "removed" });
}

async function handleMessageSend(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let fromMemberId = resolveEnvDefault(argv, "--from", "ROBOPPI_AGENTS_MEMBER_ID") ?? "";
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

  if (!fromMemberId) die("--from is required (or set ROBOPPI_AGENTS_MEMBER_ID)");
  if (!toMemberId) die("--to is required");
  if (!topic) die("--topic is required");

  // Spec 3.5: path safety
  await assertAgentsRootSafe(contextDir);
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
  let fromMemberId = resolveEnvDefault(argv, "--from", "ROBOPPI_AGENTS_MEMBER_ID") ?? "";
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

  if (!fromMemberId) die("--from is required (or set ROBOPPI_AGENTS_MEMBER_ID)");
  if (!topic) die("--topic is required");

  // Spec 3.5: path safety
  await assertAgentsRootSafe(contextDir);
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
  let forMemberId = resolveEnvDefault(argv, "--for", "ROBOPPI_AGENTS_MEMBER_ID") ?? "";
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

  if (!forMemberId) die("--for is required (or set ROBOPPI_AGENTS_MEMBER_ID)");

  // Spec 3.5: path safety
  await assertAgentsRootSafe(contextDir);
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
  let forMemberId = resolveEnvDefault(argv, "--for", "ROBOPPI_AGENTS_MEMBER_ID") ?? "";
  let messageId = "";
  let claimToken = "";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--for") forMemberId = requireArg(argv, i, "--for");
    if (argv[i] === "--message-id") messageId = requireArg(argv, i, "--message-id");
    if (argv[i] === "--claim-token") claimToken = requireArg(argv, i, "--claim-token");
  }

  if (!forMemberId) die("--for is required (or set ROBOPPI_AGENTS_MEMBER_ID)");

  // Spec 3.5: path safety
  await assertAgentsRootSafe(contextDir);
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

async function handleMessageReply(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let forMemberId = resolveEnvDefault(argv, "--for", "ROBOPPI_AGENTS_MEMBER_ID") ?? "";
  let claimToken = "";
  let topic = "";
  let body = "";
  let kind: string | undefined;
  let useJsonStdin = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--for") forMemberId = requireArg(argv, i, "--for");
    if (argv[i] === "--claim-token") claimToken = requireArg(argv, i, "--claim-token");
    if (argv[i] === "--topic") topic = requireArg(argv, i, "--topic");
    if (argv[i] === "--body") body = requireArg(argv, i, "--body");
    if (argv[i] === "--kind") kind = requireArg(argv, i, "--kind");
    if (argv[i] === "--json-stdin") useJsonStdin = true;
  }

  if (useJsonStdin) {
    const input = await readJsonStdin() as Record<string, unknown>;
    forMemberId = (input.for as string) ?? forMemberId;
    claimToken = (input.claim_token as string) ?? claimToken;
    topic = (input.topic as string) ?? topic;
    body = (input.body as string) ?? body;
    kind = (input.kind as string) ?? kind;
  }

  if (!forMemberId) die("--for is required (or set ROBOPPI_AGENTS_MEMBER_ID)");
  if (!claimToken) die("--claim-token is required");
  if (!body) die("--body is required");

  // Spec 3.5: path safety
  await assertAgentsRootSafe(contextDir);
  validateMemberIdPath(forMemberId);

  const sender = await validateFromMember(contextDir, forMemberId);
  const team = await readTeam(contextDir);

  const claimed = await getClaimedMessageByClaimToken(contextDir, forMemberId, claimToken);
  if (!claimed) {
    jsonOut({ ok: false, error: "Message not found or claim token expired" });
    process.exit(1);
    return;
  }

  const toMemberId = claimed.message.from.member_id;
  validateMemberIdPath(toMemberId);
  await validateMember(contextDir, toMemberId);

  const effectiveTopic = topic || claimed.message.topic;
  if (!effectiveTopic) die("--topic is required (or claimed message has empty topic)");

  const result = await deliverMessage({
    contextDir,
    teamId: team.team_id,
    fromMemberId: forMemberId,
    fromName: sender.name,
    toMemberId,
    topic: effectiveTopic,
    body,
    kind: kind as MessageKind | undefined,
    correlationId: (claimed.message.correlation_id as string | null) ?? claimed.message.message_id,
    replyTo: claimed.message.message_id,
  });

  const acked = await ackMessageByClaimToken(contextDir, forMemberId, claimToken);
  if (!acked) {
    jsonOut({ ok: false, error: "Reply delivered but failed to ack claimed message" });
    process.exit(1);
    return;
  }

  jsonOut({
    ok: true,
    message_id: result.messageId,
    delivered: [toMemberId],
    reply_to: claimed.message.message_id,
    acked: true,
  });
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
  await assertAgentsRootSafe(contextDir);
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
  let memberId = resolveEnvDefault(argv, "--member", "ROBOPPI_AGENTS_MEMBER_ID") ?? "";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task-id") taskId = requireArg(argv, i, "--task-id");
    if (argv[i] === "--member") memberId = requireArg(argv, i, "--member");
  }

  if (!taskId) die("--task-id is required");
  if (!memberId) die("--member is required (or set ROBOPPI_AGENTS_MEMBER_ID)");

  // Spec 3.5: path safety
  await assertAgentsRootSafe(contextDir);
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
  let memberId = resolveEnvDefault(argv, "--member", "ROBOPPI_AGENTS_MEMBER_ID") ?? "";
  const artifacts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task-id") taskId = requireArg(argv, i, "--task-id");
    if (argv[i] === "--member") memberId = requireArg(argv, i, "--member");
    if (argv[i] === "--artifact") artifacts.push(requireArg(argv, i, "--artifact"));
  }

  if (!taskId) die("--task-id is required");
  if (!memberId) die("--member is required (or set ROBOPPI_AGENTS_MEMBER_ID)");

  // Spec 3.5: path safety
  await assertAgentsRootSafe(contextDir);
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
  await assertAgentsRootSafe(contextDir);

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

async function handleChat(argv: string[]): Promise<void> {
  const contextDir = resolveContextDir(argv);
  let memberId = "human";
  let pollMs = DEFAULT_CHAT_POLL_INTERVAL_MS;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--as") memberId = requireArg(argv, i, "--as");
    if (argv[i] === "--poll-ms") {
      const raw = requireArg(argv, i, "--poll-ms");
      pollMs = parseInt(raw, 10);
      if (!Number.isInteger(pollMs) || pollMs < 100) {
        die("--poll-ms must be an integer >= 100");
      }
    }
  }

  // Spec 3.5: path safety
  await assertAgentsRootSafe(contextDir);
  validateMemberIdPath(memberId);

  await runChat({ contextDir, memberId, pollMs });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const AGENTS_HELP = `
roboppi agents — agent team coordination tools

USAGE
  roboppi agents init --context <dir> --team <name> [--json-stdin]
  roboppi agents members list --context <dir>
  roboppi agents members set --context <dir> --json-stdin
  roboppi agents members upsert --context <dir> --member <id> --agent <agentId> [--name <n>] [--role <r>]
  roboppi agents members remove --context <dir> --member <id>
  roboppi agents message send --context <dir> --from <id> --to <id> --topic <t> --body <text>
  roboppi agents message broadcast --context <dir> --from <id> --topic <t> --body <text>
  roboppi agents message recv --context <dir> --for <id> [--claim] [--max N] [--wait-ms M]
  roboppi agents message ack --context <dir> --for <id> --message-id <uuid>|--claim-token <token>
  roboppi agents message reply --context <dir> --for <id> --claim-token <token> --body <text> [--topic <t>] [--kind <k>] [--json-stdin]
  roboppi agents tasks add --context <dir> --title <t> --description <d> [--json-stdin]
  roboppi agents tasks list --context <dir> [--status pending|in_progress|completed|blocked]
  roboppi agents tasks claim --context <dir> --task-id <uuid> --member <id>
  roboppi agents tasks complete --context <dir> --task-id <uuid> --member <id> [--artifact <p>]
  roboppi agents chat --context <dir> [--as <member-id>] [--poll-ms <N>]
  roboppi agents housekeep --context <dir>

NOTES
  All stdout output is JSON-only for deterministic tool use.
  --context defaults to ROBOPPI_AGENTS_CONTEXT_DIR env var.
  --from/--for/--member defaults to ROBOPPI_AGENTS_MEMBER_ID env var.
  Body-heavy commands support --json-stdin to read input from stdin.
  members set|upsert|remove require ROBOPPI_AGENTS_MEMBER_ID to match the lead.
`.trim();

export async function runAgentsCli(argv: string[]): Promise<void> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stderr.write(AGENTS_HELP + "\n");
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
        switch (rest[0]) {
          case "list":
            await handleMembersList(rest.slice(1));
            break;
          case "set":
            await handleMembersSet(rest.slice(1));
            break;
          case "upsert":
            await handleMembersUpsert(rest.slice(1));
            break;
          case "remove":
            await handleMembersRemove(rest.slice(1));
            break;
          default:
            die(`Unknown members subcommand: ${rest[0]}. Use: list|set|upsert|remove`);
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
          case "reply":
            await handleMessageReply(rest.slice(1));
            break;
          default:
            die(`Unknown message subcommand: ${rest[0]}. Use: send|broadcast|recv|ack|reply`);
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

      case "chat":
        await handleChat(rest);
        break;

      case "housekeep":
        await handleHousekeep(rest);
        break;

      default:
        die(`Unknown agents subcommand: ${sub}\n${AGENTS_HELP}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    jsonOut({ ok: false, error: msg });
    process.exit(1);
  }
}
