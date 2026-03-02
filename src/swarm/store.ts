/**
 * Swarm Store — file-backed mailbox with maildir semantics.
 *
 * Mechanism-grade: atomic rename for deliver/claim/ack, tmp+rename for
 * writes.  See `docs/features/swarm.md` §5.
 */
import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { atomicJsonWrite } from "./fs-atomic.js";
import { appendMailboxEvent } from "./events.js";
import {
  swarmRoot,
  teamJsonPath,
  membersJsonPath,
  mailboxTmp,
  inboxNew,
  inboxProcessing,
  inboxCur,
  allDirs,
} from "./paths.js";
import { MAX_MESSAGE_BYTES, DEFAULT_CLAIM_TOKEN_TTL_MS } from "./constants.js";
import type {
  TeamConfig,
  MembersConfig,
  SwarmMessage,
  MemberEntry,
} from "./types.js";

// ---------------------------------------------------------------------------
// Schema validation helpers (lightweight, no deps)
// ---------------------------------------------------------------------------

function assertTeamConfig(data: unknown): asserts data is TeamConfig {
  const d = data as Record<string, unknown>;
  if (d.version !== "1") throw new Error(`Unsupported team.json version: ${d.version}`);
  if (typeof d.team_id !== "string") throw new Error("team.json: missing team_id");
  if (typeof d.name !== "string") throw new Error("team.json: missing name");
}

function assertMembersConfig(data: unknown): asserts data is MembersConfig {
  const d = data as Record<string, unknown>;
  if (d.version !== "1") throw new Error(`Unsupported members.json version: ${d.version}`);
  if (!Array.isArray(d.members)) throw new Error("members.json: missing members array");
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export interface InitSwarmOptions {
  contextDir: string;
  teamName: string;
  teamId?: string;
  leadMemberId: string;
  members: MemberEntry[];
  cleanupPolicy?: { retain_mailbox?: boolean; retain_tasks?: boolean };
}

/**
 * Create `<context_dir>/_swarm/` layout idempotently.
 * Writes `team.json` and `members.json`.
 */
export async function initSwarmContext(opts: InitSwarmOptions): Promise<{
  teamId: string;
}> {
  const memberIds = opts.members.map((m) => m.member_id);

  // Create all directories
  for (const dir of allDirs(opts.contextDir, memberIds)) {
    await mkdir(dir, { recursive: true });
  }

  // Stable-idempotent: if team.json already exists, preserve the existing
  // team_id and created_at so that repeated init calls do not split the
  // mailbox into multiple team ids.
  let teamId = opts.teamId ?? randomUUID();
  let createdAt = Date.now();
  try {
    const existing = await readTeam(opts.contextDir);
    teamId = opts.teamId ?? existing.team_id;
    createdAt = existing.created_at;
  } catch {
    // No existing team.json — use new values.
  }

  const team: TeamConfig = {
    version: "1",
    team_id: teamId,
    name: opts.teamName,
    created_at: createdAt,
    context_dir: opts.contextDir,
    lead_member_id: opts.leadMemberId,
    cleanup_policy: {
      retain_mailbox: opts.cleanupPolicy?.retain_mailbox ?? false,
      retain_tasks: opts.cleanupPolicy?.retain_tasks ?? true,
    },
  };

  const members: MembersConfig = {
    version: "1",
    members: opts.members,
  };

  const root = swarmRoot(opts.contextDir);
  const tmpDir = resolve(root, "tmp");
  await mkdir(tmpDir, { recursive: true });

  await atomicJsonWrite(tmpDir, teamJsonPath(opts.contextDir), team);
  await atomicJsonWrite(tmpDir, membersJsonPath(opts.contextDir), members);

  return { teamId };
}

// ---------------------------------------------------------------------------
// Read config
// ---------------------------------------------------------------------------

export async function readTeam(contextDir: string): Promise<TeamConfig> {
  const raw = await readFile(teamJsonPath(contextDir), "utf-8");
  const data = JSON.parse(raw);
  assertTeamConfig(data);
  return data;
}

export async function readMembers(contextDir: string): Promise<MembersConfig> {
  const raw = await readFile(membersJsonPath(contextDir), "utf-8");
  const data = JSON.parse(raw);
  assertMembersConfig(data);
  return data;
}

/**
 * Validate that a memberId exists in `members.json`.
 */
export async function validateMember(
  contextDir: string,
  memberId: string,
): Promise<MemberEntry> {
  const { members } = await readMembers(contextDir);
  const entry = members.find((m) => m.member_id === memberId);
  if (!entry) {
    throw new Error(`Unknown member "${memberId}". Known: ${members.map((m) => m.member_id).join(", ")}`);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Deliver message
// ---------------------------------------------------------------------------

export interface DeliverMessageOptions {
  contextDir: string;
  teamId: string;
  fromMemberId: string;
  fromName: string;
  toMemberId: string;
  kind?: SwarmMessage["kind"];
  topic: string;
  body: string;
  correlationId?: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Write a message file into `inbox/<toMemberId>/new/` via tmp+rename.
 */
export async function deliverMessage(
  opts: DeliverMessageOptions,
): Promise<{ messageId: string }> {
  const bodyBytes = Buffer.byteLength(opts.body, "utf-8");
  if (bodyBytes > MAX_MESSAGE_BYTES) {
    throw new Error(`Message body exceeds max size (${bodyBytes} > ${MAX_MESSAGE_BYTES})`);
  }

  const messageId = randomUUID();
  const ts = Date.now();

  const message: SwarmMessage = {
    version: "1",
    team_id: opts.teamId,
    message_id: messageId,
    ts,
    from: { member_id: opts.fromMemberId, name: opts.fromName },
    to: { type: "member", member_id: opts.toMemberId },
    kind: opts.kind ?? "text",
    topic: opts.topic,
    body: opts.body,
    correlation_id: opts.correlationId ?? null,
    reply_to: opts.replyTo ?? null,
    metadata: opts.metadata,
    delivery_attempt: 1,
  };

  const filename = `${ts}-${messageId}.json`;
  const destPath = resolve(inboxNew(opts.contextDir, opts.toMemberId), filename);
  const tmpDir = mailboxTmp(opts.contextDir);

  await atomicJsonWrite(tmpDir, destPath, message);

  await appendMailboxEvent(opts.contextDir, {
    ts,
    type: "message_delivered",
    message_id: messageId,
    from: opts.fromMemberId,
    to: opts.toMemberId,
    topic: opts.topic,
  });

  return { messageId };
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

export interface BroadcastMessageOptions {
  contextDir: string;
  teamId: string;
  fromMemberId: string;
  fromName: string;
  topic: string;
  body: string;
  kind?: SwarmMessage["kind"];
  metadata?: Record<string, unknown>;
  /** If true, also deliver to the sender. Default: false. */
  includeSelf?: boolean;
}

export async function broadcastMessage(
  opts: BroadcastMessageOptions,
): Promise<{ messageId: string; delivered: string[] }> {
  const bodyBytes = Buffer.byteLength(opts.body, "utf-8");
  if (bodyBytes > MAX_MESSAGE_BYTES) {
    throw new Error(`Message body exceeds max size (${bodyBytes} > ${MAX_MESSAGE_BYTES})`);
  }

  const { members } = await readMembers(opts.contextDir);
  const targets = opts.includeSelf
    ? members
    : members.filter((m) => m.member_id !== opts.fromMemberId);

  // Use a single messageId for the broadcast
  const messageId = randomUUID();
  const ts = Date.now();
  const delivered: string[] = [];

  // Sort targets by member_id for deterministic delivery ordering
  const sortedTargets = [...targets].sort((a, b) => a.member_id.localeCompare(b.member_id));

  for (const member of sortedTargets) {
    const message: SwarmMessage = {
      version: "1",
      team_id: opts.teamId,
      message_id: messageId,
      ts,
      from: { member_id: opts.fromMemberId, name: opts.fromName },
      to: { type: "broadcast" },
      kind: opts.kind ?? "text",
      topic: opts.topic,
      body: opts.body,
      metadata: opts.metadata,
      delivery_attempt: 1,
    };

    const filename = `${ts}-${messageId}.json`;
    const destPath = resolve(inboxNew(opts.contextDir, member.member_id), filename);
    const tmpDir = mailboxTmp(opts.contextDir);

    await atomicJsonWrite(tmpDir, destPath, message);
    delivered.push(member.member_id);

    await appendMailboxEvent(opts.contextDir, {
      ts,
      type: "message_delivered",
      message_id: messageId,
      from: opts.fromMemberId,
      to: member.member_id,
      topic: opts.topic,
    });
  }

  return { messageId, delivered };
}

// ---------------------------------------------------------------------------
// Receive messages
// ---------------------------------------------------------------------------

export interface RecvMessagesOptions {
  contextDir: string;
  memberId: string;
  /** If true, atomically move messages to processing/. */
  claim?: boolean;
  /** Max messages to return. */
  max?: number;
}

export interface ClaimToken {
  token: string;
  expires_at: number;
}

export interface ReceivedMessage {
  messageId: string;
  filename: string;
  message: SwarmMessage;
  claim?: ClaimToken;
}

/**
 * List messages in `inbox/<memberId>/new/` in lexicographic order.
 * Optionally claim (move to `processing/`).
 */
export async function recvMessages(
  opts: RecvMessagesOptions,
): Promise<ReceivedMessage[]> {
  const newDir = inboxNew(opts.contextDir, opts.memberId);
  let entries: string[];
  try {
    entries = await readdir(newDir);
  } catch {
    return [];
  }

  // Lexicographic sort (timestamp prefix ensures chronological)
  entries.sort();
  if (opts.max !== undefined && opts.max > 0) {
    entries = entries.slice(0, opts.max);
  }

  const results: ReceivedMessage[] = [];
  for (const filename of entries) {
    if (!filename.endsWith(".json")) continue;
    const filePath = resolve(newDir, filename);
    try {
      const raw = await readFile(filePath, "utf-8");
      const message = JSON.parse(raw) as SwarmMessage;

      if (opts.claim) {
        const processingDir = inboxProcessing(opts.contextDir, opts.memberId);
        await mkdir(processingDir, { recursive: true });
        const destPath = resolve(processingDir, filename);
        try {
          await rename(filePath, destPath);
        } catch {
          // Another process may have claimed it; skip
          continue;
        }

        // Mint claim token and update claimed_at
        const claimToken = randomUUID();
        const expiresAt = Date.now() + DEFAULT_CLAIM_TOKEN_TTL_MS;
        message.claimed_at = Date.now();
        message.claim_token = claimToken;
        message.claim_token_expires_at = expiresAt;
        const tmpDir = mailboxTmp(opts.contextDir);
        await atomicJsonWrite(tmpDir, destPath, message);

        await appendMailboxEvent(opts.contextDir, {
          ts: Date.now(),
          type: "message_claimed",
          message_id: message.message_id,
          from: message.from.member_id,
          to: opts.memberId,
          topic: message.topic,
          by: opts.memberId,
        });

        results.push({
          messageId: message.message_id,
          filename,
          message,
          claim: { token: claimToken, expires_at: expiresAt },
        });
      } else {
        results.push({
          messageId: message.message_id,
          filename,
          message,
        });
      }
    } catch {
      // Corrupted or racing — skip
      continue;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Claim (standalone, without recv)
// ---------------------------------------------------------------------------

/**
 * Atomically move a specific message from `new/` to `processing/`.
 * Returns a claim token on success for use with `ackMessageByClaimToken()`.
 */
export async function claimMessage(
  contextDir: string,
  memberId: string,
  messageId: string,
): Promise<{ ok: boolean; claim?: ClaimToken }> {
  const newDir = inboxNew(contextDir, memberId);
  let entries: string[];
  try {
    entries = await readdir(newDir);
  } catch {
    return { ok: false };
  }

  const filename = entries.find((f) => f.includes(messageId));
  if (!filename) return { ok: false };

  const src = resolve(newDir, filename);
  const processingDir = inboxProcessing(contextDir, memberId);
  await mkdir(processingDir, { recursive: true });
  const dest = resolve(processingDir, filename);

  try {
    await rename(src, dest);
  } catch {
    return { ok: false };
  }

  // Mint claim token and update claimed_at
  let from: string | undefined;
  let topic: string | undefined;
  const claimToken = randomUUID();
  const expiresAt = Date.now() + DEFAULT_CLAIM_TOKEN_TTL_MS;
  try {
    const raw = await readFile(dest, "utf-8");
    const message = JSON.parse(raw) as SwarmMessage;
    message.claimed_at = Date.now();
    message.claim_token = claimToken;
    message.claim_token_expires_at = expiresAt;
    from = message.from.member_id;
    topic = message.topic;
    const tmpDir = mailboxTmp(contextDir);
    await atomicJsonWrite(tmpDir, dest, message);
  } catch {
    // non-critical
  }

  await appendMailboxEvent(contextDir, {
    ts: Date.now(),
    type: "message_claimed",
    message_id: messageId,
    from,
    to: memberId,
    topic,
    by: memberId,
  });

  return { ok: true, claim: { token: claimToken, expires_at: expiresAt } };
}

// ---------------------------------------------------------------------------
// Ack
// ---------------------------------------------------------------------------

/**
 * Atomically move a message from `processing/` to `cur/` by message ID.
 */
export async function ackMessage(
  contextDir: string,
  memberId: string,
  messageId: string,
): Promise<boolean> {
  const processingDir = inboxProcessing(contextDir, memberId);
  let entries: string[];
  try {
    entries = await readdir(processingDir);
  } catch {
    return false;
  }

  const filename = entries.find((f) => f.includes(messageId));
  if (!filename) return false;

  return ackMessageFile(contextDir, memberId, filename, messageId);
}

/**
 * Ack a message by its claim token (no directory scan by messageId).
 * Scans processing/ for a file whose JSON contains a matching claim_token.
 */
export async function ackMessageByClaimToken(
  contextDir: string,
  memberId: string,
  claimToken: string,
): Promise<boolean> {
  const processingDir = inboxProcessing(contextDir, memberId);
  let entries: string[];
  try {
    entries = await readdir(processingDir);
  } catch {
    return false;
  }

  for (const filename of entries) {
    if (!filename.endsWith(".json")) continue;
    try {
      const raw = await readFile(resolve(processingDir, filename), "utf-8");
      const message = JSON.parse(raw) as SwarmMessage;
      if (message.claim_token === claimToken) {
        // Best-effort expiry check
        if (message.claim_token_expires_at && Date.now() > message.claim_token_expires_at) {
          return false; // token expired
        }
        return ackMessageFile(contextDir, memberId, filename, message.message_id);
      }
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * Internal: move a specific message file from processing/ to cur/.
 */
async function ackMessageFile(
  contextDir: string,
  memberId: string,
  filename: string,
  messageId: string,
): Promise<boolean> {
  const processingDir = inboxProcessing(contextDir, memberId);
  const src = resolve(processingDir, filename);
  const curDir = inboxCur(contextDir, memberId);
  await mkdir(curDir, { recursive: true });
  const dest = resolve(curDir, filename);

  // Read metadata before moving for event enrichment
  let from: string | undefined;
  let topic: string | undefined;
  try {
    const raw = await readFile(src, "utf-8");
    const message = JSON.parse(raw) as SwarmMessage;
    from = message.from.member_id;
    topic = message.topic;
  } catch {
    // non-critical
  }

  try {
    await rename(src, dest);
  } catch {
    return false;
  }

  await appendMailboxEvent(contextDir, {
    ts: Date.now(),
    type: "message_acked",
    message_id: messageId,
    from,
    to: memberId,
    topic,
    by: memberId,
  });

  return true;
}
