import type { StepUiState } from "../../state-store.js";
import { ansiTruncate, ansiWidth, sanitizeForTui } from "../../ansi-utils.js";

export function renderLogsTab(
  step: StepUiState | undefined,
  width: number,
  height: number,
): string {
  if (!step) {
    return padLines(["\x1b[90mNo step selected\x1b[0m"], height);
  }

  // Merge all log sources
  const entries: { channel: string; line: string }[] = [];

  for (const line of step.logs.stdout.lines()) {
    entries.push({ channel: "out", line });
  }
  for (const line of step.logs.stderr.lines()) {
    entries.push({ channel: "err", line });
  }
  for (const line of step.logs.progress.lines()) {
    entries.push({ channel: "prg", line });
  }

  if (entries.length === 0) {
    return padLines(["\x1b[90mNo logs yet\x1b[0m"], height);
  }

  // Show last N lines that fit
  const visibleEntries = entries.slice(-height);
  const lines = visibleEntries.map((e) => {
    const prefix = getChannelPrefix(e.channel);
    const available = Math.max(0, width - ansiWidth(prefix) - 1);
    const safe = sanitizeForTui(e.line);
    const truncated = ansiTruncate(safe, available, { ellipsis: "..." });
    return `${prefix} ${truncated}`;
  });

  return padLines(lines, height);
}

function getChannelPrefix(channel: string): string {
  switch (channel) {
    case "out": return "\x1b[90m[out]\x1b[0m";
    case "err": return "\x1b[31m[err]\x1b[0m";
    case "prg": return "\x1b[36m[prg]\x1b[0m";
    default: return "\x1b[90m[???]\x1b[0m";
  }
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
