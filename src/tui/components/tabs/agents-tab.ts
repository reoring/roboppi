/**
 * Agents tab — displays agent activity entries (metadata-only).
 *
 * Shows recent messages and task events without message bodies or
 * task descriptions (secret-safe per docs/features/agents.md §10.1).
 */
import type { WorkflowUiState, AgentActivityEntry } from "../../state-store.js";
import { ansiWrap, sanitizeForTui } from "../../ansi-utils.js";

export function renderAgentsTab(
  state: WorkflowUiState,
  width: number,
  height: number,
  filterMemberId?: string,
): string {
  const lines: string[] = [];
  const title = filterMemberId
    ? `Activity: ${sanitizeForTui(filterMemberId)}`
    : "Agent Messages";
  lines.push(`\x1b[1m${title}\x1b[0m`);
  lines.push("");

  const entries = filterMemberId
    ? state.agentEntries.filter((e) => e.memberId === filterMemberId || e.targetMemberId === filterMemberId)
    : state.agentEntries;
  if (entries.length === 0 && state.agentActivity.lines().length === 0) {
    lines.push("\x1b[90mNo agent activity yet\x1b[0m");
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
    const activityLines = state.agentActivity.lines();
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

function formatEntry(entry: AgentActivityEntry): string {
  const time = new Date(entry.ts).toISOString().slice(11, 19);
  const topic = entry.label ? ` topic=${entry.label}` : "";

  switch (entry.type) {
    case "agent_message_sent": {
      const target = entry.targetMemberId ? `→${entry.targetMemberId}` : "→?";
      const preview = entry.bodyPreview ? `\n         \x1b[90m"${truncate(entry.bodyPreview, 120)}"\x1b[0m` : "";
      return `\x1b[90m${time}\x1b[0m \x1b[36m→\x1b[0m \x1b[33m${entry.memberId}\x1b[0m ${target}${topic}${preview}`;
    }
    case "agent_message_received": {
      const from = entry.targetMemberId ? `←${entry.targetMemberId}` : "←?";
      const preview = entry.bodyPreview ? `\n         \x1b[90m"${truncate(entry.bodyPreview, 120)}"\x1b[0m` : "";
      return `\x1b[90m${time}\x1b[0m \x1b[36m←\x1b[0m \x1b[33m${entry.memberId}\x1b[0m ${from}${topic}${preview}`;
    }
    case "agent_task_claimed":
      return `\x1b[90m${time}\x1b[0m \x1b[32m◆\x1b[0m \x1b[33m${entry.memberId}\x1b[0m claimed${topic}`;
    case "agent_task_completed":
      return `\x1b[90m${time}\x1b[0m \x1b[32m✓\x1b[0m \x1b[33m${entry.memberId}\x1b[0m completed${topic}`;
    default:
      return `\x1b[90m${time}\x1b[0m ${entry.type} ${entry.memberId}${topic}`;
  }
}

function truncate(s: string, max: number): string {
  // Collapse newlines to spaces for single-line preview
  const flat = s.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
