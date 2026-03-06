/**
 * Agent event log operations.
 *
 * Appends metadata-only events to `_events.jsonl` files.  Bodies are NOT
 * included by default (secret-safe per `docs/features/agents.md` §10.1).
 *
 * Concurrency safety: we use O_APPEND writes which are atomic for
 * payloads below the OS page size (~4 KB).  Each event entry is well
 * under that limit so concurrent appenders will not interleave.
 */
import { atomicJsonlAppend } from "./fs-atomic.js";
import { mailboxEventsPath, tasksEventsPath } from "./paths.js";
import type { MailboxEvent, TaskEvent } from "./types.js";

export async function appendMailboxEvent(
  contextDir: string,
  event: MailboxEvent,
): Promise<void> {
  await atomicJsonlAppend(mailboxEventsPath(contextDir), event);
}

export async function appendTaskEvent(
  contextDir: string,
  event: TaskEvent,
): Promise<void> {
  await atomicJsonlAppend(tasksEventsPath(contextDir), event);
}
