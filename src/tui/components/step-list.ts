import type { WorkflowUiState, StepUiState } from "../state-store.js";

const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];
let spinnerIdx = 0;

const STATUS_ICONS: Record<string, string> = {
  PENDING: "\x1b[90m\u25CB\x1b[0m",
  READY: "\x1b[36m\u25CE\x1b[0m",
  RUNNING: "\x1b[33m\u25CF\x1b[0m",
  CHECKING: "\x1b[35m\u25C9\x1b[0m",
  SUCCEEDED: "\x1b[32m\u2713\x1b[0m",
  FAILED: "\x1b[31m\u2717\x1b[0m",
  INCOMPLETE: "\x1b[90m\u25D1\x1b[0m",
  SKIPPED: "\x1b[90m\u2298\x1b[0m",
  CANCELLED: "\x1b[31m\u2298\x1b[0m",
};

export function renderStepList(state: WorkflowUiState, width: number, height: number): string {
  spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;

  const lines: string[] = [];
  const stepOrder = state.stepOrder;

  for (const stepId of stepOrder) {
    const step = state.steps.get(stepId);
    if (!step) continue;

    const isSelected = stepId === state.selectedStepId;
    const prefix = isSelected ? "\x1b[7m" : "";
    const suffix = isSelected ? "\x1b[0m" : "";

    const icon = getStepIcon(step);
    const iter = step.maxIterations > 1 ? ` ${step.iteration}/${step.maxIterations}` : "";
    const duration = step.startedAt ? ` ${formatDuration(step)}` : "";
    const phase = step.phase ? ` \x1b[90m${step.phase}\x1b[0m` : "";

    const truncId = stepId.length > width - 12
      ? stepId.slice(0, width - 15) + "..."
      : stepId;

    const line = `${prefix} ${icon} ${truncId}${iter}${duration}${phase}${suffix}`;
    lines.push(line);
  }

  // Pad to fill height
  while (lines.length < height) {
    lines.push("");
  }

  return lines.slice(0, height).join("\n");
}

function getStepIcon(step: StepUiState): string {
  if (step.status === "RUNNING") {
    return `\x1b[33m${SPINNER_FRAMES[spinnerIdx]}\x1b[0m`;
  }
  if (step.status === "CHECKING") {
    return `\x1b[35m${SPINNER_FRAMES[spinnerIdx]}\x1b[0m`;
  }
  return STATUS_ICONS[step.status] ?? "\x1b[90m?\x1b[0m";
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
