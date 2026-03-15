import YAML from "yaml";
import { parseDuration } from "../workflow/duration.js";
import type {
  FileInboxTaskSourceConfig,
  TaskClarificationConfig,
  TaskOrchestratorActivityConfig,
  GitHubIssueTaskSourceConfig,
  GitHubPullRequestTaskSourceConfig,
  TaskLandingConfig,
  TaskOrchestratorConfig,
  TaskOrchestratorRuntimeConfig,
  TaskRouteDef,
  TaskRouteMatch,
  TaskSourceConfig,
  TaskWorkspaceMode,
} from "./types.js";

const MAX_YAML_SIZE = 1024 * 1024; // 1MB
const VALID_SOURCE_TYPES = new Set(["github_issue", "github_pull_request", "file_inbox"]);
const VALID_WORKSPACE_MODES = new Set<TaskWorkspaceMode>(["shared", "worktree"]);
const VALID_PRIORITY_CLASSES = new Set(["interactive", "normal", "background"]);
const VALID_LANDING_MODES = new Set(["disabled", "manual"]);

export class TaskOrchestratorParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskOrchestratorParseError";
  }
}

function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskOrchestratorParseError(`"${field}" must be an object`);
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TaskOrchestratorParseError(`"${field}" must be a non-empty string`);
  }
}

function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TaskOrchestratorParseError(`"${field}" must be a non-empty array of strings`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new TaskOrchestratorParseError(`"${field}" must contain only non-empty strings`);
    }
    result.push(item);
  }
  return result;
}

function validateStringMap(value: unknown, field: string): Record<string, string> {
  assertObject(value, field);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new TaskOrchestratorParseError(`"${field}.${key}" must be a string`);
    }
    result[key] = entry;
  }
  return result;
}

function validateGitHubIssueSource(
  sourceId: string,
  value: Record<string, unknown>,
): GitHubIssueTaskSourceConfig {
  assertString(value["repo"], `sources.${sourceId}.repo`);
  if (value["labels"] !== undefined) {
    validateStringArray(value["labels"], `sources.${sourceId}.labels`);
  }
  if (value["local_path"] !== undefined) {
    assertString(value["local_path"], `sources.${sourceId}.local_path`);
  }
  if (value["workspace_path"] !== undefined) {
    assertString(value["workspace_path"], `sources.${sourceId}.workspace_path`);
  }
  if (value["poll_every"] !== undefined) {
    assertString(value["poll_every"], `sources.${sourceId}.poll_every`);
  }
  return value as unknown as GitHubIssueTaskSourceConfig;
}

function validateGitHubPullRequestSource(
  sourceId: string,
  value: Record<string, unknown>,
): GitHubPullRequestTaskSourceConfig {
  assertString(value["repo"], `sources.${sourceId}.repo`);
  if (value["labels"] !== undefined) {
    validateStringArray(value["labels"], `sources.${sourceId}.labels`);
  }
  if (value["base_branches"] !== undefined) {
    validateStringArray(value["base_branches"], `sources.${sourceId}.base_branches`);
  }
  if (value["local_path"] !== undefined) {
    assertString(value["local_path"], `sources.${sourceId}.local_path`);
  }
  if (value["workspace_path"] !== undefined) {
    assertString(value["workspace_path"], `sources.${sourceId}.workspace_path`);
  }
  if (value["poll_every"] !== undefined) {
    assertString(value["poll_every"], `sources.${sourceId}.poll_every`);
  }
  return value as unknown as GitHubPullRequestTaskSourceConfig;
}

function validateFileInboxSource(
  sourceId: string,
  value: Record<string, unknown>,
): FileInboxTaskSourceConfig {
  assertString(value["path"], `sources.${sourceId}.path`);
  if (value["pattern"] !== undefined) {
    assertString(value["pattern"], `sources.${sourceId}.pattern`);
  }
  if (value["poll_every"] !== undefined) {
    assertString(value["poll_every"], `sources.${sourceId}.poll_every`);
  }
  return value as unknown as FileInboxTaskSourceConfig;
}

function validateSourceConfig(sourceId: string, value: unknown): TaskSourceConfig {
  assertObject(value, `sources.${sourceId}`);
  const obj = value as Record<string, unknown>;
  const type = obj["type"];
  if (typeof type !== "string" || !VALID_SOURCE_TYPES.has(type)) {
    throw new TaskOrchestratorParseError(
      `"sources.${sourceId}.type" must be one of: ${[...VALID_SOURCE_TYPES].join(", ")} (got "${String(type)}")`,
    );
  }

  switch (type) {
    case "github_issue":
      return validateGitHubIssueSource(sourceId, obj);
    case "github_pull_request":
      return validateGitHubPullRequestSource(sourceId, obj);
    case "file_inbox":
      return validateFileInboxSource(sourceId, obj);
    default:
      throw new TaskOrchestratorParseError(`Unsupported source type: ${String(type)}`);
  }
}

function validateRouteMatch(
  routeId: string,
  value: unknown,
  sourceTypes: ReadonlySet<string>,
): TaskRouteMatch {
  assertObject(value, `routes.${routeId}.when`);
  const obj = value as Record<string, unknown>;

  if (obj["source"] !== undefined) {
    assertString(obj["source"], `routes.${routeId}.when.source`);
    const sourceType = obj["source"] as string;
    if (!sourceTypes.has(sourceType)) {
      throw new TaskOrchestratorParseError(
        `"routes.${routeId}.when.source" references source type "${sourceType}" not present in "sources"`,
      );
    }
  }
  if (obj["repository"] !== undefined) {
    assertString(obj["repository"], `routes.${routeId}.when.repository`);
  }
  if (obj["requested_action"] !== undefined) {
    assertString(obj["requested_action"], `routes.${routeId}.when.requested_action`);
  }
  if (obj["labels_any"] !== undefined) {
    validateStringArray(obj["labels_any"], `routes.${routeId}.when.labels_any`);
  }
  if (obj["labels_all"] !== undefined) {
    validateStringArray(obj["labels_all"], `routes.${routeId}.when.labels_all`);
  }
  return obj as unknown as TaskRouteMatch;
}

function validateRouteDef(
  routeId: string,
  value: unknown,
  sourceTypes: ReadonlySet<string>,
): TaskRouteDef {
  assertObject(value, `routes.${routeId}`);
  const obj = value as Record<string, unknown>;

  if (obj["when"] !== undefined) {
    validateRouteMatch(routeId, obj["when"], sourceTypes);
  }

  assertString(obj["workflow"], `routes.${routeId}.workflow`);

  if (typeof obj["workspace_mode"] !== "string" || !VALID_WORKSPACE_MODES.has(obj["workspace_mode"] as TaskWorkspaceMode)) {
    throw new TaskOrchestratorParseError(
      `"routes.${routeId}.workspace_mode" must be "shared" or "worktree"`,
    );
  }

  if (obj["workspace_mode"] === "worktree") {
    assertString(obj["branch_name"], `routes.${routeId}.branch_name`);
  } else if (obj["branch_name"] !== undefined && typeof obj["branch_name"] !== "string") {
    throw new TaskOrchestratorParseError(`"routes.${routeId}.branch_name" must be a string`);
  }

  if (obj["base_ref"] !== undefined) {
    assertString(obj["base_ref"], `routes.${routeId}.base_ref`);
  }

  if (obj["agents_files"] !== undefined) {
    validateStringArray(obj["agents_files"], `routes.${routeId}.agents_files`);
  }

  if (obj["env"] !== undefined) {
    validateStringMap(obj["env"], `routes.${routeId}.env`);
  }

  if (obj["priority_class"] !== undefined) {
    if (
      typeof obj["priority_class"] !== "string" ||
      !VALID_PRIORITY_CLASSES.has(obj["priority_class"])
    ) {
      throw new TaskOrchestratorParseError(
        `"routes.${routeId}.priority_class" must be one of: ${[...VALID_PRIORITY_CLASSES].join(", ")}`,
      );
    }
  }

  if (obj["management"] !== undefined) {
    assertObject(obj["management"], `routes.${routeId}.management`);
    const management = obj["management"] as Record<string, unknown>;
    if (
      management["enabled"] !== undefined &&
      typeof management["enabled"] !== "boolean"
    ) {
      throw new TaskOrchestratorParseError(
        `"routes.${routeId}.management.enabled" must be a boolean`,
      );
    }
  }

  return obj as unknown as TaskRouteDef;
}

function validateLanding(value: unknown): TaskLandingConfig {
  if (value === undefined) {
    return { mode: "manual" };
  }
  assertObject(value, "landing");
  const obj = value as Record<string, unknown>;
  if (typeof obj["mode"] !== "string" || !VALID_LANDING_MODES.has(obj["mode"])) {
    throw new TaskOrchestratorParseError(
      `"landing.mode" must be one of: ${[...VALID_LANDING_MODES].join(", ")}`,
    );
  }
  return obj as unknown as TaskLandingConfig;
}

function validateActivity(value: unknown): TaskOrchestratorActivityConfig {
  if (value === undefined) {
    return {
      github: {
        enabled: false,
      },
    };
  }
  assertObject(value, "activity");
  const obj = value as Record<string, unknown>;
  const githubValue = obj["github"];
  if (githubValue === undefined) {
    return {
      github: {
        enabled: false,
      },
    };
  }
  assertObject(githubValue, "activity.github");
  const github = githubValue as Record<string, unknown>;
  if (
    github["enabled"] !== undefined &&
    typeof github["enabled"] !== "boolean"
  ) {
    throw new TaskOrchestratorParseError(
      '"activity.github.enabled" must be a boolean',
    );
  }
  return {
    github: {
      enabled: github["enabled"] === true,
    },
  };
}

function validateClarification(value: unknown): TaskClarificationConfig {
  if (value === undefined) {
    return {
      enabled: true,
      max_round_trips: 2,
    };
  }

  assertObject(value, "clarification");
  const obj = value as Record<string, unknown>;
  if (
    obj["enabled"] !== undefined
    && typeof obj["enabled"] !== "boolean"
  ) {
    throw new TaskOrchestratorParseError('"clarification.enabled" must be a boolean');
  }
  if (
    obj["max_round_trips"] !== undefined
    && (!Number.isInteger(obj["max_round_trips"]) || Number(obj["max_round_trips"]) <= 0)
  ) {
    throw new TaskOrchestratorParseError(
      '"clarification.max_round_trips" must be a positive integer',
    );
  }

  const reminderAfter = obj["reminder_after"];
  if (reminderAfter !== undefined) {
    assertString(reminderAfter, "clarification.reminder_after");
    try {
      parseDuration(reminderAfter);
    } catch {
      throw new TaskOrchestratorParseError(
        `clarification.reminder_after: invalid duration "${reminderAfter}". Use formats like "30s", "5m", "1h30m"`,
      );
    }
  }

  const blockAfter = obj["block_after"];
  if (blockAfter !== undefined) {
    assertString(blockAfter, "clarification.block_after");
    try {
      parseDuration(blockAfter);
    } catch {
      throw new TaskOrchestratorParseError(
        `clarification.block_after: invalid duration "${blockAfter}". Use formats like "30s", "5m", "1h30m"`,
      );
    }
  }

  if (typeof reminderAfter === "string" && typeof blockAfter === "string") {
    if (parseDuration(reminderAfter) >= parseDuration(blockAfter)) {
      throw new TaskOrchestratorParseError(
        '"clarification.block_after" must be greater than "clarification.reminder_after"',
      );
    }
  }

  return {
    enabled: obj["enabled"] !== false,
    max_round_trips:
      typeof obj["max_round_trips"] === "number"
        ? obj["max_round_trips"]
        : 2,
    reminder_after:
      typeof reminderAfter === "string" && reminderAfter.trim() !== ""
        ? reminderAfter
        : undefined,
    block_after:
      typeof blockAfter === "string" && blockAfter.trim() !== ""
        ? blockAfter
        : undefined,
  };
}

function validateRuntime(value: unknown): TaskOrchestratorRuntimeConfig {
  if (value === undefined) {
    return {
      poll_every: "30s",
    };
  }
  assertObject(value, "runtime");
  const obj = value as Record<string, unknown>;
  const pollEvery = obj["poll_every"];
  if (pollEvery !== undefined) {
    assertString(pollEvery, "runtime.poll_every");
    try {
      parseDuration(pollEvery);
    } catch {
      throw new TaskOrchestratorParseError(
        `runtime.poll_every: invalid duration "${pollEvery}". Use formats like "30s", "5m", "1h30m"`,
      );
    }
  }
  if (
    obj["max_active_instances"] !== undefined &&
    (!Number.isInteger(obj["max_active_instances"]) ||
      Number(obj["max_active_instances"]) <= 0)
  ) {
    throw new TaskOrchestratorParseError(
      '"runtime.max_active_instances" must be a positive integer',
    );
  }
  return {
    poll_every:
      typeof pollEvery === "string" && pollEvery.trim() !== ""
        ? pollEvery
        : "30s",
    max_active_instances:
      typeof obj["max_active_instances"] === "number"
        ? obj["max_active_instances"]
        : undefined,
  };
}

export function parseTaskOrchestratorConfig(yamlContent: string): TaskOrchestratorConfig {
  if (yamlContent.length > MAX_YAML_SIZE) {
    throw new TaskOrchestratorParseError(
      `YAML content too large: ${yamlContent.length} bytes (max ${MAX_YAML_SIZE})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlContent);
  } catch (err) {
    throw new TaskOrchestratorParseError(
      `Invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  assertObject(parsed, "config");
  const doc = parsed as Record<string, unknown>;

  assertString(doc["name"], "name");
  if (doc["version"] !== "1") {
    throw new TaskOrchestratorParseError(
      `"version" must be "1" (got "${String(doc["version"])}")`,
    );
  }

  assertObject(doc["sources"], "sources");
  const sourcesObj = doc["sources"] as Record<string, unknown>;
  const sourceIds = Object.keys(sourcesObj);
  if (sourceIds.length === 0) {
    throw new TaskOrchestratorParseError(`"sources" must contain at least one source`);
  }

  const sources: Record<string, TaskSourceConfig> = {};
  for (const sourceId of sourceIds) {
    sources[sourceId] = validateSourceConfig(sourceId, sourcesObj[sourceId]);
  }
  const configuredSourceTypes = new Set(
    Object.values(sources).map((source) => source.type),
  );

  assertObject(doc["routes"], "routes");
  const routesObj = doc["routes"] as Record<string, unknown>;
  const routeIds = Object.keys(routesObj);
  if (routeIds.length === 0) {
    throw new TaskOrchestratorParseError(`"routes" must contain at least one route`);
  }

  const routes: Record<string, TaskRouteDef> = {};
  for (const routeId of routeIds) {
    routes[routeId] = validateRouteDef(routeId, routesObj[routeId], configuredSourceTypes);
  }

  return {
    name: doc["name"] as string,
    version: "1",
    state_dir:
      typeof doc["state_dir"] === "string" && doc["state_dir"].trim() !== ""
        ? doc["state_dir"]
        : "./.roboppi-task",
    runtime: validateRuntime(doc["runtime"]),
    clarification: validateClarification(doc["clarification"]),
    activity: validateActivity(doc["activity"]),
    sources,
    routes,
    landing: validateLanding(doc["landing"]),
  };
}
