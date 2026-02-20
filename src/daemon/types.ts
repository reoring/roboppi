import type { DurationString } from "../workflow/types.js";
import type { WorkflowState } from "../workflow/types.js";

// ---------------------------------------------------------------------------
// Top-level Daemon configuration
// ---------------------------------------------------------------------------

export interface DaemonConfig {
  name: string;
  version: "1";
  description?: string;
  workspace: string;
  /** Optional agent catalog YAML used to resolve workflow step.agent references. */
  agents_file?: string;
  log_dir?: string;
  max_concurrent_workflows?: number;
  state_dir?: string;
  events: Record<string, EventSourceDef>;
  triggers: Record<string, TriggerDef>;
}

// ---------------------------------------------------------------------------
// Event source definitions
// ---------------------------------------------------------------------------

export type EventSourceDef =
  | CronEventDef
  | IntervalEventDef
  | FSWatchEventDef
  | WebhookEventDef
  | CommandEventDef;

export interface CronEventDef {
  type: "cron";
  schedule: string; // cron expression e.g. "*/5 * * * *"
}

export interface IntervalEventDef {
  type: "interval";
  every: DurationString; // e.g. "30s", "5m"
}

export interface FSWatchEventDef {
  type: "fswatch";
  paths: string[];
  ignore?: string[];
  events?: Array<"create" | "modify" | "delete">;
}

export interface WebhookEventDef {
  type: "webhook";
  path: string;
  port?: number;
  secret?: string;
  method?: string;
}

export interface CommandEventDef {
  type: "command";
  command: string;
  interval: DurationString;
  trigger_on?: "change" | "always"; // default: "change"
}

// ---------------------------------------------------------------------------
// Trigger definition
// ---------------------------------------------------------------------------

export interface TriggerDef {
  on: string; // event ID reference
  workflow: string; // workflow YAML path
  enabled?: boolean; // default: true

  // Filtering
  filter?: Record<string, FilterValue>;

  // Rate control
  debounce?: DurationString;
  cooldown?: DurationString;
  max_queue?: number; // default: 10

  // LLM evaluation gate
  evaluate?: EvaluateDef;

  // Context injection
  context?: TriggerContext;

  // Result analysis
  analyze?: AnalyzeDef;

  // Failure handling
  on_workflow_failure?: "ignore" | "retry" | "pause_trigger";
  max_retries?: number; // default: 3
}

export type FilterValue =
  | string
  | number
  | boolean
  | { pattern: string }
  | { in: Array<string | number | boolean> };

export interface EvaluateDef {
  worker: WorkerKindString;
  instructions: string;
  capabilities: CapabilityString[];
  timeout?: DurationString;
}

export interface AnalyzeDef {
  worker: WorkerKindString;
  instructions: string;
  capabilities: CapabilityString[];
  timeout?: DurationString;
  outputs?: Array<{ name: string; path: string }>;
}

export interface TriggerContext {
  env?: Record<string, string>;
  last_result?: boolean;
  event_payload?: boolean;
}

export type WorkerKindString = "CODEX_CLI" | "CLAUDE_CODE" | "OPENCODE" | "CUSTOM";
export type CapabilityString = "READ" | "EDIT" | "RUN_TESTS" | "RUN_COMMANDS";

// ---------------------------------------------------------------------------
// Runtime event types
// ---------------------------------------------------------------------------

export interface DaemonEvent {
  sourceId: string;
  timestamp: number;
  payload: EventPayload;
}

export type EventPayload =
  | CronPayload
  | IntervalPayload
  | FSWatchPayload
  | WebhookPayload
  | CommandPayload;

export interface CronPayload {
  type: "cron";
  schedule: string;
  firedAt: number;
}

export interface IntervalPayload {
  type: "interval";
  firedAt: number;
}

export interface FSWatchPayload {
  type: "fswatch";
  changes: Array<{
    path: string;
    event: "create" | "modify" | "delete";
  }>;
}

export interface WebhookPayload {
  type: "webhook";
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface CommandPayload {
  type: "command";
  stdout: string;
  exitCode: number;
  changed: boolean;
}

// ---------------------------------------------------------------------------
// Execution records (state persistence)
// ---------------------------------------------------------------------------

export interface ExecutionRecord {
  triggerId: string;
  event: DaemonEvent;
  workflowResult: WorkflowState;
  startedAt: number;
  completedAt: number;
  evaluateResult?: "run" | "skip";
  analyzeOutput?: string;
}

export interface TriggerState {
  enabled: boolean;
  lastFiredAt: number | null;
  cooldownUntil: number | null;
  executionCount: number;
  consecutiveFailures: number;
}

export interface DaemonState {
  pid: number;
  startedAt: number;
  configName: string;
  status: "running" | "stopping" | "stopped";
}

// ---------------------------------------------------------------------------
// Trigger result (internal)
// ---------------------------------------------------------------------------

export type TriggerAction =
  | { action: "executed"; result: WorkflowState }
  | { action: "filtered" }
  | { action: "debounced" }
  | { action: "cooldown" }
  | { action: "skipped_by_evaluate" }
  | { action: "queued"; triggerId: string }
  | { action: "queue_full" }
  | { action: "disabled" };
