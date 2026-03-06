/**
 * Agent Overview tab — status, uptime, and recent activity for an agent.
 */
import type { WorkflowUiState, StepUiState, AgentActivityEntry } from "../../state-store.js";
import { sanitizeForTui, ansiTruncate } from "../../ansi-utils.js";

export function renderAgentOverviewTab(
  state: WorkflowUiState,
  step: StepUiState | undefined,
  memberId: string,
  width: number,
  height: number,
): string {
  const lines: string[] = [];

  if (!step) {
    lines.push("\x1b[90mNo agent selected\x1b[0m");
    return padLines(lines, height);
  }

  // Agent identity
  lines.push(`\x1b[1mAgent:\x1b[0m   \x1b[36m${sanitizeForTui(memberId)}\x1b[0m`);

  // Status
  const statusColor = getStatusColor(step.status);
  lines.push(`\x1b[1mStatus:\x1b[0m  ${statusColor}${step.status}\x1b[0m`);

  // Uptime
  if (step.startedAt) {
    const elapsed = (step.completedAt ?? Date.now()) - step.startedAt;
    lines.push(`\x1b[1mUptime:\x1b[0m  ${formatMs(elapsed)}`);
  }

  // Phase
  if (step.phase) {
    lines.push(`\x1b[1mPhase:\x1b[0m   \x1b[90m${sanitizeForTui(step.phase)}\x1b[0m`);
  }

  // Error
  if (step.error) {
    lines.push(`\x1b[31m\x1b[1mError:\x1b[0m   ${sanitizeForTui(step.error)}`);
  }

  // Current Output section
  const stdoutLines = step.logs.stdout.lines();
  if (stdoutLines.length > 0) {
    lines.push("");
    lines.push("\x1b[1m\u2500\u2500 Current Output \u2500\u2500\x1b[0m");
    const recent = stdoutLines.slice(-5);
    for (const line of recent) {
      lines.push(`  ${ansiTruncate(sanitizeForTui(line), Math.max(0, width - 2), { ellipsis: "..." })}`);
    }
  }

  // Modified Files section
  if (step.patches.byFilePath.size > 0) {
    lines.push("");
    lines.push("\x1b[1m\u2500\u2500 Modified Files \u2500\u2500\x1b[0m");
    for (const [filePath, patchIds] of step.patches.byFilePath) {
      const count = patchIds.length > 1 ? ` (${patchIds.length})` : "";
      lines.push(`  ${sanitizeForTui(filePath)}${count}`);
    }
  }

  // Recent activity section
  lines.push("");
  lines.push("\x1b[1m\u2500\u2500 Recent Activity \u2500\u2500\x1b[0m");

  const agentEntries = state.agentEntries.filter(
    (e) => e.memberId === memberId || e.targetMemberId === memberId,
  );

  if (agentEntries.length === 0) {
    lines.push("\x1b[90mNo activity yet\x1b[0m");
  } else {
    const remaining = Math.max(0, height - lines.length);
    const recent = agentEntries.slice(-remaining).reverse();
    for (const entry of recent) {
      lines.push(formatActivityLine(entry, width));
    }
  }

  return padLines(lines, height);
}

function formatActivityLine(entry: AgentActivityEntry, width: number): string {
  const time = new Date(entry.ts).toISOString().slice(11, 19);
  let line: string;

  switch (entry.type) {
    case "agent_message_sent": {
      const target = entry.targetMemberId ?? "?";
      line = `  \x1b[90m${time}\x1b[0m \x1b[36m\u2192\x1b[0m ${target}${entry.label ? ` topic=${entry.label}` : ""}`;
      break;
    }
    case "agent_message_received": {
      const from = entry.targetMemberId ?? "?";
      line = `  \x1b[90m${time}\x1b[0m \x1b[36m\u2190\x1b[0m ${from}${entry.label ? ` topic=${entry.label}` : ""}`;
      break;
    }
    case "agent_task_claimed":
      line = `  \x1b[90m${time}\x1b[0m \x1b[32m\u25C6\x1b[0m Claimed ${entry.label ?? entry.id}`;
      break;
    case "agent_task_completed":
      line = `  \x1b[90m${time}\x1b[0m \x1b[32m\u2713\x1b[0m Completed ${entry.label ?? entry.id}`;
      break;
    default:
      line = `  \x1b[90m${time}\x1b[0m ${entry.type}`;
      break;
  }

  if (entry.bodyPreview) {
    const preview = sanitizeForTui(entry.bodyPreview).replace(/\n/g, " ");
    line += `\n    \x1b[90m${ansiTruncate(preview, Math.max(0, width - 4), { ellipsis: "..." })}\x1b[0m`;
  }

  return line;
}

function getStatusColor(status: string): string {
  switch (status) {
    case "RUNNING": return "\x1b[33m";
    case "SUCCEEDED": return "\x1b[32m";
    case "FAILED": return "\x1b[31m";
    default: return "\x1b[90m";
  }
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
