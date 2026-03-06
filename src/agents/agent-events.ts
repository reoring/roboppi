/**
 * Agent lifecycle event log — survives mailbox/tasks cleanup.
 *
 * Events are written to `<context_dir>/_agents/_events.jsonl` (at the agents
 * root level, separate from `mailbox/_events.jsonl` and `tasks/_events.jsonl`).
 *
 * See `docs/spec/agents.md` §3.2: the final cleanup event MUST survive
 * mailbox/tasks deletion.
 */
import { atomicJsonlAppend } from "./fs-atomic.js";
import { agentEventsPath } from "./paths.js";

export interface AgentLifecycleEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

export async function appendAgentEvent(
  contextDir: string,
  event: AgentLifecycleEvent,
): Promise<void> {
  await atomicJsonlAppend(agentEventsPath(contextDir), event);
}
