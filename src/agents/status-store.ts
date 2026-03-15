import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { atomicJsonWrite } from "./fs-atomic.js";
import { agentsRoot, workflowStatusPath } from "./paths.js";
import {
  readCurrentStatePhaseSnapshot,
  type WorkflowStatusCurrentStateSource,
  workflowStatusNextActionsForPhase,
  workflowStatusSummaryForPhase,
} from "./current-state-phase.js";

export interface WorkflowStatusSummary {
  version: "1";
  updated_at: number;
  owner_member_id: string;
  summary: string;
  blockers: string[];
  next_actions: string[];
  source?: WorkflowStatusCurrentStateSource;
}

export interface WriteWorkflowStatusOptions {
  contextDir: string;
  ownerMemberId: string;
  summary: string;
  blockers?: string[];
  nextActions?: string[];
}

function assertWorkflowStatusSummary(data: unknown): asserts data is WorkflowStatusSummary {
  const d = data as Record<string, unknown>;
  if (d.version !== "1") throw new Error(`Unsupported workflow-status.json version: ${d.version}`);
  if (typeof d.updated_at !== "number") throw new Error("workflow-status.json: missing updated_at");
  if (typeof d.owner_member_id !== "string") throw new Error("workflow-status.json: missing owner_member_id");
  if (typeof d.summary !== "string") throw new Error("workflow-status.json: missing summary");
  if (!Array.isArray(d.blockers)) throw new Error("workflow-status.json: missing blockers");
  if (!Array.isArray(d.next_actions)) throw new Error("workflow-status.json: missing next_actions");
  if (d.source !== undefined) {
    const source = d.source as Record<string, unknown>;
    if (source.kind !== "current_state_phase_v1") {
      throw new Error(`workflow-status.json: unsupported source kind ${String(source.kind)}`);
    }
    if (typeof source.path !== "string" || !source.path.trim()) {
      throw new Error("workflow-status.json: source.path must be a non-empty string");
    }
    if (typeof source.mtime_ms !== "number") {
      throw new Error("workflow-status.json: source.mtime_ms must be a number");
    }
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function buildDerivedWorkflowStatus(
  ownerMemberId: string,
  snapshot: Awaited<ReturnType<typeof readCurrentStatePhaseSnapshot>>,
): WorkflowStatusSummary {
  return {
    version: "1",
    updated_at: Date.now(),
    owner_member_id: ownerMemberId,
    summary: workflowStatusSummaryForPhase(snapshot.phase),
    blockers: snapshot.phaseReason ? [snapshot.phaseReason] : [],
    next_actions: workflowStatusNextActionsForPhase(snapshot.phase),
    source: {
      kind: "current_state_phase_v1",
      path: snapshot.sourcePath,
      mtime_ms: snapshot.mtimeMs,
    },
  };
}

export async function readWorkflowStatus(
  contextDir: string,
): Promise<WorkflowStatusSummary | null> {
  try {
    const raw = await readFile(workflowStatusPath(contextDir), "utf-8");
    const data = JSON.parse(raw);
    assertWorkflowStatusSummary(data);
    if (data.source?.kind === "current_state_phase_v1") {
      try {
        const snapshot = await readCurrentStatePhaseSnapshot(contextDir, data.source.path);
        const derived = buildDerivedWorkflowStatus(data.owner_member_id, snapshot);
        const sourceMatches = data.source.path === derived.source?.path
          && data.source.mtime_ms === derived.source?.mtime_ms;
        if (
          !sourceMatches
          || data.summary !== derived.summary
          || !arraysEqual(data.blockers, derived.blockers)
          || !arraysEqual(data.next_actions, derived.next_actions)
        ) {
          const root = agentsRoot(contextDir);
          const tmpDir = resolve(root, "tmp");
          await mkdir(dirname(workflowStatusPath(contextDir)), { recursive: true });
          await atomicJsonWrite(tmpDir, workflowStatusPath(contextDir), derived);
          return derived;
        }
      } catch {
        // Fall back to the persisted summary if the source is temporarily unreadable.
      }
    }
    return data;
  } catch {
    return null;
  }
}

export async function writeWorkflowStatus(
  opts: WriteWorkflowStatusOptions,
): Promise<WorkflowStatusSummary> {
  const status: WorkflowStatusSummary = {
    version: "1",
    updated_at: Date.now(),
    owner_member_id: opts.ownerMemberId,
    summary: opts.summary.trim(),
    blockers: (opts.blockers ?? []).map((v) => v.trim()).filter(Boolean),
    next_actions: (opts.nextActions ?? []).map((v) => v.trim()).filter(Boolean),
  };

  if (!status.summary) {
    throw new Error("workflow status summary must not be empty");
  }

  const root = agentsRoot(opts.contextDir);
  const tmpDir = resolve(root, "tmp");
  await mkdir(dirname(workflowStatusPath(opts.contextDir)), { recursive: true });
  await atomicJsonWrite(tmpDir, workflowStatusPath(opts.contextDir), status);
  return status;
}

export async function clearWorkflowStatus(contextDir: string): Promise<void> {
  await rm(workflowStatusPath(contextDir), { force: true });
}
