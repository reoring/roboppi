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

  lines.push("");
  lines.push("\x1b[1m\u2500\u2500 Summary \u2500\u2500\x1b[0m");

  const summary = state.workflowStatusSummary;
  if (!summary) {
    lines.push("\x1b[90mNo agent summary yet\x1b[0m");
  } else {
    lines.push(...wrapParagraph(summary.summary, w, ""));
    lines.push(
      ...wrapKeyValue(
        `\x1b[1mUpdated:\x1b[0m `,
        sanitizeForTui(`${formatTs(summary.updated_at)} by ${summary.owner_member_id}`),
        w,
      ),
    );
    if (summary.blockers.length > 0) {
      lines.push(...wrapList("Blockers", summary.blockers, w));
    }
    if (summary.next_actions.length > 0) {
      lines.push(...wrapList("Next", summary.next_actions, w));
    }
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

function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function wrapParagraph(text: string, width: number, indent: string): string[] {
  const available = Math.max(0, width - ansiWidth(indent));
  const lines: string[] = [];
  for (const raw of sanitizeForTui(text).split("\n")) {
    const chunks = ansiWrap(raw, available);
    if (chunks.length === 0) {
      lines.push(indent);
      continue;
    }
    for (const chunk of chunks) {
      lines.push(indent + chunk);
    }
  }
  return lines;
}

function wrapList(title: string, items: string[], width: number): string[] {
  const lines: string[] = [`\x1b[1m${title}:\x1b[0m`];
  for (const item of items) {
    lines.push(...wrapParagraph(item, width, "  - "));
  }
  return lines;
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
