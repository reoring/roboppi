/**
 * Types for the Workflow Management Agent feature.
 *
 * A Management Agent is an LLM-backed supervisor that observes, advises, and
 * intervenes in workflow execution at runtime via structured hook points.
 */

import type { DurationString } from "../types.js";

// ---------------------------------------------------------------------------
// Environment variable constants
// ---------------------------------------------------------------------------

export const ENV_MANAGEMENT_HOOK_ID = "ROBOPPI_MANAGEMENT_HOOK_ID";
export const ENV_MANAGEMENT_INPUT_FILE = "ROBOPPI_MANAGEMENT_INPUT_FILE";
export const ENV_MANAGEMENT_DECISION_FILE = "ROBOPPI_MANAGEMENT_DECISION_FILE";

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export type ManagementHook =
  | "pre_step"
  | "post_step"
  | "pre_check"
  | "post_check"
  | "on_stall"
  | "periodic";

export const VALID_MANAGEMENT_HOOKS = new Set<ManagementHook>([
  "pre_step",
  "post_step",
  "pre_check",
  "post_check",
  "on_stall",
  "periodic",
]);

// ---------------------------------------------------------------------------
// Directives (management agent → executor)
// ---------------------------------------------------------------------------

export type ManagementDirective =
  | { action: "proceed" }
  | { action: "skip"; reason: string }
  | { action: "modify_instructions"; append: string }
  | { action: "force_complete"; reason: string }
  | { action: "force_incomplete"; reason: string }
  | { action: "retry"; reason: string; modify_instructions?: string }
  | { action: "abort_workflow"; reason: string }
  | { action: "adjust_timeout"; timeout: DurationString; reason: string }
  | { action: "annotate"; message: string };

export type ManagementAction = ManagementDirective["action"];

export const VALID_MANAGEMENT_ACTIONS = new Set<ManagementAction>([
  "proceed",
  "skip",
  "modify_instructions",
  "force_complete",
  "force_incomplete",
  "retry",
  "abort_workflow",
  "adjust_timeout",
  "annotate",
]);

/** Maximum string length for append / reason / message fields. */
export const MAX_STRING_FIELD_LENGTH = 4096;

// ---------------------------------------------------------------------------
// DSL configuration
// ---------------------------------------------------------------------------

export interface ManagementHooksConfig {
  pre_step?: boolean;
  post_step?: boolean;
  pre_check?: boolean;
  post_check?: boolean;
  on_stall?: boolean;
  periodic?: boolean;
}

export interface ManagementAgentConfig {
  /** Worker kind (mutually exclusive with `agent`). */
  worker?: "CODEX_CLI" | "CLAUDE_CODE" | "OPENCODE" | "CUSTOM";
  /** Agent catalog reference (mutually exclusive with `worker`). */
  agent?: string;
  /** Engine type: "worker" (default, file-based) or "pi" (Pi SDK in-process). */
  engine?: "worker" | "pi";
  model?: string;
  capabilities?: ("READ" | "EDIT" | "RUN_TESTS" | "RUN_COMMANDS")[];
  timeout?: DurationString;
  base_instructions?: string;
  workspace?: string;
  max_steps?: number;
  max_command_time?: DurationString;
}

export interface ManagementConfig {
  enabled?: boolean;
  agent?: ManagementAgentConfig;
  hooks?: ManagementHooksConfig;
  periodic_interval?: DurationString;
  max_consecutive_interventions?: number;
  min_remaining_time?: DurationString;
}

/** Step-level management overrides. */
export interface StepManagementConfig {
  enabled?: boolean;
  context_hint?: string;
  pre_step?: boolean;
  post_step?: boolean;
  pre_check?: boolean;
  post_check?: boolean;
  on_stall?: boolean;
  periodic?: boolean;
}

// ---------------------------------------------------------------------------
// Hook context (input.json)
// ---------------------------------------------------------------------------

export interface HookContext {
  hook_id: string;
  hook: ManagementHook;
  step_id: string;
  /** File/directory pointers to reduce filesystem scanning by the agent. */
  paths?: {
    context_dir: string;
    workflow_state_file: string;
    management_decisions_log: string;
    management_inv_dir: string;
    step_dir: string;
    step_meta_file: string;
    step_resolved_file: string;
    convergence_dir: string;
    stall_dir: string;
  };
  workflow_state: {
    steps: Record<string, {
      status: string;
      iteration: number;
      maxIterations: number;
      startedAt?: number;
      completedAt?: number;
      error?: string;
      convergenceStage?: number;
      convergenceStallCount?: number;
    }>;
  };
  step_state: {
    status: string;
    iteration: number;
    maxIterations: number;
  };
  context_hint?: string;
  stall_event?: unknown;
  check_result?: unknown;
}

// ---------------------------------------------------------------------------
// Decision resolution result
// ---------------------------------------------------------------------------

export interface ManagementDecisionResolution {
  directive: ManagementDirective;
  hookIdMatch: boolean | undefined;
  source: "file-json" | "none";
  reason?: string;
  reasoning?: string;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Decisions log entry (decisions.jsonl)
// ---------------------------------------------------------------------------

export interface DecisionsLogEntry {
  ts: number;
  hook_id: string;
  hook: ManagementHook;
  step_id: string;
  directive: ManagementDirective;
  applied: boolean;
  wallTimeMs: number;
  source: "file-json" | "none" | "decided" | "tool-call" | "fallback";
  reason?: string;
  reasoning?: string;
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Directive validation result
// ---------------------------------------------------------------------------

export interface DirectiveValidationResult {
  valid: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Default proceed directive
// ---------------------------------------------------------------------------

export const DEFAULT_PROCEED_DIRECTIVE: ManagementDirective = { action: "proceed" };

// ---------------------------------------------------------------------------
// ManagementAgentEngine — pluggable engine abstraction (§15.3)
// ---------------------------------------------------------------------------

/** Result from a management agent engine hook invocation. */
export interface ManagementAgentEngineResult {
  directive: ManagementDirective;
  meta?: { reasoning?: string; confidence?: number };
  /** Optional engine-side fallback reason for diagnostics. */
  reason?: string;
  /**
   * Whether the directive came from an actual agent decision ("decided")
   * or was a fallback due to timeout/error/missing ("fallback").
   * Defaults to "decided" if not set.
   */
  source?: "decided" | "fallback";
}

/**
 * Engine abstraction: the executor does not care whether the management
 * agent runs via a Roboppi worker process or via Pi SDK.
 *
 * Implementations:
 * - WorkerEngine: existing file-based worker invocation (env vars + decision.json)
 * - PiSdkEngine: Pi createAgentSession() with persistent session + typed tool
 */
export interface ManagementAgentEngine {
  invokeHook(args: {
    hook: ManagementHook;
    hookId: string;
    hookStartedAt: number;
    context: HookContext;
    invocationPaths?: {
      invDir: string;
      inputFile: string;
      decisionFile: string;
    };
    budget: {
      deadlineAt: number;
      maxSteps?: number;
      maxCommandTimeMs?: number;
    };
    abortSignal: AbortSignal;
  }): Promise<ManagementAgentEngineResult>;

  dispose(): Promise<void>;
}

/** Valid engine type values. */
export const VALID_ENGINE_TYPES = new Set(["worker", "pi"]);
