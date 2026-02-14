import YAML from "yaml";
import type { WorkflowDefinition, StepDefinition, CompletionCheckDef } from "./types.js";

const VALID_WORKERS = new Set(["CODEX_CLI", "CLAUDE_CODE", "OPENCODE", "CUSTOM"]);
const VALID_CAPABILITIES = new Set(["READ", "EDIT", "RUN_TESTS", "RUN_COMMANDS"]);

export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowParseError";
  }
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

function validateCompletionCheck(check: unknown, stepId: string): CompletionCheckDef {
  if (typeof check !== "object" || check === null) {
    throw new WorkflowParseError(`steps.${stepId}.completion_check must be an object`);
  }
  const obj = check as Record<string, unknown>;
  assertString(obj["instructions"], `steps.${stepId}.completion_check.instructions`);
  validateWorker(obj["worker"], `steps.${stepId}.completion_check.worker`);
  validateCapabilities(obj["capabilities"], `steps.${stepId}.completion_check.capabilities`);
  validateOptionalString(obj["model"], `steps.${stepId}.completion_check.model`);
  validateOptionalString(obj["decision_file"], `steps.${stepId}.completion_check.decision_file`);
  return obj as unknown as CompletionCheckDef;
}

function validateStep(stepId: string, step: unknown): StepDefinition {
  if (typeof step !== "object" || step === null) {
    throw new WorkflowParseError(`steps.${stepId} must be an object`);
  }
  const obj = step as Record<string, unknown>;

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
    validateCompletionCheck(obj["completion_check"], stepId);
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
export function parseWorkflow(yamlContent: string): WorkflowDefinition {
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
    validatedSteps[stepId] = validateStep(stepId, stepsObj[stepId]);
  }

  return {
    name: doc["name"] as string,
    version: "1",
    description: typeof doc["description"] === "string" ? doc["description"] : undefined,
    timeout: doc["timeout"] as string,
    concurrency: typeof doc["concurrency"] === "number" ? doc["concurrency"] : undefined,
    context_dir: typeof doc["context_dir"] === "string" ? doc["context_dir"] : undefined,
    steps: validatedSteps,
  };
}
