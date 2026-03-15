import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface WorkflowStatusCurrentStateSource {
  kind: "current_state_phase_v1";
  path: string;
  mtime_ms: number;
}

export interface TaskPhaseGuard {
  source_kind: "current_state_phase_v1";
  source_path: string;
  allowed_phases: string[];
}

export interface CurrentStatePhaseSnapshot {
  phase: string;
  phaseReason: string;
  sourcePath: string;
  mtimeMs: number;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function resolveCurrentStatePhaseSourcePath(contextDir: string, sourcePath: string): string {
  return isAbsolute(sourcePath) ? sourcePath : resolve(contextDir, sourcePath);
}

export async function readCurrentStatePhaseSnapshot(
  contextDir: string,
  sourcePath: string,
): Promise<CurrentStatePhaseSnapshot> {
  const resolvedPath = resolveCurrentStatePhaseSourcePath(contextDir, sourcePath);
  const [raw, sourceStat] = await Promise.all([
    readFile(resolvedPath, "utf-8"),
    stat(resolvedPath),
  ]);
  const data = assertRecord(JSON.parse(raw), "current-state.json");
  const phase = data.phase;
  if (typeof phase !== "string" || !phase.trim()) {
    throw new Error(`current-state phase source missing string phase: ${resolvedPath}`);
  }
  const phaseReason = typeof data.phase_reason === "string" ? data.phase_reason.trim() : "";
  return {
    phase: phase.trim(),
    phaseReason,
    sourcePath: resolvedPath,
    mtimeMs: sourceStat.mtimeMs,
  };
}

export function workflowStatusSummaryForPhase(phase: string): string {
  switch (phase) {
    case "awaiting-reviewer-fast-gates":
      return "Current phase: awaiting-reviewer-fast-gates. Reviewer fast gates must pass before the next cluster-backed spend.";
    case "awaiting-manual-verification":
      return "Current phase: awaiting-manual-verification. Developer-owned manual verification is the next gate for cluster-backed work.";
    case "awaiting-remediation":
      return "Current phase: awaiting-remediation. The last authoritative spend found a repo-side blocker; remediation must land before another proof spend.";
    case "ready-for-next-e2e":
      return "Current phase: ready-for-next-e2e. The current canonical state authorizes the next authoritative cluster-backed step.";
    default:
      return `Current phase: ${phase}.`;
  }
}

export function workflowStatusNextActionsForPhase(phase: string): string[] {
  switch (phase) {
    case "awaiting-reviewer-fast-gates":
      return ["Run reviewer fast gates on the current workspace fingerprint."];
    case "awaiting-manual-verification":
      return ["Complete developer-owned manual verification and sync canonical state for the active contract."];
    case "awaiting-remediation":
      return ["Patch the active repo-side blocker, refresh canonical state, and reopen reviewer fast gates before another proof spend."];
    case "ready-for-next-e2e":
      return ["Run the next authoritative cluster-backed verification for the active contract."];
    default:
      return [];
  }
}

export function taskPhaseGuardAllows(guard: TaskPhaseGuard, phase: string): boolean {
  return guard.allowed_phases.includes(phase);
}
