import type { StepUiState } from "../../state-store.js";

export function renderDiffsTab(
  step: StepUiState | undefined,
  _width: number,
  height: number,
): string {
  if (!step) {
    return padLines(["\x1b[90mNo step selected\x1b[0m"], height);
  }

  const patches = step.patches;
  if (patches.order.length === 0) {
    return padLines(["\x1b[90mNo diffs available\x1b[0m"], height);
  }

  const lines: string[] = [];
  const patchCount = patches.order.length;
  const fileCount = patches.byFilePath.size;
  lines.push(
    `\x1b[1mPatches:\x1b[0m ${patchCount} patch${patchCount === 1 ? "" : "es"} across ${fileCount} file${fileCount === 1 ? "" : "s"}`,
  );
  lines.push("");

  // List files with patch counts
  for (const [filePath, patchIds] of patches.byFilePath.entries()) {
    lines.push(`\x1b[36m${filePath}\x1b[0m (${patchIds.length} patch${patchIds.length > 1 ? "es" : ""})`);
  }

  // Show most recent patch content
  if (patches.order.length > 0) {
    const latestId = patches.order[patches.order.length - 1]!;
    const latest = patches.byId.get(latestId);
    if (latest) {
      lines.push("");
      lines.push(`\x1b[1m\u2500\u2500 Latest: ${latest.filePath} \u2500\u2500\x1b[0m`);

      const diffLines = latest.diff.split("\n");
      for (const dl of diffLines) {
        if (dl.startsWith("+")) {
          lines.push(`\x1b[32m${dl}\x1b[0m`);
        } else if (dl.startsWith("-")) {
          lines.push(`\x1b[31m${dl}\x1b[0m`);
        } else if (dl.startsWith("@@")) {
          lines.push(`\x1b[36m${dl}\x1b[0m`);
        } else {
          lines.push(dl);
        }
      }
    }
  }

  return padLines(lines, height);
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
