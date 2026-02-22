import YAML from "yaml";

import type { StepDefinition, DurationString } from "./types.js";

export type AgentWorkerKind = NonNullable<StepDefinition["worker"]>;
export type AgentCapability = NonNullable<StepDefinition["capabilities"]>[number];

export interface AgentProfile {
  description?: string;

  /** Default worker kind when referenced via step.agent. */
  worker?: AgentWorkerKind;

  /** Default model identifier (adapter-specific). */
  model?: string;

  /** Optional instructions prepended before step.instructions. */
  base_instructions?: string;

  /** Default capabilities when step.capabilities is omitted. */
  capabilities?: AgentCapability[];

  /** Default workspace (resolved from workflow workspace). */
  workspace?: string;

  /** Default step timeout (DurationString). */
  timeout?: DurationString;

  /** Default max steps for the worker. */
  max_steps?: number;

  /** Default per-command timeout (DurationString). */
  max_command_time?: DurationString;
}

export type AgentCatalog = Record<string, AgentProfile>;

export class AgentCatalogParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCatalogParseError";
  }
}

const VALID_WORKERS = new Set<AgentWorkerKind>([
  "CODEX_CLI",
  "CLAUDE_CODE",
  "OPENCODE",
  "CUSTOM",
]);

const VALID_CAPABILITIES = new Set<AgentCapability>([
  "READ",
  "EDIT",
  "RUN_TESTS",
  "RUN_COMMANDS",
]);

function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentCatalogParseError(`"${field}" must be an object`);
  }
}

function validateOptionalNonEmptyString(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentCatalogParseError(`"${field}" must be a non-empty string`);
  }
}

function validateOptionalString(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new AgentCatalogParseError(`"${field}" must be a string`);
  }
}

function validateOptionalWorker(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !VALID_WORKERS.has(value as AgentWorkerKind)) {
    throw new AgentCatalogParseError(
      `"${field}" must be one of: ${[...VALID_WORKERS].join(", ")} (got "${String(value)}")`,
    );
  }
}

function validateOptionalCapabilities(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new AgentCatalogParseError(`"${field}" must be an array`);
  }
  for (const cap of value) {
    if (typeof cap !== "string" || !VALID_CAPABILITIES.has(cap as AgentCapability)) {
      throw new AgentCatalogParseError(
        `"${field}" contains invalid capability "${String(cap)}". Valid values: ${[...VALID_CAPABILITIES].join(", ")}`,
      );
    }
  }
}

function validateOptionalNumber(value: unknown, field: string, opts?: { min?: number }): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AgentCatalogParseError(`"${field}" must be a finite number`);
  }
  if (opts?.min !== undefined && value < opts.min) {
    throw new AgentCatalogParseError(`"${field}" must be >= ${opts.min}`);
  }
}

const MAX_YAML_SIZE = 1024 * 1024; // 1MB

/**
 * Parse an agent catalog YAML.
 *
 * Format:
 *
 * version: "1"
 * agents:
 *   <agent_id>:
 *     worker: OPENCODE
 *     model: openai/gpt-5.2
 *     base_instructions: |
 *       ...
 *     capabilities: [READ]
 */
export function parseAgentCatalog(yamlContent: string): AgentCatalog {
  if (yamlContent.length > MAX_YAML_SIZE) {
    throw new AgentCatalogParseError(
      `YAML content too large: ${yamlContent.length} bytes (max ${MAX_YAML_SIZE})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlContent);
  } catch (e) {
    throw new AgentCatalogParseError(`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }

  assertObject(parsed, "root");
  const doc = parsed as Record<string, unknown>;

  if (doc["version"] !== "1") {
    throw new AgentCatalogParseError(`"version" must be "1" (got "${String(doc["version"])}")`);
  }

  assertObject(doc["agents"], "agents");
  const agentsObj = doc["agents"] as Record<string, unknown>;

  const catalog: AgentCatalog = {};
  for (const [agentId, raw] of Object.entries(agentsObj)) {
    if (agentId.trim() === "") {
      throw new AgentCatalogParseError(`"agents" must not contain an empty key`);
    }
    assertObject(raw, `agents.${agentId}`);
    const obj = raw as Record<string, unknown>;

    validateOptionalNonEmptyString(obj["description"], `agents.${agentId}.description`);
    validateOptionalWorker(obj["worker"], `agents.${agentId}.worker`);
    validateOptionalNonEmptyString(obj["model"], `agents.${agentId}.model`);
    // Allow empty string to intentionally clear inherited base_instructions.
    validateOptionalString(obj["base_instructions"], `agents.${agentId}.base_instructions`);
    validateOptionalCapabilities(obj["capabilities"], `agents.${agentId}.capabilities`);
    validateOptionalNonEmptyString(obj["workspace"], `agents.${agentId}.workspace`);
    validateOptionalNonEmptyString(obj["timeout"], `agents.${agentId}.timeout`);
    validateOptionalNumber(obj["max_steps"], `agents.${agentId}.max_steps`, { min: 1 });
    validateOptionalNonEmptyString(obj["max_command_time"], `agents.${agentId}.max_command_time`);

    catalog[agentId] = obj as unknown as AgentProfile;
  }

  return catalog;
}
