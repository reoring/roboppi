/**
 * Swarm housekeeping — requeue stale processing/ messages, dead-letter,
 * and recover stale in_progress/ tasks.
 *
 * See `docs/features/swarm.md` §5.4 and `docs/spec/swarm.md` §3.3.
 */
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { atomicJsonWrite } from "./fs-atomic.js";
import { appendMailboxEvent, appendTaskEvent } from "./events.js";
import {
  mailboxTmp,
  inboxNew,
  inboxProcessing,
  inboxDead,
  tasksStatusDir,
  tasksTmp,
} from "./paths.js";
import { DEFAULT_PROCESSING_TTL_MS, MAX_DELIVERY_ATTEMPTS } from "./constants.js";
import { readMembers } from "./store.js";
import type { SwarmMessage, SwarmTask } from "./types.js";

export interface HousekeepResult {
  requeued: number;
  deadLettered: number;
  warnings: string[];
}

export interface HousekeepOptions {
  contextDir: string;
  processingTtlMs?: number;
  maxDeliveryAttempts?: number;
}

/**
 * Scan all member inboxes for stale `processing/` messages.
 *
 * - If a message has been in `processing/` beyond the TTL, move it back
 *   to `new/` with incremented `delivery_attempt`.
 * - If `delivery_attempt` exceeds `maxDeliveryAttempts`, move to `dead/`
 *   and emit a warning event.
 */
export async function housekeepMailbox(
  opts: HousekeepOptions,
): Promise<HousekeepResult> {
  const ttl = opts.processingTtlMs ?? DEFAULT_PROCESSING_TTL_MS;
  const maxAttempts = opts.maxDeliveryAttempts ?? MAX_DELIVERY_ATTEMPTS;
  const result: HousekeepResult = { requeued: 0, deadLettered: 0, warnings: [] };

  // Read members to discover all inboxes
  let memberIds: string[];
  try {
    const { members } = await readMembers(opts.contextDir);
    memberIds = members.map((m) => m.member_id);
  } catch {
    result.warnings.push("Could not read members.json; skipping housekeeping");
    return result;
  }

  const now = Date.now();

  for (const memberId of memberIds) {
    const processingDir = inboxProcessing(opts.contextDir, memberId);
    let entries: string[];
    try {
      entries = await readdir(processingDir);
    } catch {
      continue; // no processing/ dir — nothing to do
    }

    for (const filename of entries) {
      if (!filename.endsWith(".json")) continue;
      const filePath = resolve(processingDir, filename);

      // Check staleness via file mtime
      let mtime: number;
      try {
        const s = await stat(filePath);
        mtime = s.mtimeMs;
      } catch {
        continue; // file gone
      }

      if (now - mtime < ttl) continue; // not stale yet

      // Read the message to check delivery attempt
      let message: SwarmMessage;
      try {
        const raw = await readFile(filePath, "utf-8");
        message = JSON.parse(raw) as SwarmMessage;
      } catch {
        continue; // corrupted
      }

      const attempt = (message.delivery_attempt ?? 1) + 1;

      if (attempt > maxAttempts) {
        // Dead-letter: move to dead/
        const deadDir = inboxDead(opts.contextDir, memberId);
        await mkdir(deadDir, { recursive: true });
        const deadPath = resolve(deadDir, filename);
        try {
          await rename(filePath, deadPath);
        } catch {
          continue;
        }

        await appendMailboxEvent(opts.contextDir, {
          ts: now,
          type: "message_dead",
          message_id: message.message_id,
          from: message.from.member_id,
          to: memberId,
          topic: message.topic,
          by: memberId,
          delivery_attempt: attempt,
        });

        result.deadLettered++;
        result.warnings.push(
          `Dead-lettered message ${message.message_id} for ${memberId} after ${attempt} attempts`,
        );
      } else {
        // Requeue: update delivery_attempt, move back to new/
        message.delivery_attempt = attempt;
        message.claimed_at = undefined;
        message.claim_token = undefined;
        message.claim_token_expires_at = undefined;

        const tmpDir = mailboxTmp(opts.contextDir);
        await atomicJsonWrite(tmpDir, filePath, message);

        const newDir = inboxNew(opts.contextDir, memberId);
        await mkdir(newDir, { recursive: true });
        const newPath = resolve(newDir, filename);
        try {
          await rename(filePath, newPath);
        } catch {
          continue;
        }

        await appendMailboxEvent(opts.contextDir, {
          ts: now,
          type: "message_requeued",
          message_id: message.message_id,
          from: message.from.member_id,
          to: memberId,
          topic: message.topic,
          by: memberId,
          delivery_attempt: attempt,
        });

        result.requeued++;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Task housekeeping: stale in_progress recovery (Spec 3.3)
// ---------------------------------------------------------------------------

/** Default task in_progress TTL in ms (10 minutes, matches message processing TTL). */
const DEFAULT_TASK_IN_PROGRESS_TTL_MS = 10 * 60 * 1000;

export interface TaskHousekeepResult {
  requeued: number;
  warnings: string[];
}

export interface TaskHousekeepOptions {
  contextDir: string;
  inProgressTtlMs?: number;
}

/**
 * Scan `tasks/in_progress/` for stale tasks and requeue them to `tasks/pending/`.
 *
 * Staleness is determined by file mtime and/or `claimed_at` timestamp.
 * On requeue, task metadata is atomically updated (status, timestamps, ownership).
 * A metadata-only `task_requeued` event is emitted for audit.
 *
 * The operation is idempotent and race-safe: rename() is atomic, and a
 * concurrent housekeeping run that loses the rename race simply skips.
 */
export async function housekeepTasksInProgress(
  opts: TaskHousekeepOptions,
): Promise<TaskHousekeepResult> {
  const ttl = opts.inProgressTtlMs ?? DEFAULT_TASK_IN_PROGRESS_TTL_MS;
  const result: TaskHousekeepResult = { requeued: 0, warnings: [] };
  const now = Date.now();

  const inProgressDir = tasksStatusDir(opts.contextDir, "in_progress");
  const pendingDir = tasksStatusDir(opts.contextDir, "pending");
  const tmpDir = tasksTmp(opts.contextDir);

  let entries: string[];
  try {
    entries = await readdir(inProgressDir);
  } catch {
    return result; // no in_progress/ dir
  }

  for (const filename of entries) {
    if (!filename.endsWith(".json")) continue;
    const filePath = resolve(inProgressDir, filename);

    // Determine staleness via mtime
    let mtime: number;
    try {
      const s = await stat(filePath);
      mtime = s.mtimeMs;
    } catch {
      continue; // file gone (concurrent claim/complete)
    }

    if (now - mtime < ttl) continue; // not stale

    // Read task to also check claimed_at
    let task: SwarmTask;
    try {
      const raw = await readFile(filePath, "utf-8");
      task = JSON.parse(raw) as SwarmTask;
    } catch {
      continue; // corrupted or racing
    }

    // Double-check staleness via claimed_at if available
    if (task.claimed_at && now - task.claimed_at < ttl) continue;

    // Requeue: update metadata and move back to pending/
    task.status = "pending";
    task.updated_at = now;
    const previousClaimedBy = task.claimed_by;
    task.claimed_by = null;
    task.claimed_at = null;

    await mkdir(tmpDir, { recursive: true });
    await mkdir(pendingDir, { recursive: true });
    await atomicJsonWrite(tmpDir, filePath, task);

    const pendingPath = resolve(pendingDir, filename);
    try {
      await rename(filePath, pendingPath);
    } catch {
      continue; // lost the race to another housekeeping run
    }

    await appendTaskEvent(opts.contextDir, {
      ts: now,
      type: "task_requeued",
      task_id: task.task_id,
      title: task.title,
      by: previousClaimedBy ?? undefined,
    });

    result.requeued++;
    result.warnings.push(
      `Requeued stale task ${task.task_id} (was claimed by ${previousClaimedBy ?? "unknown"})`,
    );
  }

  return result;
}
