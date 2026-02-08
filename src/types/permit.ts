import type { UUID, Timestamp } from "./common.js";

export enum CircuitState {
  CLOSED = "CLOSED",
  HALF_OPEN = "HALF_OPEN",
  OPEN = "OPEN",
}

export interface PermitTokens {
  concurrency: number;
  rps: number;
  costBudget?: number;
}

/** Serializable permit for IPC — does not contain AbortController. */
export interface Permit {
  permitId: UUID;
  jobId: UUID;
  deadlineAt: Timestamp;
  attemptIndex: number;
  tokensGranted: PermitTokens;
  circuitStateSnapshot: Record<string, CircuitState>;
  workspaceLockToken?: string;
}

/** Runtime permit handle — extends Permit with an AbortController for cancellation. */
export interface PermitHandle extends Permit {
  abortController: AbortController;
}

export enum PermitRejectionReason {
  QUEUE_STALL = "QUEUE_STALL",
  CIRCUIT_OPEN = "CIRCUIT_OPEN",
  RATE_LIMIT = "RATE_LIMIT",
  GLOBAL_SHED = "GLOBAL_SHED",
  FATAL_MODE = "FATAL_MODE",
  BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED",
  CONCURRENCY_LIMIT = "CONCURRENCY_LIMIT",
  DUPLICATE_PERMIT = "DUPLICATE_PERMIT",
  DEFERRED = "DEFERRED",
}

export interface PermitRejection {
  reason: PermitRejectionReason;
  detail?: string;
}
