import type { UUID, Timestamp } from "./common.js";
import { WorkerKind, WorkerCapability, OutputMode } from "./worker-task.js";

/**
 * Payload shape for jobs of type WORKER_TASK submitted via Core IPC.
 * Mirrors the object built by `CoreIpcStepRunner.buildWorkerJob()`.
 */
export interface WorkerTaskJobPayload {
  workerTaskId: UUID;
  workerKind: WorkerKind;
  workspaceRef: string;
  instructions: string;
  model?: string;
  capabilities: WorkerCapability[];
  outputMode: OutputMode;
  budget: {
    deadlineAt: Timestamp;
    maxSteps?: number;
    maxCommandTimeMs?: number;
  };
  env?: Record<string, string>;
}

// Allowed enum string values, derived once at module load.
const VALID_WORKER_KINDS: ReadonlySet<string> = new Set(Object.values(WorkerKind));
const VALID_CAPABILITIES: ReadonlySet<string> = new Set(Object.values(WorkerCapability));
const VALID_OUTPUT_MODES: ReadonlySet<string> = new Set(Object.values(OutputMode));

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Runtime type guard for {@link WorkerTaskJobPayload}. */
export function isWorkerTaskJobPayload(value: unknown): value is WorkerTaskJobPayload {
  if (value === null || value === undefined || typeof value !== "object") {
    return false;
  }

  const v = value as Record<string, unknown>;

  if (typeof v.workerTaskId !== "string") return false;
  if (typeof v.workspaceRef !== "string") return false;
  if (typeof v.instructions !== "string") return false;

  // workerKind must be a known enum value
  if (typeof v.workerKind !== "string" || !VALID_WORKER_KINDS.has(v.workerKind)) return false;

  // outputMode must be a known enum value
  if (typeof v.outputMode !== "string" || !VALID_OUTPUT_MODES.has(v.outputMode)) return false;

  // capabilities must be an array of known enum values
  if (!Array.isArray(v.capabilities)) return false;
  for (const cap of v.capabilities) {
    if (typeof cap !== "string" || !VALID_CAPABILITIES.has(cap)) return false;
  }

  // budget
  if (v.budget === null || v.budget === undefined || typeof v.budget !== "object") {
    return false;
  }
  const budget = v.budget as Record<string, unknown>;
  if (!isFiniteNumber(budget.deadlineAt)) return false;
  if (budget.maxSteps !== undefined && !isFiniteNumber(budget.maxSteps)) return false;
  if (budget.maxCommandTimeMs !== undefined && !isFiniteNumber(budget.maxCommandTimeMs)) return false;

  // env — if present, must be Record<string, string>
  if (v.env !== undefined) {
    if (v.env === null || typeof v.env !== "object" || Array.isArray(v.env)) return false;
    for (const val of Object.values(v.env as Record<string, unknown>)) {
      if (typeof val !== "string") return false;
    }
  }

  return true;
}
