import type { UUID, BudgetLimits, TraceContext } from "./common.js";

export enum JobType {
  LLM = "LLM",
  TOOL = "TOOL",
  WORKER_TASK = "WORKER_TASK",
  PLUGIN_EVENT = "PLUGIN_EVENT",
  MAINTENANCE = "MAINTENANCE",
}

export enum PriorityClass {
  INTERACTIVE = "INTERACTIVE",
  BATCH = "BATCH",
}

export interface Priority {
  value: number;
  class: PriorityClass;
}

export interface Job {
  jobId: UUID;
  type: JobType;
  priority: Priority;
  key?: string; // Idempotency Key
  payload: unknown;
  limits: BudgetLimits;
  context: TraceContext;
}
