import type { WorkflowUiState, StepUiState } from "../state-store.js";
import { agentMemberId, agentStepId, getAgentHintText } from "../state-store.js";
import { ansiFit, ansiTruncate, stripAnsi } from "../ansi-utils.js";

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
let spinnerIdx = 0;

const STATUS_ICONS: Record<string, string> = {
  PENDING: "\x1b[90m\u25CB\x1b[0m",
  READY: "\x1b[36m\u25CE\x1b[0m",
  IDLE: "\x1b[36m\u25CE\x1b[0m",
  RUNNING: "\x1b[33m\u25CF\x1b[0m",
  CHECKING: "\x1b[35m\u25C9\x1b[0m",
  SUCCEEDED: "\x1b[32m\u2713\x1b[0m",
  FAILED: "\x1b[31m\u2717\x1b[0m",
  INCOMPLETE: "\x1b[90m\u25D1\x1b[0m",
  SKIPPED: "\x1b[90m\u2298\x1b[0m",
  CANCELLED: "\x1b[31m\u2298\x1b[0m",
  DORMANT: "\x1b[90m\u263E\x1b[0m",
};

export type LeftPaneEntry =
  | { kind: "step"; stepId: string }
  | { kind: "separator"; label: string }
  | { kind: "agent"; stepId: string; memberId: string };

/**
 * Build left-pane entries from state, splitting steps and agents
 * into two sections separated by a divider.
 */
export function buildLeftPaneEntries(state: WorkflowUiState): LeftPaneEntry[] {
  const steps: LeftPaneEntry[] = [];
  const agents: LeftPaneEntry[] = [];
  const seenAgentIds = new Set<string>();

  for (const stepId of state.stepOrder) {
    const mid = agentMemberId(stepId);
    if (mid) {
      agents.push({ kind: "agent", stepId, memberId: mid });
      seenAgentIds.add(mid);
    } else {
      steps.push({ kind: "step", stepId });
    }
  }

  for (const memberId of state.agentRosterOrder) {
    if (seenAgentIds.has(memberId)) continue;
    agents.push({ kind: "agent", stepId: agentStepId(memberId), memberId });
    seenAgentIds.add(memberId);
  }

  const entries: LeftPaneEntry[] = [...steps];
  if (agents.length > 0) {
    entries.push({ kind: "separator", label: "Agents" });
    entries.push(...agents);
  }

  return entries;
}

export function renderStepList(state: WorkflowUiState, width: number, height: number): string {
  spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;

  const entries = buildLeftPaneEntries(state);
  const lines: string[] = [];
  const w = Math.max(0, width);

  for (const entry of entries) {
    if (entry.kind === "separator") {
      const label = ` ${entry.label} `;
      const pad = Math.max(0, w - label.length - 2);
      const left = Math.floor(pad / 2);
      const right = pad - left;
      lines.push(`\x1b[90m${"\u2500".repeat(left)}${label}${"\u2500".repeat(right)}\x1b[0m`);
      continue;
    }

    const stepId = entry.stepId;
    const step = state.steps.get(stepId);
    const roster = entry.kind === "agent" ? state.agentRoster.get(entry.memberId) : undefined;
    if (!step && !roster) continue;

    const isSelected = stepId === state.selectedStepId;
    const prefix = isSelected ? "\x1b[7m" : "";
    const suffix = isSelected ? "\x1b[0m" : "";

    const effectiveStatus =
      entry.kind === "agent"
        ? getAgentStatus(step, roster?.role)
        : (step?.status ?? "PENDING");
    const icon = getStepIcon(effectiveStatus);
    const displayName = entry.kind === "agent"
      ? `\x1b[36m\u25C6\x1b[0m ${roster?.name ?? entry.memberId}`
      : stepId;
    const iter = step && step.maxIterations > 1 ? ` ${step.iteration}/${step.maxIterations}` : "";
    const duration = step?.startedAt ? ` ${formatDuration(step)}` : "";
    const phaseText =
      entry.kind === "agent"
        ? getAgentPhase(step, roster?.role)
        : step?.phase;
    const phase = phaseText ? ` \x1b[90m${phaseText}\x1b[0m` : "";

    const base = ` ${icon} ${displayName}${iter}${duration}${phase}`;
    const fitted = ansiFit(ansiTruncate(base, w, { ellipsis: "..." }), w);
    lines.push(`${prefix}${fitted}${suffix}`);

    // Add hint subline for RUNNING agents
    if (entry.kind === "agent" && step?.status === "RUNNING") {
      const hint = getAgentHintText(step);
      if (hint) {
        const plain = stripAnsi(hint);
        const maxHintW = Math.max(0, w - 4); // "  └ " prefix
        const truncated = plain.length > maxHintW ? plain.slice(0, Math.max(0, maxHintW - 3)) + "..." : plain;
        lines.push(`\x1b[90m  └ ${truncated}\x1b[0m`);
      }
    }
  }

  // Pad to fill height
  while (lines.length < height) {
    lines.push("");
  }

  return lines.slice(0, height).join("\n");
}

function getStepIcon(status: string): string {
  if (status === "RUNNING") {
    return `\x1b[33m${SPINNER_FRAMES[spinnerIdx]}\x1b[0m`;
  }
  if (status === "CHECKING") {
    return `\x1b[35m${SPINNER_FRAMES[spinnerIdx]}\x1b[0m`;
  }
  return STATUS_ICONS[status] ?? "\x1b[90m?\x1b[0m";
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

function getAgentPhase(step: StepUiState | undefined, role?: string): string | undefined {
  if (step && (step.status === "RUNNING" || step.status === "CHECKING")) {
    return step.phase;
  }
  if (role === "dormant") {
    return "sleeping";
  }
  return "idle";
}

function formatDuration(step: StepUiState): string {
  if (!step.startedAt) return "";
  const end = step.completedAt ?? Date.now();
  const ms = end - step.startedAt;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `\x1b[90m${s}s\x1b[0m`;
  const m = Math.floor(s / 60);
  return `\x1b[90m${m}m${s % 60}s\x1b[0m`;
}
