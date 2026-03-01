import YAML from "yaml";
import path from "node:path";
import type { WorkflowDefinition, StepDefinition, CompletionCheckDef } from "./types.js";
import type { ManagementConfig, ManagementAgentConfig, StepManagementConfig } from "./management/types.js";
import { VALID_MANAGEMENT_HOOKS, VALID_ENGINE_TYPES } from "./management/types.js";
import type { AgentCatalog, AgentProfile } from "./agent-catalog.js";
import { ErrorClass } from "../types/common.js";
import { parseDuration } from "./duration.js";

const VALID_WORKERS = new Set(["CODEX_CLI", "CLAUDE_CODE", "OPENCODE", "CUSTOM"]);
const VALID_CAPABILITIES = new Set(["READ", "EDIT", "RUN_TESTS", "RUN_COMMANDS"]);

const RESERVED_STEP_IDS = new Set([
  "_subworkflows",
  "_workflow",
  "_workflow.json",
  "_meta.json",
  "_resolved.json",
  "_convergence",
  "_management",
]);

// Names reserved within a step context directory.
// These collide with Roboppi's own metadata / internal artifact directories.
const RESERVED_ARTIFACT_NAMES = new Set([
  "_meta.json",
  "_resolved.json",
  "_convergence",
  "_stall",
  "_management",
]);

function assertValidStepId(stepId: string): void {
  assertPathSegment(stepId, `steps key "${stepId}"`);
  if (RESERVED_STEP_IDS.has(stepId)) {
    throw new WorkflowParseError(
      `step id "${stepId}" is reserved and cannot be used`,
    );
  }
}

export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowParseError";
  }
}

export interface WorkflowParseOptions {
  /** Optional agent catalog used to resolve step.agent references. */
  agents?: AgentCatalog;
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value === "") {
    throw new WorkflowParseError(`"${field}" must be a non-empty string`);
  }
}

function assertPathSegment(value: unknown, field: string): void {
  assertString(value, field);
  if (
    value.includes("..") ||
    value.includes(path.sep) ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new WorkflowParseError(`"${field}" must be a safe path segment (got "${value}")`);
  }
}

function assertArtifactName(value: unknown, field: string): void {
  assertPathSegment(value, field);
  const name = value as string;
  if (RESERVED_ARTIFACT_NAMES.has(name)) {
    throw new WorkflowParseError(
      `"${field}" uses reserved artifact name "${name}"`,
    );
  }
}

function validateOptionalString(value: unknown, field: string): void {
  if (value === undefined) return;
  assertString(value, field);
}

function validateOptionalBoolean(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw new WorkflowParseError(`"${field}" must be a boolean`);
  }
}

function validateOptionalNumber(value: unknown, field: string, opts?: { min?: number }): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorkflowParseError(`"${field}" must be a finite number`);
  }
  if (opts?.min !== undefined && value < opts.min) {
    throw new WorkflowParseError(`"${field}" must be >= ${opts.min}`);
  }
}

function validateOptionalStringArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new WorkflowParseError(`"${field}" must be an array`);
  }
  for (const v of value) {
    if (typeof v !== "string" || v.trim() === "") {
      throw new WorkflowParseError(`"${field}" must contain only non-empty strings`);
    }
  }
}

function validateConvergence(value: unknown, stepId: string): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowParseError(`steps.${stepId}.convergence must be an object`);
  }
  const obj = value as Record<string, unknown>;

  validateOptionalBoolean(obj["enabled"], `steps.${stepId}.convergence.enabled`);
  validateOptionalNumber(obj["stall_threshold"], `steps.${stepId}.convergence.stall_threshold`, { min: 1 });
  validateOptionalNumber(obj["max_stage"], `steps.${stepId}.convergence.max_stage`, { min: 1 });
  validateOptionalBoolean(obj["fail_on_max_stage"], `steps.${stepId}.convergence.fail_on_max_stage`);

  validateOptionalStringArray(obj["allowed_paths"], `steps.${stepId}.convergence.allowed_paths`);
  validateOptionalStringArray(obj["ignored_paths"], `steps.${stepId}.convergence.ignored_paths`);
  validateOptionalString(obj["diff_base_ref"], `steps.${stepId}.convergence.diff_base_ref`);
  validateOptionalString(obj["diff_base_ref_file"], `steps.${stepId}.convergence.diff_base_ref_file`);
  validateOptionalNumber(obj["max_changed_files"], `steps.${stepId}.convergence.max_changed_files`, { min: 1 });

  if (obj["stages"] !== undefined) {
    if (!Array.isArray(obj["stages"])) {
      throw new WorkflowParseError(`steps.${stepId}.convergence.stages must be an array`);
    }
    for (const s of obj["stages"]) {
      if (typeof s !== "object" || s === null || Array.isArray(s)) {
        throw new WorkflowParseError(`steps.${stepId}.convergence.stages entries must be objects`);
      }
      const st = s as Record<string, unknown>;
      validateOptionalNumber(st["stage"], `steps.${stepId}.convergence.stages[].stage`, { min: 2 });
      if (typeof st["stage"] !== "number") {
        throw new WorkflowParseError(`steps.${stepId}.convergence.stages[].stage is required`);
      }
      validateOptionalString(st["append_instructions"], `steps.${stepId}.convergence.stages[].append_instructions`);
    }
  }
}

const VALID_STALL_ACTIONS = new Set(["interrupt", "fail", "ignore"]);
const VALID_ERROR_CLASSES = new Set<string>(Object.values(ErrorClass));

function validateStallAction(value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowParseError(`${path} must be an object`);
  }
  const obj = value as Record<string, unknown>;

  if (typeof obj["action"] !== "string" || !VALID_STALL_ACTIONS.has(obj["action"])) {
    throw new WorkflowParseError(
      `${path}.action must be one of: ${[...VALID_STALL_ACTIONS].join(", ")} (got "${String(obj["action"])}")`,
    );
  }

  validateOptionalString(obj["error_class"], `${path}.error_class`);
  if (obj["error_class"] !== undefined && !VALID_ERROR_CLASSES.has(obj["error_class"] as string)) {
    throw new WorkflowParseError(
      `${path}.error_class must be one of: ${[...VALID_ERROR_CLASSES].join(", ")} (got "${String(obj["error_class"])}")`,
    );
  }
  validateOptionalStringArray(obj["fingerprint_prefix"], `${path}.fingerprint_prefix`);
  validateOptionalBoolean(obj["as_incomplete"], `${path}.as_incomplete`);
}

function validateStallPolicy(value: unknown, path: string): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowParseError(`${path} must be an object`);
  }
  const obj = value as Record<string, unknown>;

  validateOptionalBoolean(obj["enabled"], `${path}.enabled`);
  validateOptionalString(obj["no_output_timeout"], `${path}.no_output_timeout`);
  if (typeof obj["no_output_timeout"] === "string") {
    try {
      parseDuration(obj["no_output_timeout"]);
    } catch {
      throw new WorkflowParseError(
        `${path}.no_output_timeout: invalid duration "${obj["no_output_timeout"]}". Use formats like "30s", "5m", "1h30m"`,
      );
    }
  }

  const VALID_ACTIVITY_SOURCES = new Set(["worker_event", "any_event", "probe_only"]);
  if (obj["activity_source"] !== undefined) {
    if (typeof obj["activity_source"] !== "string" || !VALID_ACTIVITY_SOURCES.has(obj["activity_source"])) {
      throw new WorkflowParseError(
        `${path}.activity_source must be one of: ${[...VALID_ACTIVITY_SOURCES].join(", ")} (got "${String(obj["activity_source"])}")`,
      );
    }
  }

  // Validate probe sub-object
  if (obj["probe"] !== undefined) {
    if (typeof obj["probe"] !== "object" || obj["probe"] === null || Array.isArray(obj["probe"])) {
      throw new WorkflowParseError(`${path}.probe must be an object`);
    }
    const probe = obj["probe"] as Record<string, unknown>;

    assertString(probe["interval"], `${path}.probe.interval`);
    try {
      parseDuration(probe["interval"] as string);
    } catch {
      throw new WorkflowParseError(
        `${path}.probe.interval: invalid duration "${String(probe["interval"])}". Use formats like "10s", "1m", "30s"`,
      );
    }
    validateOptionalString(probe["timeout"], `${path}.probe.timeout`);
    if (typeof probe["timeout"] === "string") {
      try {
        parseDuration(probe["timeout"]);
      } catch {
        throw new WorkflowParseError(
          `${path}.probe.timeout: invalid duration "${probe["timeout"]}". Use formats like "5s", "30s", "1m"`,
        );
      }
    }
    assertString(probe["command"], `${path}.probe.command`);

    if (typeof probe["stall_threshold"] !== "number" || !Number.isFinite(probe["stall_threshold"])) {
      throw new WorkflowParseError(`"${path}.probe.stall_threshold" must be a finite number`);
    }
    if (probe["stall_threshold"] < 1) {
      throw new WorkflowParseError(`"${path}.probe.stall_threshold" must be >= 1`);
    }
    validateOptionalBoolean(probe["capture_stderr"], `${path}.probe.capture_stderr`);
    validateOptionalBoolean(probe["require_zero_exit"], `${path}.probe.require_zero_exit`);

    const VALID_PROBE_ERROR_ACTIONS = new Set(["ignore", "stall", "terminal"]);
    if (probe["on_probe_error"] !== undefined) {
      if (typeof probe["on_probe_error"] !== "string" || !VALID_PROBE_ERROR_ACTIONS.has(probe["on_probe_error"])) {
        throw new WorkflowParseError(
          `${path}.probe.on_probe_error must be one of: ${[...VALID_PROBE_ERROR_ACTIONS].join(", ")} (got "${String(probe["on_probe_error"])}")`,
        );
      }
    }
    validateOptionalNumber(probe["probe_error_threshold"], `${path}.probe.probe_error_threshold`, { min: 1 });
  }

  // Validate on_stall and on_terminal
  validateStallAction(obj["on_stall"], `${path}.on_stall`);
  validateStallAction(obj["on_terminal"], `${path}.on_terminal`);
}

function validateSentinel(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowParseError("sentinel must be an object");
  }
  const obj = value as Record<string, unknown>;

  validateOptionalBoolean(obj["enabled"], "sentinel.enabled");

  // Validate telemetry sub-object
  if (obj["telemetry"] !== undefined) {
    if (typeof obj["telemetry"] !== "object" || obj["telemetry"] === null || Array.isArray(obj["telemetry"])) {
      throw new WorkflowParseError("sentinel.telemetry must be an object");
    }
    const tel = obj["telemetry"] as Record<string, unknown>;
    validateOptionalString(tel["events_file"], "sentinel.telemetry.events_file");
    validateOptionalString(tel["state_file"], "sentinel.telemetry.state_file");
    validateOptionalBoolean(tel["include_worker_output"], "sentinel.telemetry.include_worker_output");
  }

  // Validate defaults sub-object
  if (obj["defaults"] !== undefined) {
    if (typeof obj["defaults"] !== "object" || obj["defaults"] === null || Array.isArray(obj["defaults"])) {
      throw new WorkflowParseError("sentinel.defaults must be an object");
    }
    const defs = obj["defaults"] as Record<string, unknown>;
    validateOptionalString(defs["no_output_timeout"], "sentinel.defaults.no_output_timeout");
    if (typeof defs["no_output_timeout"] === "string") {
      try {
        parseDuration(defs["no_output_timeout"]);
      } catch {
        throw new WorkflowParseError(
          `sentinel.defaults.no_output_timeout: invalid duration "${defs["no_output_timeout"]}". Use formats like "30s", "5m", "1h30m"`,
        );
      }
    }

    const VALID_ACTIVITY_SOURCES = new Set(["worker_event", "any_event", "probe_only"]);
    if (defs["activity_source"] !== undefined) {
      if (typeof defs["activity_source"] !== "string" || !VALID_ACTIVITY_SOURCES.has(defs["activity_source"])) {
        throw new WorkflowParseError(
          `sentinel.defaults.activity_source must be one of: ${[...VALID_ACTIVITY_SOURCES].join(", ")} (got "${String(defs["activity_source"])}")`,
        );
      }
    }

    // Validate interrupt sub-object
    if (defs["interrupt"] !== undefined) {
      if (typeof defs["interrupt"] !== "object" || defs["interrupt"] === null || Array.isArray(defs["interrupt"])) {
        throw new WorkflowParseError("sentinel.defaults.interrupt must be an object");
      }
      const intr = defs["interrupt"] as Record<string, unknown>;
      if (intr["strategy"] !== "cancel") {
        throw new WorkflowParseError(
          `sentinel.defaults.interrupt.strategy must be "cancel" (got "${String(intr["strategy"])}")`,
        );
      }
    }
  }
}

function validateWorker(value: unknown, field: string): void {
  if (typeof value !== "string" || !VALID_WORKERS.has(value)) {
    throw new WorkflowParseError(
      `"${field}" must be one of: ${[...VALID_WORKERS].join(", ")} (got "${String(value)}")`
    );
  }
}

function validateCapabilities(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new WorkflowParseError(`"${field}" must be a non-empty array`);
  }
  for (const cap of value) {
    if (typeof cap !== "string" || !VALID_CAPABILITIES.has(cap)) {
      throw new WorkflowParseError(
        `"${field}" contains invalid capability "${String(cap)}". Valid values: ${[...VALID_CAPABILITIES].join(", ")}`
      );
    }
  }
}

function normalizeAgentId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new WorkflowParseError(`"${field}" must be a non-empty string`);
  }
  return value.trim();
}

function combineInstructions(base: string | undefined, specific: string | undefined): string | undefined {
  const b = (base ?? "").trim();
  const s = (specific ?? "").trim();
  if (b && s) return `${b}\n\n${s}`;
  if (s) return s;
  if (b) return b;
  return undefined;
}

function resolveTaskLikeWithAgent(
  obj: Record<string, unknown>,
  fieldPrefix: string,
  agents?: AgentCatalog,
): Record<string, unknown> {
  if (obj["agent"] === undefined) return obj;

  const agentId = normalizeAgentId(obj["agent"], `${fieldPrefix}.agent`);
  if (!agents) {
    throw new WorkflowParseError(
      `${fieldPrefix}.agent is set to "${agentId}", but no agent catalog was provided (use --agents or set ROBOPPI_AGENTS_FILE)`,
    );
  }

  const agent = agents[agentId] as AgentProfile | undefined;
  if (!agent) {
    throw new WorkflowParseError(`${fieldPrefix}.agent references unknown agent "${agentId}"`);
  }

  const resolved: Record<string, unknown> = { ...obj };

  if (resolved["description"] === undefined && agent.description !== undefined) {
    resolved["description"] = agent.description;
  }

  if (resolved["worker"] === undefined && agent.worker !== undefined) {
    resolved["worker"] = agent.worker;
  }
  if (resolved["model"] === undefined && agent.model !== undefined) {
    resolved["model"] = agent.model;
  }
  if (resolved["capabilities"] === undefined && agent.capabilities !== undefined) {
    resolved["capabilities"] = agent.capabilities;
  }
  if (resolved["workspace"] === undefined && agent.workspace !== undefined) {
    resolved["workspace"] = agent.workspace;
  }
  if (resolved["timeout"] === undefined && agent.timeout !== undefined) {
    resolved["timeout"] = agent.timeout;
  }
  if (resolved["max_steps"] === undefined && agent.max_steps !== undefined) {
    resolved["max_steps"] = agent.max_steps;
  }
  if (resolved["max_command_time"] === undefined && agent.max_command_time !== undefined) {
    resolved["max_command_time"] = agent.max_command_time;
  }

  if (agent.base_instructions !== undefined) {
    const combined = combineInstructions(
      typeof agent.base_instructions === "string" ? agent.base_instructions : undefined,
      typeof resolved["instructions"] === "string" ? (resolved["instructions"] as string) : undefined,
    );
    if (combined !== undefined) {
      resolved["instructions"] = combined;
    }
  }

  return resolved;
}

function validateCompletionCheck(check: unknown, stepId: string, agents?: AgentCatalog): CompletionCheckDef {
  if (typeof check !== "object" || check === null) {
    throw new WorkflowParseError(`steps.${stepId}.completion_check must be an object`);
  }
  const obj = resolveTaskLikeWithAgent(
    check as Record<string, unknown>,
    `steps.${stepId}.completion_check`,
    agents,
  );

  assertString(obj["instructions"], `steps.${stepId}.completion_check.instructions`);
  validateWorker(obj["worker"], `steps.${stepId}.completion_check.worker`);
  validateCapabilities(obj["capabilities"], `steps.${stepId}.completion_check.capabilities`);
  validateOptionalString(obj["model"], `steps.${stepId}.completion_check.model`);
  validateOptionalString(obj["variant"], `steps.${stepId}.completion_check.variant`);

  // For non-shell completion checks, a machine-readable decision file is required.
  // CUSTOM checks use exit-code semantics and do not need decision_file.
  validateOptionalString(obj["decision_file"], `steps.${stepId}.completion_check.decision_file`);
  if (obj["worker"] !== "CUSTOM") {
    assertString(obj["decision_file"], `steps.${stepId}.completion_check.decision_file`);
  }

  // Validate stall policy (Sentinel guard, opt-in)
  validateStallPolicy(obj["stall"], `steps.${stepId}.completion_check.stall`);

  return obj as unknown as CompletionCheckDef;
}

function validateSubworkflowStep(stepId: string, obj: Record<string, unknown>): void {
  assertString(obj["workflow"], `steps.${stepId}.workflow`);

  // Fields that are exclusive to worker steps
  const workerOnlyFields = [
    "agent",
    "workspace",
    "worker",
    "model",
    "instructions",
    "capabilities",
    "outputs",
    "max_steps",
    "max_command_time",
  ] as const;
  for (const field of workerOnlyFields) {
    if (obj[field] !== undefined) {
      throw new WorkflowParseError(
        `steps.${stepId}.${field} cannot be used with workflow (subworkflow steps)`
      );
    }
  }

  // Subworkflow-only fields
  validateOptionalBoolean(obj["bubble_subworkflow_events"], `steps.${stepId}.bubble_subworkflow_events`);
  validateOptionalString(obj["subworkflow_event_prefix"], `steps.${stepId}.subworkflow_event_prefix`);
  if (obj["exports_mode"] !== undefined) {
    const v = obj["exports_mode"];
    if (typeof v !== "string" || !["merge", "replace"].includes(v)) {
      throw new WorkflowParseError(
        `steps.${stepId}.exports_mode must be "merge" or "replace"`,
      );
    }
  }

  // Validate exports array
  if (obj["exports"] !== undefined) {
    if (!Array.isArray(obj["exports"])) {
      throw new WorkflowParseError(`steps.${stepId}.exports must be an array`);
    }
      for (const exp of obj["exports"]) {
        if (typeof exp !== "object" || exp === null) {
          throw new WorkflowParseError(`steps.${stepId}.exports entries must be objects`);
        }
        const e = exp as Record<string, unknown>;
        assertPathSegment(e["from"], `steps.${stepId}.exports[].from`);
        assertArtifactName(e["artifact"], `steps.${stepId}.exports[].artifact`);
        if (e["as"] !== undefined) {
          assertArtifactName(e["as"], `steps.${stepId}.exports[].as`);
        }
      }
    }
}

function validateStep(stepId: string, step: unknown, agents?: AgentCatalog): StepDefinition {
  if (typeof step !== "object" || step === null) {
    throw new WorkflowParseError(`steps.${stepId} must be an object`);
  }

  const rawObj = step as Record<string, unknown>;

  // Subworkflow step: `workflow` is present
  if (rawObj["workflow"] !== undefined) {
    // workflow and worker are mutually exclusive
    if (rawObj["worker"] !== undefined) {
      throw new WorkflowParseError(
        `steps.${stepId}: "workflow" and "worker" are mutually exclusive`
      );
    }
    // Create a shallow copy so we can normalize/replace validated fields.
    const obj: Record<string, unknown> = { ...rawObj };

    validateSubworkflowStep(stepId, obj);

    // Validate common fields shared with worker steps
    validateOptionalString(obj["description"], `steps.${stepId}.description`);
    validateOptionalString(obj["timeout"], `steps.${stepId}.timeout`);
    validateOptionalNumber(obj["max_retries"], `steps.${stepId}.max_retries`, { min: 0 });

    if (obj["depends_on"] !== undefined) {
      if (!Array.isArray(obj["depends_on"])) {
        throw new WorkflowParseError(`steps.${stepId}.depends_on must be an array`);
      }
      for (const dep of obj["depends_on"]) {
        if (typeof dep !== "string") {
          throw new WorkflowParseError(`steps.${stepId}.depends_on must contain only strings`);
        }
      }
    }

    if (obj["inputs"] !== undefined) {
      if (!Array.isArray(obj["inputs"])) {
        throw new WorkflowParseError(`steps.${stepId}.inputs must be an array`);
      }
      for (const input of obj["inputs"]) {
        if (typeof input !== "object" || input === null) {
          throw new WorkflowParseError(`steps.${stepId}.inputs entries must be objects`);
        }
        const inp = input as Record<string, unknown>;
        assertPathSegment(inp["from"], `steps.${stepId}.inputs[].from`);
        assertArtifactName(inp["artifact"], `steps.${stepId}.inputs[].artifact`);
        if (inp["as"] !== undefined) {
          assertArtifactName(inp["as"], `steps.${stepId}.inputs[].as`);
        }
      }
    }

    if (obj["on_failure"] !== undefined) {
      if (!["retry", "continue", "abort"].includes(obj["on_failure"] as string)) {
        throw new WorkflowParseError(
          `steps.${stepId}.on_failure must be "retry", "continue", or "abort"`
        );
      }
    }

    // Validate completion_check + max_iterations constraint
    if (obj["completion_check"] !== undefined) {
      obj["completion_check"] = validateCompletionCheck(obj["completion_check"], stepId, agents);
      const maxIter = obj["max_iterations"];
      if (maxIter !== undefined) {
        if (typeof maxIter !== "number" || maxIter < 2) {
          throw new WorkflowParseError(
            `steps.${stepId}.max_iterations must be >= 2 when completion_check is defined (got ${String(maxIter)})`
          );
        }
      } else {
        throw new WorkflowParseError(
          `steps.${stepId}.max_iterations is required when completion_check is defined and must be >= 2`
        );
      }
    }

    // Validate convergence config (opt-in)
    validateConvergence(obj["convergence"], stepId);

    // Validate stall policy (Sentinel guard, opt-in)
    validateStallPolicy(obj["stall"], `steps.${stepId}.stall`);

    // Validate step-level management overrides
    const stepMgmt = validateStepManagement(obj["management"], stepId);
    if (stepMgmt !== undefined) {
      obj["management"] = stepMgmt;
    }

    // Validate on_iterations_exhausted enum
    if (obj["on_iterations_exhausted"] !== undefined) {
      if (!["abort", "continue"].includes(obj["on_iterations_exhausted"] as string)) {
        throw new WorkflowParseError(
          `steps.${stepId}.on_iterations_exhausted must be "abort" or "continue"`
        );
      }
    }

    return obj as unknown as StepDefinition;
  }

  // Worker step: existing logic
  const obj = resolveTaskLikeWithAgent(
    rawObj,
    `steps.${stepId}`,
    agents,
  );

  assertString(obj["instructions"], `steps.${stepId}.instructions`);
  validateWorker(obj["worker"], `steps.${stepId}.worker`);
  validateCapabilities(obj["capabilities"], `steps.${stepId}.capabilities`);
  validateOptionalString(obj["model"], `steps.${stepId}.model`);
  validateOptionalString(obj["variant"], `steps.${stepId}.variant`);

  if (obj["exports"] !== undefined) {
    throw new WorkflowParseError(
      `steps.${stepId}.exports cannot be used on worker steps (exports is for subworkflow steps only)`,
    );
  }

  if (obj["bubble_subworkflow_events"] !== undefined) {
    throw new WorkflowParseError(
      `steps.${stepId}.bubble_subworkflow_events cannot be used on worker steps (subworkflow steps only)`,
    );
  }
  if (obj["subworkflow_event_prefix"] !== undefined) {
    throw new WorkflowParseError(
      `steps.${stepId}.subworkflow_event_prefix cannot be used on worker steps (subworkflow steps only)`,
    );
  }
  if (obj["exports_mode"] !== undefined) {
    throw new WorkflowParseError(
      `steps.${stepId}.exports_mode cannot be used on worker steps (subworkflow steps only)`,
    );
  }

  // Validate depends_on is array of strings if present
  if (obj["depends_on"] !== undefined) {
    if (!Array.isArray(obj["depends_on"])) {
      throw new WorkflowParseError(`steps.${stepId}.depends_on must be an array`);
    }
    for (const dep of obj["depends_on"]) {
      if (typeof dep !== "string") {
        throw new WorkflowParseError(`steps.${stepId}.depends_on must contain only strings`);
      }
    }
  }

  // Validate inputs
  if (obj["inputs"] !== undefined) {
    if (!Array.isArray(obj["inputs"])) {
      throw new WorkflowParseError(`steps.${stepId}.inputs must be an array`);
    }
      for (const input of obj["inputs"]) {
        if (typeof input !== "object" || input === null) {
          throw new WorkflowParseError(`steps.${stepId}.inputs entries must be objects`);
        }
        const inp = input as Record<string, unknown>;
        assertPathSegment(inp["from"], `steps.${stepId}.inputs[].from`);
        assertArtifactName(inp["artifact"], `steps.${stepId}.inputs[].artifact`);
        if (inp["as"] !== undefined) {
          assertArtifactName(inp["as"], `steps.${stepId}.inputs[].as`);
        }
      }
    }

  // Validate outputs
  if (obj["outputs"] !== undefined) {
    if (!Array.isArray(obj["outputs"])) {
      throw new WorkflowParseError(`steps.${stepId}.outputs must be an array`);
    }
      for (const output of obj["outputs"]) {
        if (typeof output !== "object" || output === null) {
          throw new WorkflowParseError(`steps.${stepId}.outputs entries must be objects`);
        }
        const out = output as Record<string, unknown>;
        assertArtifactName(out["name"], `steps.${stepId}.outputs[].name`);
        assertString(out["path"], `steps.${stepId}.outputs[].path`);
      }
    }

  // Validate completion_check + max_iterations constraint
  if (obj["completion_check"] !== undefined) {
    obj["completion_check"] = validateCompletionCheck(obj["completion_check"], stepId, agents);
    const maxIter = obj["max_iterations"];
    if (maxIter !== undefined) {
      if (typeof maxIter !== "number" || maxIter < 2) {
        throw new WorkflowParseError(
          `steps.${stepId}.max_iterations must be >= 2 when completion_check is defined (got ${String(maxIter)})`
        );
      }
    } else {
      throw new WorkflowParseError(
        `steps.${stepId}.max_iterations is required when completion_check is defined and must be >= 2`
      );
    }
  }

  // Validate convergence config (opt-in)
  validateConvergence(obj["convergence"], stepId);

  // Validate stall policy (Sentinel guard, opt-in)
  validateStallPolicy(obj["stall"], `steps.${stepId}.stall`);

  // Validate step-level management overrides
  const stepMgmt2 = validateStepManagement(obj["management"], stepId);
  if (stepMgmt2 !== undefined) {
    obj["management"] = stepMgmt2;
  }

  // Validate on_failure enum
  if (obj["on_failure"] !== undefined) {
    if (!["retry", "continue", "abort"].includes(obj["on_failure"] as string)) {
      throw new WorkflowParseError(
        `steps.${stepId}.on_failure must be "retry", "continue", or "abort"`
      );
    }
  }

  // Validate on_iterations_exhausted enum
  if (obj["on_iterations_exhausted"] !== undefined) {
    if (!["abort", "continue"].includes(obj["on_iterations_exhausted"] as string)) {
      throw new WorkflowParseError(
        `steps.${stepId}.on_iterations_exhausted must be "abort" or "continue"`
      );
    }
  }

  return obj as unknown as StepDefinition;
}

function validateManagementAgent(value: unknown, fieldPrefix: string, agents?: AgentCatalog): ManagementAgentConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowParseError(`${fieldPrefix} must be an object`);
  }
  const obj = value as Record<string, unknown>;

  const hasWorker = obj["worker"] !== undefined;
  const hasAgent = obj["agent"] !== undefined;

  if (hasWorker && hasAgent) {
    throw new WorkflowParseError(
      `${fieldPrefix}: "worker" and "agent" are mutually exclusive`,
    );
  }

  if (hasWorker) {
    validateWorker(obj["worker"], `${fieldPrefix}.worker`);
  }
  if (hasAgent) {
    assertString(obj["agent"], `${fieldPrefix}.agent`);
    const agentId = (obj["agent"] as string).trim();
    if (!agents) {
      throw new WorkflowParseError(
        `${fieldPrefix}.agent is set to "${agentId}", but no agent catalog was provided (use --agents or set ROBOPPI_AGENTS_FILE)`,
      );
    }
    if (!agents[agentId]) {
      throw new WorkflowParseError(`${fieldPrefix}.agent references unknown agent "${agentId}"`);
    }
  }

  // Engine type validation
  if (obj["engine"] !== undefined) {
    assertString(obj["engine"], `${fieldPrefix}.engine`);
    if (!VALID_ENGINE_TYPES.has(obj["engine"] as string)) {
      throw new WorkflowParseError(
        `${fieldPrefix}.engine: invalid value "${obj["engine"]}". Valid values: ${[...VALID_ENGINE_TYPES].join(", ")}`,
      );
    }
  }

  validateOptionalString(obj["model"], `${fieldPrefix}.model`);
  if (obj["capabilities"] !== undefined) {
    validateCapabilities(obj["capabilities"], `${fieldPrefix}.capabilities`);
  }
  if (obj["timeout"] !== undefined) {
    assertString(obj["timeout"], `${fieldPrefix}.timeout`);
    try {
      parseDuration(obj["timeout"] as string);
    } catch {
      throw new WorkflowParseError(
        `${fieldPrefix}.timeout: invalid duration "${obj["timeout"]}". Use formats like "30s", "5m", "1h30m"`,
      );
    }
  }
  validateOptionalString(obj["base_instructions"], `${fieldPrefix}.base_instructions`);
  validateOptionalString(obj["workspace"], `${fieldPrefix}.workspace`);
  validateOptionalNumber(obj["max_steps"], `${fieldPrefix}.max_steps`, { min: 1 });
  if (obj["max_command_time"] !== undefined) {
    assertString(obj["max_command_time"], `${fieldPrefix}.max_command_time`);
    try {
      parseDuration(obj["max_command_time"] as string);
    } catch {
      throw new WorkflowParseError(
        `${fieldPrefix}.max_command_time: invalid duration "${obj["max_command_time"]}". Use formats like "30s", "5m"`,
      );
    }
  }

  return obj as unknown as ManagementAgentConfig;
}

function validateManagementHooks(value: unknown, fieldPrefix: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowParseError(`${fieldPrefix} must be an object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!VALID_MANAGEMENT_HOOKS.has(key as any)) {
      throw new WorkflowParseError(
        `${fieldPrefix} contains unknown hook "${key}". Valid hooks: ${[...VALID_MANAGEMENT_HOOKS].join(", ")}`,
      );
    }
    if (typeof obj[key] !== "boolean") {
      throw new WorkflowParseError(`${fieldPrefix}.${key} must be a boolean`);
    }
  }
}

function validateManagement(value: unknown, agents?: AgentCatalog): ManagementConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowParseError("management must be an object");
  }
  const obj = value as Record<string, unknown>;

  validateOptionalBoolean(obj["enabled"], "management.enabled");

  if (obj["enabled"] === true && obj["agent"] === undefined) {
    throw new WorkflowParseError(
      "management.agent is required when management.enabled is true",
    );
  }

  if (obj["agent"] !== undefined) {
    validateManagementAgent(obj["agent"], "management.agent", agents);
  }

  if (obj["hooks"] !== undefined) {
    validateManagementHooks(obj["hooks"], "management.hooks");
  }

  if (obj["periodic_interval"] !== undefined) {
    assertString(obj["periodic_interval"], "management.periodic_interval");
    try {
      parseDuration(obj["periodic_interval"] as string);
    } catch {
      throw new WorkflowParseError(
        `management.periodic_interval: invalid duration "${obj["periodic_interval"]}". Use formats like "2m", "30s"`,
      );
    }
  }

  if (obj["max_consecutive_interventions"] !== undefined) {
    if (typeof obj["max_consecutive_interventions"] !== "number" || !Number.isFinite(obj["max_consecutive_interventions"])) {
      throw new WorkflowParseError("management.max_consecutive_interventions must be a finite number");
    }
    if (obj["max_consecutive_interventions"] < 1) {
      throw new WorkflowParseError("management.max_consecutive_interventions must be >= 1");
    }
  }

  if (obj["min_remaining_time"] !== undefined) {
    assertString(obj["min_remaining_time"], "management.min_remaining_time");
    try {
      parseDuration(obj["min_remaining_time"] as string);
    } catch {
      throw new WorkflowParseError(
        `management.min_remaining_time: invalid duration "${obj["min_remaining_time"]}". Use formats like "2m", "30s"`,
      );
    }
  }

  return obj as unknown as ManagementConfig;
}

function validateStepManagement(value: unknown, stepId: string): StepManagementConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowParseError(`steps.${stepId}.management must be an object`);
  }
  const obj = value as Record<string, unknown>;

  // Reject unknown keys to prevent silent typos.
  const allowed = new Set<string>([
    "enabled",
    "context_hint",
    ...[...VALID_MANAGEMENT_HOOKS],
  ]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new WorkflowParseError(
        `steps.${stepId}.management contains unknown key "${key}". Valid keys: ${[...allowed].join(", ")}`,
      );
    }
  }

  if (obj["enabled"] !== undefined) {
    if (typeof obj["enabled"] !== "boolean") {
      throw new WorkflowParseError(`steps.${stepId}.management.enabled must be a boolean`);
    }
  }

  if (obj["context_hint"] !== undefined) {
    if (typeof obj["context_hint"] !== "string") {
      throw new WorkflowParseError(`steps.${stepId}.management.context_hint must be a string`);
    }
  }

  for (const hook of VALID_MANAGEMENT_HOOKS) {
    if (obj[hook] !== undefined && typeof obj[hook] !== "boolean") {
      throw new WorkflowParseError(`steps.${stepId}.management.${hook} must be a boolean`);
    }
  }

  return obj as unknown as StepManagementConfig;
}

const MAX_YAML_SIZE = 1024 * 1024; // 1MB

/**
 * Parse YAML content into a validated WorkflowDefinition.
 */
export function parseWorkflow(yamlContent: string, options: WorkflowParseOptions = {}): WorkflowDefinition {
  if (yamlContent.length > MAX_YAML_SIZE) {
    throw new WorkflowParseError(
      `YAML content too large: ${yamlContent.length} bytes (max ${MAX_YAML_SIZE})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlContent);
  } catch (e) {
    throw new WorkflowParseError(`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new WorkflowParseError("Workflow YAML must be an object");
  }

  const doc = parsed as Record<string, unknown>;

  // Top-level required fields
  assertString(doc["name"], "name");

  if (doc["version"] !== "1") {
    throw new WorkflowParseError(`"version" must be "1" (got "${String(doc["version"])}")`);
  }

  assertString(doc["timeout"], "timeout");
  validateOptionalBoolean(doc["create_branch"], "create_branch");
  validateOptionalString(doc["branch_transition_step"], "branch_transition_step");
  validateOptionalString(doc["expected_work_branch"], "expected_work_branch");

  // Validate sentinel config (opt-in)
  validateSentinel(doc["sentinel"]);

  // Validate management config (opt-in)
  const managementConfig = validateManagement(doc["management"], options.agents);

  if (typeof doc["steps"] !== "object" || doc["steps"] === null || Array.isArray(doc["steps"])) {
    throw new WorkflowParseError('"steps" must be an object');
  }

  const stepsObj = doc["steps"] as Record<string, unknown>;
  const stepIds = Object.keys(stepsObj);
  if (stepIds.length === 0) {
    throw new WorkflowParseError('"steps" must contain at least one step');
  }

  const validatedSteps: Record<string, StepDefinition> = {};
  for (const stepId of stepIds) {
    assertValidStepId(stepId);
    validatedSteps[stepId] = validateStep(stepId, stepsObj[stepId], options.agents);
  }

  if (typeof doc["branch_transition_step"] === "string") {
    const transitionStep = doc["branch_transition_step"];
    if (!(transitionStep in validatedSteps)) {
      throw new WorkflowParseError(
        `"branch_transition_step" references unknown step "${transitionStep}"`,
      );
    }
  }

  return {
    name: doc["name"] as string,
    version: "1",
    description: typeof doc["description"] === "string" ? doc["description"] : undefined,
    timeout: doc["timeout"] as string,
    concurrency: typeof doc["concurrency"] === "number" ? doc["concurrency"] : undefined,
    context_dir: typeof doc["context_dir"] === "string" ? doc["context_dir"] : undefined,
    create_branch: typeof doc["create_branch"] === "boolean" ? doc["create_branch"] : undefined,
    branch_transition_step:
      typeof doc["branch_transition_step"] === "string"
        ? doc["branch_transition_step"]
        : undefined,
    expected_work_branch:
      typeof doc["expected_work_branch"] === "string"
        ? doc["expected_work_branch"]
        : undefined,
    sentinel: doc["sentinel"] !== undefined
      ? (doc["sentinel"] as WorkflowDefinition["sentinel"])
      : undefined,
    management: managementConfig,
    steps: validatedSteps,
  };
}
