import type { WorkflowUiState } from "../../state-store.js";

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
    // Show last N lines
    const visible = logLines.slice(-(height - 3));
    for (const l of visible) {
      const trunc = l.length > width ? l.slice(0, width - 3) + "..." : l;
      lines.push(`\x1b[90m${trunc}\x1b[0m`);
    }
  }

  return padLines(lines, height);
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
