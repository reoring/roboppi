import type { StepUiState } from "../../state-store.js";

export function renderResultTab(
  step: StepUiState | undefined,
  width: number,
  height: number,
): string {
  if (!step) {
    return padLines(["\x1b[90mNo step selected\x1b[0m"], height);
  }

  if (!step.result) {
    if (step.status === "RUNNING" || step.status === "CHECKING") {
      return padLines(["\x1b[90mStep still running...\x1b[0m"], height);
    }
    return padLines(["\x1b[90mNo result available\x1b[0m"], height);
  }

  const r = step.result;
  const lines: string[] = [];

  lines.push(`\x1b[1mStatus:\x1b[0m ${r.status}`);
  if (r.exitCode !== undefined) {
    lines.push(`\x1b[1mExit Code:\x1b[0m ${r.exitCode}`);
  }
  if (r.errorClass) {
    lines.push(`\x1b[1mError Class:\x1b[0m ${r.errorClass}`);
  }
  if (r.durationMs !== undefined) {
    lines.push(`\x1b[1mDuration:\x1b[0m ${(r.durationMs / 1000).toFixed(1)}s`);
  }

  if (r.cost) {
    lines.push("");
    lines.push("\x1b[1mCost:\x1b[0m");
    if (r.cost.wallTimeMs !== undefined) {
      lines.push(`  Wall time: ${(r.cost.wallTimeMs / 1000).toFixed(1)}s`);
    }
  }

  if (r.artifacts && r.artifacts.length > 0) {
    lines.push("");
    lines.push(`\x1b[1mArtifacts:\x1b[0m (${r.artifacts.length})`);
    for (const a of r.artifacts.slice(0, 20)) {
      const ref = a.ref ?? "(no ref)";
      lines.push(`  ${a.type}: ${ref}`);
    }
  }

  if (r.observations && r.observations.length > 0) {
    lines.push("");
    lines.push(`\x1b[1mObservations:\x1b[0m`);
    for (const obs of r.observations.slice(0, 10)) {
      if (obs.summary) {
        const trunc = obs.summary.length > width - 4
          ? obs.summary.slice(0, width - 7) + "..."
          : obs.summary;
        lines.push(`  ${trunc}`);
      }
    }
  }

  return padLines(lines, height);
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
