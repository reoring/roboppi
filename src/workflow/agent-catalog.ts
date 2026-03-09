import YAML from "yaml";

import type { StepDefinition, DurationString } from "./types.js";
import type { McpServerConfig } from "../types/mcp-server.js";

export type AgentWorkerKind = NonNullable<StepDefinition["worker"]>;
export type AgentCapability = NonNullable<StepDefinition["capabilities"]>[number];

export interface AgentProfile {
  description?: string;

  /** Default worker kind when referenced via step.agent. */
  worker?: AgentWorkerKind;

  /** Optional CLI arguments forwarded to the selected resident worker adapter. */
  defaultArgs?: string[];

  /** Optional Claude Code MCP config files or JSON strings. */
  mcp_configs?: string[];

  /** Optional generic MCP server definitions for worker-native injection. */
  mcp_servers?: McpServerConfig[];

  /** Optional Claude Code flag to ignore non-explicit MCP sources. */
  strict_mcp_config?: boolean;

  /** Default model identifier (adapter-specific). */
  model?: string;

  /** Optional model variant / reasoning effort hint (worker-specific). */
  variant?: string;

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
  "MAILBOX",
  "TASKS",
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

function validateOptionalStringArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new AgentCatalogParseError(`"${field}" must be an array`);
  }
  for (const item of value) {
    if (typeof item !== "string") {
      throw new AgentCatalogParseError(`"${field}" must contain only strings`);
    }
  }
}

function validateOptionalBoolean(value: unknown, field: string): void {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw new AgentCatalogParseError(`"${field}" must be a boolean`);
  }
}

function validateOptionalStringRecord(value: unknown, field: string): void {
  if (value === undefined) return;
  assertObject(value, field);
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new AgentCatalogParseError(`"${field}.${key}" must be a string`);
    }
  }
}

function validateOptionalMcpServers(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new AgentCatalogParseError(`"${field}" must be an array`);
  }
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    assertObject(item, `${field}[${i}]`);
    validateOptionalNonEmptyString(item["name"], `${field}[${i}].name`);
    const name = item["name"];
    if (typeof name === "string" && !/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new AgentCatalogParseError(
        `"${field}[${i}].name" must match /^[A-Za-z0-9_-]+$/ (got "${name}")`,
      );
    }
    validateOptionalNonEmptyString(item["command"], `${field}[${i}].command`);
    validateOptionalStringArray(item["args"], `${field}[${i}].args`);
    validateOptionalStringRecord(item["env"], `${field}[${i}].env`);
    validateOptionalNonEmptyString(item["url"], `${field}[${i}].url`);
    validateOptionalNonEmptyString(
      item["bearer_token_env_var"],
      `${field}[${i}].bearer_token_env_var`,
    );
    validateOptionalBoolean(item["enabled"], `${field}[${i}].enabled`);

    const hasCommand = typeof item["command"] === "string";
    const hasUrl = typeof item["url"] === "string";
    if (hasCommand === hasUrl) {
      throw new AgentCatalogParseError(
        `"${field}[${i}]" must specify exactly one of "command" or "url"`,
      );
    }
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
    validateOptionalStringArray(obj["defaultArgs"], `agents.${agentId}.defaultArgs`);
    validateOptionalStringArray(obj["mcp_configs"], `agents.${agentId}.mcp_configs`);
    validateOptionalMcpServers(obj["mcp_servers"], `agents.${agentId}.mcp_servers`);
    validateOptionalBoolean(obj["strict_mcp_config"], `agents.${agentId}.strict_mcp_config`);
    validateOptionalNonEmptyString(obj["model"], `agents.${agentId}.model`);
    validateOptionalNonEmptyString(obj["variant"], `agents.${agentId}.variant`);
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
