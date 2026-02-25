import type { WorkflowUiState } from "../../state-store.js";
import { ansiWrap, sanitizeForTui } from "../../ansi-utils.js";

export function renderCoreTab(
  state: WorkflowUiState,
  width: number,
  height: number,
): string {
  if (!state.supervised) {
    return padLines(["\x1b[90mCore tab is only available in supervised mode\x1b[0m"], height);
  }

  const lines: string[] = [];
  lines.push("\x1b[1mCore Logs\x1b[0m");
  lines.push("");

  const logLines = state.coreLogs.lines();
  if (logLines.length === 0) {
    lines.push("\x1b[90mNo core logs yet\x1b[0m");
  } else {
    const target = Math.max(0, height - 3);
    const physical: string[] = [];

    // Build the last N physical lines with wrapping.
    for (let idx = logLines.length - 1; idx >= 0 && physical.length < target; idx--) {
      const safe = sanitizeForTui(logLines[idx]!);
      const chunks = ansiWrap(safe, Math.max(0, width));
      const wrapped = chunks.map((c) => `\x1b[90m${c}\x1b[0m`);

      const remaining = target - physical.length;
      const take = wrapped.slice(Math.max(0, wrapped.length - remaining));
      for (let i = take.length - 1; i >= 0; i--) {
        physical.unshift(take[i]!);
      }
    }

    for (const l of physical) lines.push(l);
  }

  return padLines(lines, height);
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
