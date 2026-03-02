/**
 * Swarm lifecycle event log — survives mailbox/tasks cleanup.
 *
 * Events are written to `<context_dir>/_swarm/_events.jsonl` (at the swarm
 * root level, separate from `mailbox/_events.jsonl` and `tasks/_events.jsonl`).
 *
 * See `docs/spec/swarm.md` §3.2: the final cleanup event MUST survive
 * mailbox/tasks deletion.
 */
import { atomicJsonlAppend } from "./fs-atomic.js";
import { swarmEventsPath } from "./paths.js";

export interface SwarmLifecycleEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

export async function appendSwarmEvent(
  contextDir: string,
  event: SwarmLifecycleEvent,
): Promise<void> {
  await atomicJsonlAppend(swarmEventsPath(contextDir), event);
}
