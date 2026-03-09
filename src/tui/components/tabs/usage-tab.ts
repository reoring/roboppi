import type { WorkflowUiState, StepUiState } from "../../state-store.js";
import { sanitizeForTui } from "../../ansi-utils.js";

export function renderUsageTab(
  state: WorkflowUiState,
  step: StepUiState | undefined,
  memberId: string | undefined,
  _width: number,
  height: number,
): string {
  const lines: string[] = [];
  const runtime = memberId ? state.agentRuntime.get(memberId) : undefined;

  if (!step && !runtime) {
    return padLines(["\x1b[90mNo usage data yet\x1b[0m"], height);
  }

  if (memberId) {
    lines.push("\x1b[1mAgent Usage\x1b[0m");
    lines.push("");
    lines.push(`Dispatches: ${runtime?.dispatchCount ?? 0}`);
    lines.push(`Restarts: ${runtime?.restartCount ?? 0}`);
    if ((runtime?.totalEstimatedTokens ?? 0) > 0) {
      lines.push(`Total estimated tokens: ${runtime?.totalEstimatedTokens ?? 0}`);
    }
    if (runtime?.lastEstimatedTokens !== undefined) {
      lines.push(`Last dispatch tokens: ${runtime.lastEstimatedTokens}`);
    }
    if ((runtime?.totalInstructionBytes ?? 0) > 0) {
      lines.push(`Total prompt bytes: ${runtime?.totalInstructionBytes ?? 0}`);
    }
    if (runtime?.lastInstructionBytes !== undefined) {
      lines.push(`Last dispatch prompt bytes: ${runtime.lastInstructionBytes}`);
    }
    lines.push(`Busy time: ${formatMs(getBusyMs(runtime?.totalDispatchActiveMs ?? 0, runtime?.currentlyDispatchingSince))}`);
    if (runtime?.lastStartedAt) {
      lines.push(`Last start: ${formatTs(runtime.lastStartedAt)}`);
    }
    if (runtime?.lastStoppedAt) {
      lines.push(`Last stop: ${formatTs(runtime.lastStoppedAt)}`);
    }
    lines.push("");
  } else {
    lines.push("\x1b[1mStep Usage\x1b[0m");
    lines.push("");
  }

  if (step?.result?.cost) {
    lines.push("\x1b[1mLast Result Cost\x1b[0m");
    lines.push(`Status: ${step.result.status}`);
    lines.push(`Wall time: ${(step.result.cost.wallTimeMs / 1000).toFixed(1)}s`);
    if (step.result.cost.estimatedTokens !== undefined) {
      lines.push(`Estimated tokens: ${step.result.cost.estimatedTokens}`);
    }
    if (step.result.cost.instructionBytes !== undefined) {
      lines.push(`Prompt bytes: ${step.result.cost.instructionBytes}`);
    }
    if (step.result.exitCode !== undefined) {
      lines.push(`Exit code: ${step.result.exitCode}`);
    }
  } else if (step) {
    lines.push("\x1b[90mNo completed result yet\x1b[0m");
  }

  if (step?.phase) {
    lines.push("");
    lines.push(`Current phase: ${sanitizeForTui(step.phase)}`);
  }

  return padLines(lines, height);
}

function getBusyMs(total: number, currentlyDispatchingSince?: number): number {
  if (currentlyDispatchingSince === undefined) return total;
  return total + Math.max(0, Date.now() - currentlyDispatchingSince);
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function formatTs(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
