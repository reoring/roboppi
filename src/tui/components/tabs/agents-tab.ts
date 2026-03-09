/**
 * Agents tab — displays agent activity entries (metadata-only).
 *
 * Shows recent messages and task events without message bodies or
 * task descriptions (secret-safe per docs/features/agents.md §10.1).
 */
import type { WorkflowUiState, AgentActivityEntry, AgentRuntimeStats, StepUiState } from "../../state-store.js";
import { agentMemberId, agentStepId } from "../../state-store.js";
import { ansiTruncate, ansiWrap, sanitizeForTui } from "../../ansi-utils.js";

export function renderAgentsTab(
  state: WorkflowUiState,
  width: number,
  height: number,
  filterMemberId?: string,
): string {
  const lines: string[] = [];
  const entries = filterMemberId
    ? state.agentEntries.filter((e) => e.memberId === filterMemberId || e.targetMemberId === filterMemberId)
    : state.agentEntries;
  const hasActivity = entries.length > 0 || state.agentActivity.lines().length > 0;
  const title = filterMemberId
    ? `Activity: ${sanitizeForTui(filterMemberId)}`
    : "Agents";
  lines.push(`\x1b[1m${title}\x1b[0m`);
  lines.push("");

  if (!filterMemberId) {
    const summaryLines = renderAgentSummarySection(state, width, height - lines.length, hasActivity);
    for (const line of summaryLines) lines.push(line);
  }

  if (hasActivity && lines.length < height) {
    lines.push("\x1b[1mRecent Activity\x1b[0m");
    lines.push("");
  }

  if (entries.length === 0 && state.agentActivity.lines().length === 0) {
    if (lines.length <= 2) {
      lines.push("\x1b[90mNo agent activity yet\x1b[0m");
    }
    return padLines(lines, height);
  }

  // Show structured entries (most recent last)
  const target = Math.max(0, height - lines.length);
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
    case "agent_task_superseded":
      return `\x1b[90m${time}\x1b[0m \x1b[35m↺\x1b[0m \x1b[33m${entry.memberId}\x1b[0m superseded${topic}`;
    default:
      return `\x1b[90m${time}\x1b[0m ${entry.type} ${entry.memberId}${topic}`;
  }
}

interface AgentSummaryRow {
  memberId: string;
  name: string;
  role?: string;
  status: string;
  dispatchCount: number;
  restartCount: number;
  totalEstimatedTokens?: number;
  totalInstructionBytes?: number;
  busyMs: number;
  lastStartedAt?: number;
  lastStoppedAt?: number;
  lastSeenAt?: number;
}

function renderAgentSummarySection(
  state: WorkflowUiState,
  width: number,
  remainingHeight: number,
  hasActivity: boolean,
): string[] {
  const summaries = collectAgentSummaryRows(state);
  if (summaries.length === 0 || remainingHeight < 7) return [];

  const lines: string[] = [];
  const sectionOverhead = 4;
  const activityReserve = hasActivity ? 3 : 0;
  const maxRows = Math.min(
    summaries.length,
    Math.max(1, remainingHeight - sectionOverhead - activityReserve),
  );
  if (maxRows <= 0) return [];

  const showStop = width >= 96;
  const showUsage = width >= 100;
  const reservedWidth = showStop
    ? (showUsage ? 63 : 44)
    : (showUsage ? 54 : 35);
  const agentWidth = Math.max(10, Math.min(showStop ? 24 : 32, width - reservedWidth));
  const header =
    `${pad("Agent", agentWidth)} ${pad("State", 8)} ${padStart("Disp", 4)} ${padStart("Re", 3)}`
    + (showUsage ? ` ${padStart("Tok", 7)} ${padStart("Prompt", 7)}` : "")
    + ` ${padStart("Busy", 7)} ${pad("Start", 8)}`
    + (showStop ? ` ${pad("Stop", 8)}` : "");

  lines.push("\x1b[1mAgent Summary\x1b[0m");
  lines.push(ansiTruncate(header, Math.max(0, width), { ellipsis: "..." }));
  lines.push(`\x1b[90m${"-".repeat(Math.max(0, Math.min(width, stripAnsiLength(header))))}\x1b[0m`);

  for (const row of summaries.slice(0, maxRows)) {
    const line =
      `${pad(truncatePlain(row.name, agentWidth), agentWidth)} ${pad(row.status, 8)} ${padStart(String(row.dispatchCount), 4)} ${padStart(String(row.restartCount), 3)}`
      + (showUsage
        ? ` ${padStart(formatCompactCount(row.totalEstimatedTokens), 7)} ${padStart(formatBytesCompact(row.totalInstructionBytes), 7)}`
        : "")
      + ` ${padStart(formatCompactMs(row.busyMs), 7)} ${pad(formatShortTs(row.lastStartedAt), 8)}`
      + (showStop ? ` ${pad(formatShortTs(row.lastStoppedAt), 8)}` : "");
    lines.push(ansiTruncate(line, Math.max(0, width), { ellipsis: "..." }));
  }

  if (summaries.length > maxRows) {
    lines.push(`\x1b[90m+${summaries.length - maxRows} more agents\x1b[0m`);
  }

  lines.push("");
  return lines;
}

function collectAgentSummaryRows(state: WorkflowUiState): AgentSummaryRow[] {
  const memberIds = new Set<string>();

  for (const memberId of state.agentRosterOrder) memberIds.add(memberId);
  for (const memberId of state.agentRuntime.keys()) memberIds.add(memberId);
  for (const stepId of state.stepOrder) {
    const memberId = agentMemberId(stepId);
    if (memberId) memberIds.add(memberId);
  }
  for (const entry of state.agentEntries) {
    memberIds.add(entry.memberId);
    if (entry.targetMemberId) memberIds.add(entry.targetMemberId);
  }

  const rows: AgentSummaryRow[] = [];
  for (const memberId of memberIds) {
    const roster = state.agentRoster.get(memberId);
    const runtime = state.agentRuntime.get(memberId);
    const step = state.steps.get(agentStepId(memberId));
    const status = getAgentStatus(step, roster?.role);
    const busyMs = getBusyMs(runtime);
    const activityTs = getLatestActivityTs(state.agentEntries, memberId);
    const lastSeenAt = maxTs(
      activityTs,
      runtime?.lastStartedAt,
      runtime?.lastStoppedAt,
      runtime?.lastDispatchFinishedAt,
      runtime?.currentlyDispatchingSince,
      step?.startedAt,
      step?.completedAt,
    );

    rows.push({
      memberId,
      name: roster?.name ?? memberId,
      role: roster?.role,
      status,
      dispatchCount: runtime?.dispatchCount ?? 0,
      restartCount: runtime?.restartCount ?? 0,
      totalEstimatedTokens: runtime?.totalEstimatedTokens,
      totalInstructionBytes: runtime?.totalInstructionBytes,
      busyMs,
      lastStartedAt: runtime?.lastStartedAt,
      lastStoppedAt: runtime?.lastStoppedAt,
      lastSeenAt,
    });
  }

  return rows.sort((a, b) => {
    const statusCmp = getStatusRank(a.status) - getStatusRank(b.status);
    if (statusCmp !== 0) return statusCmp;
    const seenCmp = (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
    if (seenCmp !== 0) return seenCmp;
    return a.memberId.localeCompare(b.memberId);
  });
}

function getAgentStatus(step: StepUiState | undefined, role?: string): string {
  if (step && (step.status === "RUNNING" || step.status === "CHECKING")) {
    return step.status;
  }
  if (role === "dormant") {
    return "DORMANT";
  }
  return "IDLE";
}

function getBusyMs(runtime: AgentRuntimeStats | undefined): number {
  if (!runtime) return 0;
  let total = runtime.totalDispatchActiveMs;
  if (runtime.currentlyDispatchingSince !== undefined) {
    total += Math.max(0, Date.now() - runtime.currentlyDispatchingSince);
  }
  return total;
}

function getLatestActivityTs(entries: AgentActivityEntry[], memberId: string): number | undefined {
  let latest: number | undefined;
  for (const entry of entries) {
    if (entry.memberId !== memberId && entry.targetMemberId !== memberId) continue;
    latest = latest === undefined ? entry.ts : Math.max(latest, entry.ts);
  }
  return latest;
}

function getStatusRank(status: string): number {
  switch (status) {
    case "RUNNING":
      return 0;
    case "CHECKING":
      return 1;
    case "IDLE":
      return 2;
    case "DORMANT":
      return 3;
    default:
      return 4;
  }
}

function maxTs(...values: Array<number | undefined>): number | undefined {
  let latest: number | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    latest = latest === undefined ? value : Math.max(latest, value);
  }
  return latest;
}

function truncatePlain(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return `${s.slice(0, max - 3)}...`;
}

function pad(s: string, width: number): string {
  return s.padEnd(width, " ");
}

function padStart(s: string, width: number): string {
  return s.padStart(width, " ");
}

function formatCompactMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 100) return `${hours}h${minutes % 60}m`;
  return `${hours}h`;
}

function formatBytesCompact(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return "-";
  if (bytes < 1024) return `${bytes}B`;
  const kib = bytes / 1024;
  if (kib < 1000) return `${Math.round(kib)}K`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)}M`;
}

function formatCompactCount(value: number | undefined): string {
  if (value === undefined || value <= 0) return "-";
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}

function formatShortTs(ts: number | undefined): string {
  if (ts === undefined) return "-";
  return new Date(ts).toISOString().slice(11, 19);
}

function stripAnsiLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
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
