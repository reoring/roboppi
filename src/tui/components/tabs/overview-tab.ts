import type { WorkflowUiState, StepUiState } from "../../state-store.js";

export function renderOverviewTab(
  state: WorkflowUiState,
  step: StepUiState | undefined,
  _width: number,
  height: number,
): string {
  const lines: string[] = [];

  if (!step) {
    lines.push("\x1b[90mNo step selected\x1b[0m");
    return padLines(lines, height);
  }

  lines.push(`\x1b[1mStep:\x1b[0m ${step.stepId}`);
  lines.push(`\x1b[1mStatus:\x1b[0m ${step.status}${step.phase ? ` (${step.phase})` : ""}`);
  lines.push(`\x1b[1mIteration:\x1b[0m ${step.iteration}/${step.maxIterations}`);

  if (step.startedAt) {
    const elapsed = (step.completedAt ?? Date.now()) - step.startedAt;
    lines.push(`\x1b[1mDuration:\x1b[0m ${formatMs(elapsed)}`);
  }

  if (step.error) {
    lines.push(`\x1b[31m\x1b[1mError:\x1b[0m ${step.error}`);
  }

  if (step.progress) {
    const pct = step.progress.percent !== undefined ? ` (${step.progress.percent}%)` : "";
    lines.push(`\x1b[1mProgress:\x1b[0m ${step.progress.message}${pct}`);
  }

  // Workflow summary
  lines.push("");
  lines.push("\x1b[1m\u2500\u2500 Workflow Summary \u2500\u2500\x1b[0m");

  const counts: Record<string, number> = {};
  for (const s of state.steps.values()) {
    counts[s.status] = (counts[s.status] ?? 0) + 1;
  }

  const total = state.steps.size;
  lines.push(`Total steps: ${total}`);
  for (const [status, count] of Object.entries(counts).sort()) {
    lines.push(`  ${status}: ${count}`);
  }

  return padLines(lines, height);
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
