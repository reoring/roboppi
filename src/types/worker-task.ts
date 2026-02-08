import type { UUID, Timestamp } from "./common.js";

export enum WorkerKind {
  CODEX_CLI = "CODEX_CLI",
  CLAUDE_CODE = "CLAUDE_CODE",
  OPENCODE = "OPENCODE",
  CUSTOM = "CUSTOM",
}

export enum WorkerCapability {
  READ = "READ",
  EDIT = "EDIT",
  RUN_TESTS = "RUN_TESTS",
  RUN_COMMANDS = "RUN_COMMANDS",
}

export enum OutputMode {
  STREAM = "STREAM",
  BATCH = "BATCH",
}

export interface WorkerBudget {
  deadlineAt: Timestamp;
  maxSteps?: number;
  maxCommandTimeMs?: number;
  cancellationGracePeriodMs?: number;
}

export interface WorkerTask {
  workerTaskId: UUID;
  workerKind: WorkerKind;
  workspaceRef: string;
  instructions: string;
  capabilities: WorkerCapability[];
  outputMode: OutputMode;
  budget: WorkerBudget;
  abortSignal: AbortSignal;
}
