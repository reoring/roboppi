export type UUID = string;
export type Timestamp = number; // epoch ms

export function generateId(): UUID {
  return crypto.randomUUID();
}

export function now(): Timestamp {
  return Date.now();
}

export interface TraceContext {
  traceId: string;
  correlationId: string;
  userId?: string;
  sessionId?: string;
}

export interface BudgetLimits {
  timeoutMs: number;
  maxAttempts: number;
  costHint?: number;
  retryBudgetMs?: number;
}

export enum ErrorClass {
  RETRYABLE_TRANSIENT = "RETRYABLE_TRANSIENT",
  RETRYABLE_RATE_LIMIT = "RETRYABLE_RATE_LIMIT",
  RETRYABLE_NETWORK = "RETRYABLE_NETWORK",
  RETRYABLE_SERVICE = "RETRYABLE_SERVICE",
  NON_RETRYABLE = "NON_RETRYABLE",
  NON_RETRYABLE_LINT = "NON_RETRYABLE_LINT",
  NON_RETRYABLE_TEST = "NON_RETRYABLE_TEST",
  FATAL = "FATAL",
}
