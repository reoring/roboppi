import type { WorkflowUiState, StepUiState } from "../../state-store.js";
import { ansiWrap, ansiWidth, sanitizeForTui } from "../../ansi-utils.js";

export function renderOverviewTab(
  state: WorkflowUiState,
  step: StepUiState | undefined,
  width: number,
  height: number,
): string {
  const lines: string[] = [];

  if (!step) {
    lines.push("\x1b[90mNo step selected\x1b[0m");
    return padLines(lines, height);
  }

  const w = Math.max(0, width);
  lines.push(...wrapKeyValue(`\x1b[1mStep:\x1b[0m `, sanitizeForTui(step.stepId), w));
  lines.push(
    ...wrapKeyValue(
      `\x1b[1mStatus:\x1b[0m `,
      sanitizeForTui(`${step.status}${step.phase ? ` (${step.phase})` : ""}`),
      w,
    ),
  );
  lines.push(
    ...wrapKeyValue(
      `\x1b[1mIteration:\x1b[0m `,
      sanitizeForTui(`${step.iteration}/${step.maxIterations}`),
      w,
    ),
  );

  if (step.startedAt) {
    const elapsed = (step.completedAt ?? Date.now()) - step.startedAt;
    lines.push(...wrapKeyValue(`\x1b[1mDuration:\x1b[0m `, formatMs(elapsed), w));
  }

  if (step.error) {
    lines.push(...wrapKeyValue(`\x1b[31m\x1b[1mError:\x1b[0m `, sanitizeForTui(step.error), w));
  }

  if (step.progress) {
    const pct = step.progress.percent !== undefined ? ` (${step.progress.percent}%)` : "";
    lines.push(
      ...wrapKeyValue(
        `\x1b[1mProgress:\x1b[0m `,
        sanitizeForTui(`${step.progress.message}${pct}`),
        w,
      ),
    );
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

function wrapKeyValue(prefix: string, value: string, width: number): string[] {
  const prefixW = ansiWidth(prefix);
  const available = Math.max(0, width - prefixW);
  const chunks = ansiWrap(value, available);
  const indent = " ".repeat(prefixW);

  const out: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) out.push(prefix + (chunks[i] ?? ""));
    else out.push(indent + (chunks[i] ?? ""));
  }
  return out;
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
