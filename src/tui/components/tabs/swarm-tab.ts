/**
 * Swarm tab — displays swarm activity entries (metadata-only).
 *
 * Shows recent messages and task events without message bodies or
 * task descriptions (secret-safe per docs/features/swarm.md §10.1).
 */
import type { WorkflowUiState, SwarmActivityEntry } from "../../state-store.js";
import { ansiWrap, sanitizeForTui } from "../../ansi-utils.js";

export function renderSwarmTab(
  state: WorkflowUiState,
  width: number,
  height: number,
): string {
  const lines: string[] = [];
  lines.push("\x1b[1mSwarm Activity\x1b[0m");
  lines.push("");

  const entries = state.swarmEntries;
  if (entries.length === 0 && state.swarmActivity.lines().length === 0) {
    lines.push("\x1b[90mNo swarm activity yet\x1b[0m");
    return padLines(lines, height);
  }

  // Show structured entries (most recent last)
  const target = Math.max(0, height - 3);
  const physical: string[] = [];

  // Use structured entries for richer display
  const displayEntries = entries.slice(-target);
  for (const entry of displayEntries) {
    const line = formatEntry(entry);
    const safe = sanitizeForTui(line);
    const chunks = ansiWrap(safe, Math.max(0, width));
    for (const chunk of chunks) {
      if (physical.length >= target) break;
      physical.push(chunk);
    }
  }

  // Fall back to summary activity log if no structured entries
  if (physical.length === 0) {
    const activityLines = state.swarmActivity.lines();
    const tail = activityLines.slice(-target);
    for (const l of tail) {
      const safe = sanitizeForTui(l);
      const chunks = ansiWrap(safe, Math.max(0, width));
      for (const chunk of chunks) {
        if (physical.length >= target) break;
        physical.push(`\x1b[90m${chunk}\x1b[0m`);
      }
    }
  }

  for (const l of physical) lines.push(l);

  return padLines(lines, height);
}

function formatEntry(entry: SwarmActivityEntry): string {
  const time = new Date(entry.ts).toISOString().slice(11, 19);
  const label = entry.label ? ` ${entry.label}` : "";

  switch (entry.type) {
    case "swarm_message_sent":
      return `\x1b[90m${time}\x1b[0m \x1b[36m→\x1b[0m \x1b[33m${entry.memberId}\x1b[0m sent${label}`;
    case "swarm_message_received":
      return `\x1b[90m${time}\x1b[0m \x1b[36m←\x1b[0m \x1b[33m${entry.memberId}\x1b[0m recv${label}`;
    case "swarm_task_claimed":
      return `\x1b[90m${time}\x1b[0m \x1b[32m◆\x1b[0m \x1b[33m${entry.memberId}\x1b[0m claimed${label}`;
    case "swarm_task_completed":
      return `\x1b[90m${time}\x1b[0m \x1b[32m✓\x1b[0m \x1b[33m${entry.memberId}\x1b[0m completed${label}`;
    default:
      return `\x1b[90m${time}\x1b[0m ${entry.type} ${entry.memberId}${label}`;
  }
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
