export type DurationString = string; // "5m", "30s", "2h", "1h30m"

export interface WorkflowDefinition {
  name: string;
  version: "1";
  description?: string;
  timeout: DurationString;
  concurrency?: number;
  context_dir?: string;
  steps: Record<string, StepDefinition>;
}

export interface StepDefinition {
  description?: string;
  worker: "CODEX_CLI" | "CLAUDE_CODE" | "OPENCODE" | "CUSTOM";
  workspace?: string;
  instructions: string;
  capabilities: ("READ" | "EDIT" | "RUN_TESTS" | "RUN_COMMANDS")[];
  depends_on?: string[];
  inputs?: InputRef[];
  outputs?: OutputDef[];
  timeout?: DurationString;
  max_retries?: number;
  max_steps?: number;
  max_command_time?: DurationString;
  completion_check?: CompletionCheckDef;
  max_iterations?: number;
  on_iterations_exhausted?: "abort" | "continue";
  on_failure?: "retry" | "continue" | "abort";
}

export interface CompletionCheckDef {
  worker: "CODEX_CLI" | "CLAUDE_CODE" | "OPENCODE" | "CUSTOM";
  instructions: string;
  capabilities: ("READ" | "EDIT" | "RUN_TESTS" | "RUN_COMMANDS")[];
  timeout?: DurationString;
}

export interface InputRef {
  from: string;
  artifact: string;
  as?: string;
}

export interface OutputDef {
  name: string;
  path: string;
  type?: string;
}

export enum WorkflowStatus {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  SUCCEEDED = "SUCCEEDED",
  FAILED = "FAILED",
  TIMED_OUT = "TIMED_OUT",
  CANCELLED = "CANCELLED",
}

export enum StepStatus {
  PENDING = "PENDING",
  READY = "READY",
  RUNNING = "RUNNING",
  CHECKING = "CHECKING",
  SUCCEEDED = "SUCCEEDED",
  FAILED = "FAILED",
  INCOMPLETE = "INCOMPLETE",
  SKIPPED = "SKIPPED",
  CANCELLED = "CANCELLED",
}

export interface StepState {
  status: StepStatus;
  iteration: number;
  maxIterations: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface WorkflowState {
  workflowId: string;
  name: string;
  status: WorkflowStatus;
  steps: Record<string, StepState>;
  startedAt: number;
  completedAt?: number;
}
