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
  stateVersion: number | null;
  sourcePath: string;
  mtimeMs: number;
}

export interface CurrentStateRoutingSnapshot extends CurrentStatePhaseSnapshot {
  runId: string | null;
  issueId: string | null;
  contractId: string | null;
  workspaceStatusFingerprint: string | null;
  proofPacketId: string | null;
  issuePath: string | null;
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
  const stateVersion = Number.isFinite(data.state_version) ? Number(data.state_version) : null;
  return {
    phase: phase.trim(),
    phaseReason,
    stateVersion,
    sourcePath: resolvedPath,
    mtimeMs: sourceStat.mtimeMs,
  };
}

function optionalString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

export async function readCurrentStateRoutingSnapshot(
  contextDir: string,
  sourcePath: string,
): Promise<CurrentStateRoutingSnapshot> {
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
  const stateVersion = Number.isFinite(data.state_version) ? Number(data.state_version) : null;
  return {
    phase: phase.trim(),
    phaseReason,
    stateVersion,
    sourcePath: resolvedPath,
    mtimeMs: sourceStat.mtimeMs,
    runId: optionalString(data, "run_id"),
    issueId: optionalString(data, "canonical_issue_id", "issue_id"),
    contractId: optionalString(data, "contract_id"),
    workspaceStatusFingerprint: optionalString(data, "workspace_status_fingerprint"),
    proofPacketId: optionalString(data, "proof_packet_id"),
    issuePath: optionalString(data, "issue_path"),
  };
}

export function currentStateRoutingKey(snapshot: CurrentStateRoutingSnapshot): string {
  return JSON.stringify({
    source_path: snapshot.sourcePath,
    run_id: snapshot.runId,
    issue_id: snapshot.issueId,
    contract_id: snapshot.contractId,
    workspace_status_fingerprint: snapshot.workspaceStatusFingerprint,
    proof_packet_id: snapshot.proofPacketId,
    issue_path: snapshot.issuePath,
  });
}

export const INITIALIZING_STARTUP_STUB_SUMMARY =
  "Current phase: initializing. Developer must replace startup stubs with canonical state before repo-side work continues.";

export const INITIALIZING_STARTUP_STUB_BLOCKER =
  "Developer-owned canonical startup sync is still pending.";

export function isInitializingStartupStub(snapshot: Pick<CurrentStatePhaseSnapshot, "phase" | "phaseReason" | "stateVersion">): boolean {
  if (snapshot.phase !== "initializing") {
    return false;
  }
  if (snapshot.phaseReason.trim()) {
    return false;
  }
  return (snapshot.stateVersion ?? 0) === 0;
}

export function workflowStatusSummaryForPhase(phase: string): string {
  switch (phase) {
    case "initializing":
      return INITIALIZING_STARTUP_STUB_SUMMARY;
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

export function workflowStatusSummaryForSnapshot(snapshot: CurrentStatePhaseSnapshot): string {
  if (isInitializingStartupStub(snapshot)) {
    return INITIALIZING_STARTUP_STUB_SUMMARY;
  }
  if (snapshot.phase === "initializing") {
    return "Current phase: initializing. Startup sync is complete; define the first repo-side slice and canonical issue before broader work continues.";
  }
  return workflowStatusSummaryForPhase(snapshot.phase);
}

export function workflowStatusNextActionsForPhase(phase: string): string[] {
  switch (phase) {
    case "initializing":
      return [
        "Use developer_sync_bundle or state_promote_attempt to replace startup stubs in current-state.json, todo.md, memory.md, and issues/index.md.",
        "Record the active blocker or first repo-side slice, then republish workflow status from canonical current-state.",
      ];
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

export function workflowStatusNextActionsForSnapshot(snapshot: CurrentStatePhaseSnapshot): string[] {
  if (isInitializingStartupStub(snapshot)) {
    return workflowStatusNextActionsForPhase(snapshot.phase);
  }
  if (snapshot.phase === "initializing") {
    return [
      "Read request.md and apthctl-plan.md to define the first concrete repo-side slice.",
      "Read ARCHITECTURE.md and AGENTS.md, then establish the canonical issue and workspace fingerprint for that slice.",
      "Refresh canonical current-state and workflow status after the first repo-side slice is named.",
    ];
  }
  return workflowStatusNextActionsForPhase(snapshot.phase);
}

export function taskPhaseGuardAllows(guard: TaskPhaseGuard, phase: string): boolean {
  return guard.allowed_phases.includes(phase);
}
