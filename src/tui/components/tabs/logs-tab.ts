import type { StepUiState } from "../../state-store.js";
import { ansiWrap, ansiWidth, sanitizeForTui } from "../../ansi-utils.js";

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

  const lines: string[] = [];

  // Build the last N physical lines with wrapping.
  for (let idx = entries.length - 1; idx >= 0 && lines.length < height; idx--) {
    const e = entries[idx]!;
    const prefix = getChannelPrefix(e.channel);
    const prefixW = ansiWidth(prefix);
    const available = Math.max(0, width - prefixW - 1);

    const safe = sanitizeForTui(e.line);
    const chunks = ansiWrap(safe, available);

    const contPrefix = " ".repeat(prefixW) + " ";
    const entryLines: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const p = i === 0 ? `${prefix} ` : contPrefix;
      entryLines.push(p + (chunks[i] ?? ""));
    }

    // Prepend only what we still need.
    const remaining = height - lines.length;
    const take = entryLines.slice(Math.max(0, entryLines.length - remaining));
    for (let i = take.length - 1; i >= 0; i--) {
      lines.unshift(take[i]!);
    }
  }

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
