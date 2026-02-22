import type { WorkflowUiState } from "../state-store.js";

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
let spinnerIdx = 0;

export function renderHeader(state: WorkflowUiState, width: number): string {
  spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;

  const name = state.name ?? "workflow";
  const mode = state.supervised ? "supervised" : "direct";
  const status = state.status ?? "PENDING";

  const elapsed = state.startedAt
    ? formatElapsed(Date.now() - state.startedAt)
    : "0s";

  const statusColor = getStatusColor(status);
  const spinner = isRunningStatus(status) ? SPINNER_FRAMES[spinnerIdx] + " " : "";

  const counts = countStatuses(state);
  const countStr = formatCounts(counts);

  const isFinished = status !== "RUNNING" && status !== "PENDING";
  const line1 = `\x1b[1m${name}\x1b[0m  ${spinner}${statusColor}${status}\x1b[0m  \x1b[90m${mode} \u00B7 ${elapsed}\x1b[0m`;
  const hints = isFinished
    ? "j/k:move  1-6:tabs  q:exit"
    : "j/k:move  1-6:tabs  Ctrl+C:cancel  q:quit";
  const line2 = `\x1b[90m${countStr}  \u2502  ${hints}\x1b[0m`;
  const separator = "\x1b[90m" + "\u2500".repeat(width) + "\x1b[0m";

  return line1 + "\n" + line2 + "\n" + separator;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function getStatusColor(status: string): string {
  switch (status) {
    case "RUNNING": return "\x1b[33m";
    case "SUCCEEDED": return "\x1b[32m";
    case "FAILED": return "\x1b[31m";
    case "TIMED_OUT": return "\x1b[31m";
    case "CANCELLED": return "\x1b[31m";
    default: return "\x1b[90m";
  }
}

function isRunningStatus(status: string): boolean {
  return status === "RUNNING";
}

function countStatuses(state: WorkflowUiState): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const step of state.steps.values()) {
    counts[step.status] = (counts[step.status] ?? 0) + 1;
  }
  return counts;
}

function formatCounts(counts: Record<string, number>): string {
  const parts: string[] = [];
  const order = ["RUNNING", "CHECKING", "PENDING", "READY", "SUCCEEDED", "FAILED", "SKIPPED", "INCOMPLETE", "CANCELLED"];
  for (const s of order) {
    if (counts[s]) parts.push(`${s.toLowerCase()}:${counts[s]}`);
  }
  return parts.join(" ");
}
