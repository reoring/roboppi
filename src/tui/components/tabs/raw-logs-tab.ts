import type { StepUiState } from "../../state-store.js";
import { ansiWrap, ansiWidth, sanitizeForTui } from "../../ansi-utils.js";

export function renderRawLogsTab(
  step: StepUiState | undefined,
  width: number,
  height: number,
): string {
  if (!step) {
    return padLines(["\x1b[90mNo step selected\x1b[0m"], height);
  }

  const entries: Array<{ prefix: string; line: string }> = [];
  for (const line of step.logs.stdout.lines()) {
    entries.push({ prefix: "\x1b[90m[stdout]\x1b[0m", line });
  }
  for (const line of step.logs.stderr.lines()) {
    entries.push({ prefix: "\x1b[31m[stderr]\x1b[0m", line });
  }
  for (const line of step.logs.progress.lines()) {
    entries.push({ prefix: "\x1b[36m[progress]\x1b[0m", line });
  }

  if (entries.length === 0) {
    return padLines(["\x1b[90mNo raw logs yet\x1b[0m"], height);
  }

  const lines: string[] = [];
  for (let idx = entries.length - 1; idx >= 0 && lines.length < height; idx--) {
    const entry = entries[idx]!;
    const prefixW = ansiWidth(entry.prefix);
    const available = Math.max(0, width - prefixW - 1);
    const safe = sanitizeForTui(entry.line);
    const chunks = ansiWrap(safe, available);

    const block: string[] = [];
    const contPrefix = " ".repeat(prefixW) + " ";
    for (let i = 0; i < chunks.length; i++) {
      const prefix = i === 0 ? `${entry.prefix} ` : contPrefix;
      block.push(prefix + (chunks[i] ?? ""));
    }

    const remaining = height - lines.length;
    const take = block.slice(Math.max(0, block.length - remaining));
    for (let i = take.length - 1; i >= 0; i--) {
      lines.unshift(take[i]!);
    }
  }

  return padLines(lines, height);
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
