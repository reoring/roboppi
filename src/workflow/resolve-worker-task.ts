/**
 * Shared resolver for WorkerTask definitions.
 *
 * Centralizes normalization that was previously duplicated across
 * MultiWorkerStepRunner and CoreIpcStepRunner:
 *   - DurationString → ms
 *   - workspace → absolute path
 *   - capability strings → WorkerCapability enums
 *   - worker strings → WorkerKind enum
 *
 * Phase 1 of the domain modeling refactor (see docs/issues/workflow-domain-modeling.ja.md).
 */
import path from "node:path";
import type { StepDefinition } from "./types.js";
import { parseDuration } from "./duration.js";
import {
  WorkerKind,
  WorkerCapability,
  OutputMode,
  generateId,
} from "../types/index.js";
import type { WorkerTask } from "../types/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default step timeout when none is specified (24 hours). */
export const DEFAULT_STEP_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Resolved model
// ---------------------------------------------------------------------------

/**
 * A task-like definition after normalization/resolution.
 *
 * All duration strings have been parsed to ms, workspace is an absolute path,
 * capabilities are enum values, and worker is a WorkerKind enum.
 */
export interface ResolvedWorkerTaskDef {
  workerKind: WorkerKind;
  workspaceRef: string;
  instructions: string;
  model?: string;
  variant?: string;
  capabilities: WorkerCapability[];
  timeoutMs: number;
  maxSteps?: number;
  maxCommandTimeMs?: number;
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Input type (common subset of StepDefinition and CompletionCheckDef)
// ---------------------------------------------------------------------------

type TaskLikeDef = {
  worker?: StepDefinition["worker"];
  workspace?: string;
  instructions?: string;
  capabilities?: StepDefinition["capabilities"];
  timeout?: StepDefinition["timeout"];
  max_steps?: StepDefinition["max_steps"];
  max_command_time?: StepDefinition["max_command_time"];
  model?: StepDefinition["model"];
  variant?: StepDefinition["variant"];
};

// ---------------------------------------------------------------------------
// Worker / Capability mapping
// ---------------------------------------------------------------------------

function toWorkerKind(worker: StepDefinition["worker"]): WorkerKind {
  switch (worker) {
    case "CUSTOM":
      return WorkerKind.CUSTOM;
    case "OPENCODE":
      return WorkerKind.OPENCODE;
    case "CLAUDE_CODE":
      return WorkerKind.CLAUDE_CODE;
    case "CODEX_CLI":
      return WorkerKind.CODEX_CLI;
    default:
      throw new Error(`Unknown worker kind: ${String(worker)}`);
  }
}

function toWorkerCapabilities(
  caps: NonNullable<StepDefinition["capabilities"]>,
): WorkerCapability[] {
  return caps.map((c) => WorkerCapability[c]);
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

/**
 * Normalize a task-like definition (step or completion_check) into a
 * resolved form suitable for execution.
 *
 * This is the single source of truth for:
 * - Duration parsing (timeout, max_command_time)
 * - Workspace path resolution
 * - Capability enum mapping
 * - Worker kind enum mapping
 */
export function resolveTaskLike(
  def: TaskLikeDef,
  workspaceDir: string,
  env?: Record<string, string>,
): ResolvedWorkerTaskDef {
  const workspaceRef = def.workspace
    ? path.resolve(workspaceDir, def.workspace)
    : workspaceDir;

  const timeoutMs = def.timeout
    ? parseDuration(def.timeout)
    : DEFAULT_STEP_TIMEOUT_MS;

  const maxCommandTimeMs = def.max_command_time
    ? parseDuration(def.max_command_time)
    : undefined;

  return {
    workerKind: toWorkerKind(def.worker),
    workspaceRef,
    instructions: def.instructions ?? "",
    capabilities: toWorkerCapabilities(def.capabilities ?? []),
    timeoutMs,
    ...(def.model ? { model: def.model } : {}),
    ...(def.variant ? { variant: def.variant } : {}),
    ...(def.max_steps !== undefined ? { maxSteps: def.max_steps } : {}),
    ...(maxCommandTimeMs !== undefined ? { maxCommandTimeMs } : {}),
    ...(env ? { env } : {}),
  };
}

// ---------------------------------------------------------------------------
// Build WorkerTask (adds runtime fields: deadlineAt, abortSignal, id)
// ---------------------------------------------------------------------------

/**
 * Build a full WorkerTask from a resolved definition.
 *
 * This sets the execution deadline (`deadlineAt = now + timeoutMs`) and
 * generates a unique workerTaskId. Call this at the point of execution,
 * not earlier, to ensure the deadline is accurate.
 */
export function buildWorkerTask(
  resolved: ResolvedWorkerTaskDef,
  abortSignal: AbortSignal,
): WorkerTask {
  const deadlineAt = Date.now() + resolved.timeoutMs;

  return {
    workerTaskId: generateId(),
    workerKind: resolved.workerKind,
    workspaceRef: resolved.workspaceRef,
    instructions: resolved.instructions,
    capabilities: resolved.capabilities,
    outputMode: OutputMode.BATCH,
    ...(resolved.model ? { model: resolved.model } : {}),
    ...(resolved.variant ? { variant: resolved.variant } : {}),
    budget: {
      deadlineAt,
      ...(resolved.maxSteps !== undefined
        ? { maxSteps: resolved.maxSteps }
        : {}),
      ...(resolved.maxCommandTimeMs !== undefined
        ? { maxCommandTimeMs: resolved.maxCommandTimeMs }
        : {}),
    },
    env: resolved.env,
    abortSignal,
  };
}
