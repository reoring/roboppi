export type DurationString = string; // "200ms", "5m", "30s", "2h", "1h30m"

export interface WorkflowDefinition {
  name: string;
  version: "1";
  description?: string;
  timeout: DurationString;
  concurrency?: number;
  context_dir?: string;
  /** Whether the workflow is expected to create/switch to a work branch. */
  create_branch?: boolean;
  /** Optional step id where the expected work branch transition occurs. */
  branch_transition_step?: string;
  /** Optional explicit expected work branch at startup. */
  expected_work_branch?: string;
  steps: Record<string, StepDefinition>;
}

export interface StepDefinition {
  description?: string;
  /** Optional agent profile id (resolved from an agent catalog). */
  agent?: string;
  worker: "CODEX_CLI" | "CLAUDE_CODE" | "OPENCODE" | "CUSTOM";
  /** Optional model identifier for LLM-backed workers (adapter-specific format). */
  model?: string;
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

  /** Optional: convergence control for completion_check loops (opt-in). */
  convergence?: ConvergenceDef;
}

export interface ConvergenceStageDef {
  /** 2..max_stage (stage 1 is the default / no special handling). */
  stage: number;

  /** Instructions appended to the step.instructions when this stage is active. */
  append_instructions?: string;
}

export interface ConvergenceDef {
  /** Enables convergence control. Default: false. */
  enabled?: boolean;

  /**
   * Number of consecutive iterations with an identical failure fingerprint set
   * before escalating to the next stage.
   *
   * Default: 2.
   */
  stall_threshold?: number;

  /**
   * Maximum stage (>= 1). Default: 3.
   * When the controller would escalate to max_stage, it fails the step unless
   * fail_on_max_stage is set to false.
   */
  max_stage?: number;

  /** Default: true. */
  fail_on_max_stage?: boolean;

  /** Optional: per-stage instruction overlays. */
  stages?: ConvergenceStageDef[];

  /** Optional: enforce file scope by allowed path patterns (workspace-relative). */
  allowed_paths?: string[];

  /** Optional: paths to ignore for scope/budget checks. */
  ignored_paths?: string[];

  /** Optional: git base ref (e.g. origin/main) used for diff/scope checks. */
  diff_base_ref?: string;

  /** Optional: file containing git base ref (first line). */
  diff_base_ref_file?: string;

  /** Optional: diff budget (count of changed files, tracked + untracked). */
  max_changed_files?: number;
}

export interface CompletionCheckDef {
  /** Optional agent profile id (resolved from an agent catalog). */
  agent?: string;
  worker: "CODEX_CLI" | "CLAUDE_CODE" | "OPENCODE" | "CUSTOM";
  /** Optional model identifier for LLM-backed workers (adapter-specific format). */
  model?: string;
  instructions: string;
  capabilities: ("READ" | "EDIT" | "RUN_TESTS" | "RUN_COMMANDS")[];
  timeout?: DurationString;

  /**
   * Optional: derive completion decision from a file written in the workspace.
   *
   * Supported file values (trimmed, case-insensitive):
   * - Structured JSON:
   *   {
   *     "decision": "complete" | "incomplete",
   *     "check_id": "<runner-generated token>",
   *     "reasons": ["..."],
   *     "fingerprints": ["..."]
   *   }
   *   (check_id is optional for backward compatibility; reasons/fingerprints are optional).
   * - COMPLETE / PASS      => complete
   * - INCOMPLETE / FAIL    => incomplete
   */
  decision_file?: string;
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

  /**
   * Convergence guard state for completion_check.
   * Used to fail-fast when the completion decision channel is consistently broken.
   */
  completionInfraFailureCount?: number;
  lastCompletionInfraFailure?: string;

  /** Convergence Controller stage (1 = normal). */
  convergenceStage?: number;

  /** Consecutive stall counter for identical failure sets. */
  convergenceStallCount?: number;

  /** Last computed stall key (hash). */
  convergenceLastStallKey?: string;
}

export interface WorkflowState {
  workflowId: string;
  name: string;
  status: WorkflowStatus;
  steps: Record<string, StepState>;
  startedAt: number;
  completedAt?: number;
}
