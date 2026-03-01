import type { ErrorClass } from "../types/common.js";
import type { ManagementConfig, StepManagementConfig } from "./management/types.js";

export type DurationString = string; // "200ms", "5m", "30s", "2h", "1h30m"

// ---------------------------------------------------------------------------
// Sentinel – workflow-level configuration
// ---------------------------------------------------------------------------

export interface SentinelTelemetryConfig {
  events_file?: string;
  state_file?: string;
  include_worker_output?: boolean;
}

export interface SentinelInterruptConfig {
  strategy: "cancel";
}

export interface SentinelDefaultsConfig {
  no_output_timeout?: DurationString;
  activity_source?: "worker_event" | "any_event" | "probe_only";
  interrupt?: SentinelInterruptConfig;
}

export interface SentinelConfig {
  enabled?: boolean;
  telemetry?: SentinelTelemetryConfig;
  defaults?: SentinelDefaultsConfig;
}

// ---------------------------------------------------------------------------
// Stall policy – step-level guard consumed by Sentinel
// ---------------------------------------------------------------------------

export interface StallProbeConfig {
  interval: DurationString;
  timeout?: DurationString;
  command: string;
  stall_threshold: number;
  /** Whether to capture probe stderr in probe.jsonl. Default: false (opt-in). */
  capture_stderr?: boolean;
  /** When true, probe success requires exit_code === 0 AND valid JSON.
   *  Default: false (JSON-only, exit code is recorded but does not affect success).
   */
  require_zero_exit?: boolean;
  /**
   * Action when probe consecutively fails (non-JSON, timeout, non-zero exit, etc.).
   * - "ignore" (default): probe failures are logged but don't trigger actions
   * - "stall": treat consecutive failures as a stall condition (triggers on_stall)
   * - "terminal": treat consecutive failures as terminal (triggers on_terminal)
   */
  on_probe_error?: "ignore" | "stall" | "terminal";
  /**
   * Number of consecutive probe failures before triggering `on_probe_error` action.
   * Default: 3. Must be >= 1.
   */
  probe_error_threshold?: number;
}

export interface StallActionConfig {
  action: "interrupt" | "fail" | "ignore";
  error_class?: string;
  fingerprint_prefix?: string[];
  as_incomplete?: boolean;
}

export interface StallPolicy {
  enabled?: boolean;
  no_output_timeout?: DurationString;
  /** Controls which event timestamps drive no_output_timeout.
   *  - "worker_event" (default): uses worker stdout/stderr event timestamps
   *  - "any_event": uses the most recent of worker_event, step_phase, step_state
   *  - "probe_only": disables timer-based no_output_timeout; rely on probe
   */
  activity_source?: "worker_event" | "any_event" | "probe_only";
  probe?: StallProbeConfig;
  on_stall?: StallActionConfig;
  on_terminal?: StallActionConfig;
}

// ---------------------------------------------------------------------------
// WorkflowDefinition
// ---------------------------------------------------------------------------

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
  /** Optional: Sentinel autonomous oversight configuration. */
  sentinel?: SentinelConfig;
  /** Optional: Management Agent configuration. */
  management?: ManagementConfig;
  steps: Record<string, StepDefinition>;
}

export interface ExportRef {
  from: string;      // child workflow step ID
  artifact: string;  // artifact name
  as?: string;       // name in parent context (default: artifact)
}

// TODO: Refactor StepDefinition into a discriminated union
// (WorkerStepDefinition | SubworkflowStepDefinition) keyed on the presence
// of `workflow` vs `worker`.  Deferred due to large blast radius.
export interface StepDefinition {
  description?: string;
  /** Optional agent profile id (resolved from an agent catalog). */
  agent?: string;
  worker?: "CODEX_CLI" | "CLAUDE_CODE" | "OPENCODE" | "CUSTOM";
  /** Optional model identifier for LLM-backed workers (adapter-specific format). */
  model?: string;
  /** Optional model variant / reasoning-effort hint (worker-specific). */
  variant?: string;
  workspace?: string;
  instructions?: string;
  capabilities?: ("READ" | "EDIT" | "RUN_TESTS" | "RUN_COMMANDS")[];
  /** Subworkflow YAML path (mutually exclusive with worker). */
  workflow?: string;
  /** Export child artifacts into parent context (subworkflow steps only). */
  exports?: ExportRef[];

  /**
   * Whether to forward (bubble) child subworkflow events into the parent sink.
   *
   * - true: child steps appear as distinct steps in the TUI (prefixed step ids)
   * - false: child worker events are aggregated into the parent step id (blackbox)
   */
  bubble_subworkflow_events?: boolean;

  /** Optional prefix used when bubbling subworkflow events (default: "auto"). */
  subworkflow_event_prefix?: string;

  /** Controls how subworkflow exports are copied into the parent context. */
  exports_mode?: "merge" | "replace";
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

  /** Optional: stall guard policy consumed by Sentinel. */
  stall?: StallPolicy;

  /** Optional: step-level management agent overrides. */
  management?: StepManagementConfig;
}

export function isWorkerStep(step: StepDefinition): step is StepDefinition & {
  worker: NonNullable<StepDefinition["worker"]>;
  instructions: string;
  capabilities: NonNullable<StepDefinition["capabilities"]>;
} {
  return step.workflow === undefined && step.worker !== undefined;
}

export function isSubworkflowStep(step: StepDefinition): step is StepDefinition & {
  workflow: string;
} {
  return step.workflow !== undefined;
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
  /** Optional model variant / reasoning-effort hint (worker-specific). */
  variant?: string;
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

  /** Optional: stall guard policy consumed by Sentinel. */
  stall?: StallPolicy;
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
  /** Management agent chose to skip; does NOT block downstream. */
  OMITTED = "OMITTED",
}

export interface StepState {
  status: StepStatus;
  iteration: number;
  maxIterations: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  errorClass?: ErrorClass;

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

  /** Internal flag: management pre_step hook is in progress. */
  managementPending?: boolean;
}

export interface WorkflowState {
  workflowId: string;
  name: string;
  status: WorkflowStatus;
  steps: Record<string, StepState>;
  startedAt: number;
  completedAt?: number;
}
