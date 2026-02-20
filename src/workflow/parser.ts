import YAML from "yaml";
import type { WorkflowDefinition, StepDefinition, CompletionCheckDef } from "./types.js";
import type { AgentCatalog, AgentProfile } from "./agent-catalog.js";

const VALID_WORKERS = new Set(["CODEX_CLI", "CLAUDE_CODE", "OPENCODE", "CUSTOM"]);
const VALID_CAPABILITIES = new Set(["READ", "EDIT", "RUN_TESTS", "RUN_COMMANDS"]);

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

  // For non-shell completion checks, a machine-readable decision file is required.
  // CUSTOM checks use exit-code semantics and do not need decision_file.
  validateOptionalString(obj["decision_file"], `steps.${stepId}.completion_check.decision_file`);
  if (obj["worker"] !== "CUSTOM") {
    assertString(obj["decision_file"], `steps.${stepId}.completion_check.decision_file`);
  }
  return obj as unknown as CompletionCheckDef;
}

function validateStep(stepId: string, step: unknown, agents?: AgentCatalog): StepDefinition {
  if (typeof step !== "object" || step === null) {
    throw new WorkflowParseError(`steps.${stepId} must be an object`);
  }
  const obj = resolveTaskLikeWithAgent(
    step as Record<string, unknown>,
    `steps.${stepId}`,
    agents,
  );

  assertString(obj["instructions"], `steps.${stepId}.instructions`);
  validateWorker(obj["worker"], `steps.${stepId}.worker`);
  validateCapabilities(obj["capabilities"], `steps.${stepId}.capabilities`);
  validateOptionalString(obj["model"], `steps.${stepId}.model`);

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
      assertString(inp["from"], `steps.${stepId}.inputs[].from`);
      assertString(inp["artifact"], `steps.${stepId}.inputs[].artifact`);
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
      assertString(out["name"], `steps.${stepId}.outputs[].name`);
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
    steps: validatedSteps,
  };
}
