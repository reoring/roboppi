/**
 * Agent Overview tab — status, uptime, and recent activity for an agent.
 */
import type { WorkflowUiState, StepUiState, AgentActivityEntry, AgentRosterEntry } from "../../state-store.js";
import { sanitizeForTui, ansiTruncate, ansiWrap } from "../../ansi-utils.js";

export function renderAgentOverviewTab(
  state: WorkflowUiState,
  step: StepUiState | undefined,
  roster: AgentRosterEntry | undefined,
  memberId: string,
  width: number,
  height: number,
): string {
  const lines: string[] = [];

  if (!step && !roster) {
    lines.push("\x1b[90mNo agent selected\x1b[0m");
    return padLines(lines, height);
  }

  const runtimeStatus =
    step && (step.status === "RUNNING" || step.status === "CHECKING")
      ? step.status
      : (roster?.role === "dormant" ? "DORMANT" : "IDLE");
  const runtimePhase =
    step && (step.status === "RUNNING" || step.status === "CHECKING")
      ? step.phase
      : (roster?.role === "dormant" ? "sleeping" : "idle");
  const displayName = roster?.name ?? memberId;
  const runtime = state.agentRuntime.get(memberId);

  // Agent identity
  lines.push(`\x1b[1mAgent:\x1b[0m   \x1b[36m${sanitizeForTui(displayName)}\x1b[0m`);
  if (roster?.agentId) {
    lines.push(`\x1b[1mProfile:\x1b[0m ${sanitizeForTui(roster.agentId)}`);
  }
  if (roster?.role) {
    lines.push(`\x1b[1mRole:\x1b[0m    ${sanitizeForTui(roster.role)}`);
  }

  // Status
  const statusColor = getStatusColor(runtimeStatus);
  lines.push(`\x1b[1mStatus:\x1b[0m  ${statusColor}${runtimeStatus}\x1b[0m`);

  // Uptime
  if (step?.startedAt) {
    const elapsed = (step.completedAt ?? Date.now()) - step.startedAt;
    lines.push(`\x1b[1mUptime:\x1b[0m  ${formatMs(elapsed)}`);
  }

  // Phase
  if (runtimePhase) {
    lines.push(`\x1b[1mPhase:\x1b[0m   \x1b[90m${sanitizeForTui(runtimePhase)}\x1b[0m`);
  }

  // Error
  if (step?.error) {
    lines.push(`\x1b[31m\x1b[1mError:\x1b[0m   ${sanitizeForTui(step.error)}`);
  }

  lines.push("");
  lines.push("\x1b[1m\u2500\u2500 Runtime \u2500\u2500\x1b[0m");
  lines.push(`\x1b[1mDispatches:\x1b[0m ${runtime?.dispatchCount ?? 0}`);
  lines.push(`\x1b[1mRestarts:\x1b[0m   ${runtime?.restartCount ?? 0}`);
  const totalEstimatedTokens = runtime?.totalEstimatedTokens ?? 0;
  if (totalEstimatedTokens > 0) {
    const lastTokens = runtime?.lastEstimatedTokens !== undefined
      ? ` (last ${formatCompactCount(runtime.lastEstimatedTokens)})`
      : "";
    lines.push(`\x1b[1mTokens:\x1b[0m     ${formatCompactCount(totalEstimatedTokens)}${lastTokens}`);
  }
  const totalInstructionBytes = runtime?.totalInstructionBytes ?? 0;
  if (totalInstructionBytes > 0) {
    const lastBytes = runtime?.lastInstructionBytes !== undefined
      ? ` (last ${formatBytes(runtime.lastInstructionBytes)})`
      : "";
    lines.push(`\x1b[1mPrompt:\x1b[0m     ${formatBytes(totalInstructionBytes)}${lastBytes}`);
  }
  if (runtime?.lastStartedAt) {
    lines.push(`\x1b[1mLast Start:\x1b[0m ${formatTs(runtime.lastStartedAt)}`);
  }
  if (runtime?.lastStoppedAt) {
    lines.push(`\x1b[1mLast Stop:\x1b[0m  ${formatTs(runtime.lastStoppedAt)}`);
  }
  if (runtime?.currentlyDispatchingSince) {
    lines.push(`\x1b[1mDispatch:\x1b[0m   running since ${formatTs(runtime.currentlyDispatchingSince)}`);
  } else if (runtime?.lastDispatchStartedAt) {
    const finish = runtime.lastDispatchFinishedAt
      ? ` -> ${formatTs(runtime.lastDispatchFinishedAt)}`
      : "";
    const duration = runtime.lastDispatchDurationMs !== undefined
      ? ` (${formatMs(runtime.lastDispatchDurationMs)})`
      : "";
    lines.push(`\x1b[1mDispatch:\x1b[0m   ${formatTs(runtime.lastDispatchStartedAt)}${finish}${duration}`);
  }
  if (runtime && runtime.totalDispatchActiveMs > 0) {
    lines.push(`\x1b[1mBusy Time:\x1b[0m  ${formatMs(runtime.totalDispatchActiveMs)}`);
  }

  const instructionText = runtime?.currentInstructions ?? runtime?.lastInstructions;
  if (instructionText) {
    lines.push("");
    lines.push(
      runtime?.currentInstructions
        ? "\x1b[1m\u2500\u2500 Current Instructions \u2500\u2500\x1b[0m"
        : "\x1b[1m\u2500\u2500 Last Instructions \u2500\u2500\x1b[0m",
    );
    appendWrappedBlock(lines, instructionText, width, height);
  }

  // Current Output section
  const stdoutLines = step?.logs.stdout.lines() ?? [];
  if (stdoutLines.length > 0) {
    lines.push("");
    lines.push("\x1b[1m\u2500\u2500 Current Output \u2500\u2500\x1b[0m");
    const recent = stdoutLines.slice(-5);
    for (const line of recent) {
      lines.push(`  ${ansiTruncate(sanitizeForTui(line), Math.max(0, width - 2), { ellipsis: "..." })}`);
    }
  }

  // Modified Files section
  if (step && step.patches.byFilePath.size > 0) {
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
    case "agent_task_superseded":
      line = `  \x1b[90m${time}\x1b[0m \x1b[35m\u21BA\x1b[0m Superseded ${entry.label ?? entry.id}`;
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
    case "CHECKING": return "\x1b[35m";
    case "SUCCEEDED": return "\x1b[32m";
    case "FAILED": return "\x1b[31m";
    case "IDLE": return "\x1b[36m";
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)}KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)}MiB`;
}

function formatCompactCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function appendWrappedBlock(
  lines: string[],
  text: string,
  width: number,
  height: number,
): void {
  const maxWidth = Math.max(8, width - 2);
  const maxLines = Math.max(3, Math.min(18, height - lines.length - 8));
  const wrapped: string[] = [];

  for (const rawLine of sanitizeForTui(text).split("\n")) {
    const chunks = ansiWrap(rawLine, maxWidth);
    if (chunks.length === 0) {
      wrapped.push("");
      continue;
    }
    wrapped.push(...chunks);
  }

  const visible = wrapped.slice(0, maxLines);
  for (const line of visible) {
    lines.push(`  ${line}`);
  }
  if (wrapped.length > maxLines) {
    lines.push("  \x1b[90m...\x1b[0m");
  }
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
