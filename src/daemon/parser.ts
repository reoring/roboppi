import YAML from "yaml";
import type {
  DaemonConfig,
  EventSourceDef,
  TriggerDef,
  FilterValue,
  EvaluateDef,
  AnalyzeDef,
  TriggerContext,
} from "./types.js";

const VALID_WORKERS = new Set(["CODEX_CLI", "CLAUDE_CODE", "OPENCODE", "CUSTOM"]);
const VALID_CAPABILITIES = new Set(["READ", "EDIT", "RUN_TESTS", "RUN_COMMANDS"]);
const VALID_EVENT_TYPES = new Set(["cron", "interval", "fswatch", "webhook", "command"]);
const VALID_FSWATCH_EVENTS = new Set(["create", "modify", "delete"]);
const VALID_ON_WORKFLOW_FAILURE = new Set(["ignore", "retry", "pause_trigger"]);
const VALID_TRIGGER_ON = new Set(["change", "always"]);

export class DaemonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonParseError";
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value === "") {
    throw new DaemonParseError(`"${field}" must be a non-empty string`);
  }
}

function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DaemonParseError(`"${field}" must be an object`);
  }
}

function validateWorker(value: unknown, field: string): void {
  if (typeof value !== "string" || !VALID_WORKERS.has(value)) {
    throw new DaemonParseError(
      `"${field}" must be one of: ${[...VALID_WORKERS].join(", ")} (got "${String(value)}")`
    );
  }
}

function validateCapabilities(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DaemonParseError(`"${field}" must be a non-empty array`);
  }
  for (const cap of value) {
    if (typeof cap !== "string" || !VALID_CAPABILITIES.has(cap)) {
      throw new DaemonParseError(
        `"${field}" contains invalid capability "${String(cap)}". Valid values: ${[...VALID_CAPABILITIES].join(", ")}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Event source validation
// ---------------------------------------------------------------------------

function validateCronEvent(obj: Record<string, unknown>, eventId: string): void {
  assertString(obj["schedule"], `events.${eventId}.schedule`);
}

function validateIntervalEvent(obj: Record<string, unknown>, eventId: string): void {
  assertString(obj["every"], `events.${eventId}.every`);
}

function validateFSWatchEvent(obj: Record<string, unknown>, eventId: string): void {
  if (!Array.isArray(obj["paths"]) || obj["paths"].length === 0) {
    throw new DaemonParseError(`"events.${eventId}.paths" must be a non-empty array of strings`);
  }
  for (const p of obj["paths"]) {
    if (typeof p !== "string") {
      throw new DaemonParseError(`"events.${eventId}.paths" must contain only strings`);
    }
  }
  if (obj["ignore"] !== undefined) {
    if (!Array.isArray(obj["ignore"])) {
      throw new DaemonParseError(`"events.${eventId}.ignore" must be an array of strings`);
    }
    for (const ig of obj["ignore"]) {
      if (typeof ig !== "string") {
        throw new DaemonParseError(`"events.${eventId}.ignore" must contain only strings`);
      }
    }
  }
  if (obj["events"] !== undefined) {
    if (!Array.isArray(obj["events"])) {
      throw new DaemonParseError(`"events.${eventId}.events" must be an array`);
    }
    for (const ev of obj["events"]) {
      if (typeof ev !== "string" || !VALID_FSWATCH_EVENTS.has(ev)) {
        throw new DaemonParseError(
          `"events.${eventId}.events" contains invalid value "${String(ev)}". Valid values: ${[...VALID_FSWATCH_EVENTS].join(", ")}`
        );
      }
    }
  }
}

function validateWebhookEvent(obj: Record<string, unknown>, eventId: string): void {
  assertString(obj["path"], `events.${eventId}.path`);
  if (obj["port"] !== undefined && typeof obj["port"] !== "number") {
    throw new DaemonParseError(`"events.${eventId}.port" must be a number`);
  }
  if (obj["secret"] !== undefined && typeof obj["secret"] !== "string") {
    throw new DaemonParseError(`"events.${eventId}.secret" must be a string`);
  }
  if (obj["method"] !== undefined && typeof obj["method"] !== "string") {
    throw new DaemonParseError(`"events.${eventId}.method" must be a string`);
  }
}

function validateCommandEvent(obj: Record<string, unknown>, eventId: string): void {
  assertString(obj["command"], `events.${eventId}.command`);
  assertString(obj["interval"], `events.${eventId}.interval`);
  if (obj["trigger_on"] !== undefined) {
    if (typeof obj["trigger_on"] !== "string" || !VALID_TRIGGER_ON.has(obj["trigger_on"])) {
      throw new DaemonParseError(
        `"events.${eventId}.trigger_on" must be "change" or "always" (got "${String(obj["trigger_on"])}")`
      );
    }
  }
}

function validateEventSource(eventId: string, event: unknown): EventSourceDef {
  assertObject(event, `events.${eventId}`);
  const obj = event as Record<string, unknown>;

  const eventType = obj["type"];
  if (typeof eventType !== "string" || !VALID_EVENT_TYPES.has(eventType)) {
    throw new DaemonParseError(
      `"events.${eventId}.type" must be one of: ${[...VALID_EVENT_TYPES].join(", ")} (got "${String(eventType)}")`
    );
  }

  switch (eventType) {
    case "cron":
      validateCronEvent(obj, eventId);
      break;
    case "interval":
      validateIntervalEvent(obj, eventId);
      break;
    case "fswatch":
      validateFSWatchEvent(obj, eventId);
      break;
    case "webhook":
      validateWebhookEvent(obj, eventId);
      break;
    case "command":
      validateCommandEvent(obj, eventId);
      break;
  }

  return obj as unknown as EventSourceDef;
}

// ---------------------------------------------------------------------------
// Filter validation
// ---------------------------------------------------------------------------

function validateFilterValue(value: unknown, field: string): FilterValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if ("pattern" in obj) {
      if (typeof obj["pattern"] !== "string") {
        throw new DaemonParseError(`"${field}.pattern" must be a string`);
      }
      return { pattern: obj["pattern"] };
    }
    if ("in" in obj) {
      if (!Array.isArray(obj["in"])) {
        throw new DaemonParseError(`"${field}.in" must be an array`);
      }
      for (const item of obj["in"]) {
        if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
          throw new DaemonParseError(
            `"${field}.in" must contain only strings, numbers, or booleans`
          );
        }
      }
      return { in: obj["in"] as Array<string | number | boolean> };
    }
    throw new DaemonParseError(
      `"${field}" must be a primitive, { pattern: string }, or { in: array }`
    );
  }
  throw new DaemonParseError(
    `"${field}" must be a string, number, boolean, { pattern: string }, or { in: array }`
  );
}

// ---------------------------------------------------------------------------
// Evaluate / Analyze validation
// ---------------------------------------------------------------------------

function validateEvaluateDef(value: unknown, triggerId: string): EvaluateDef {
  assertObject(value, `triggers.${triggerId}.evaluate`);
  const obj = value as Record<string, unknown>;
  validateWorker(obj["worker"], `triggers.${triggerId}.evaluate.worker`);
  assertString(obj["instructions"], `triggers.${triggerId}.evaluate.instructions`);
  validateCapabilities(obj["capabilities"], `triggers.${triggerId}.evaluate.capabilities`);
  return obj as unknown as EvaluateDef;
}

function validateAnalyzeDef(value: unknown, triggerId: string): AnalyzeDef {
  assertObject(value, `triggers.${triggerId}.analyze`);
  const obj = value as Record<string, unknown>;
  validateWorker(obj["worker"], `triggers.${triggerId}.analyze.worker`);
  assertString(obj["instructions"], `triggers.${triggerId}.analyze.instructions`);
  validateCapabilities(obj["capabilities"], `triggers.${triggerId}.analyze.capabilities`);
  if (obj["outputs"] !== undefined) {
    if (!Array.isArray(obj["outputs"])) {
      throw new DaemonParseError(`"triggers.${triggerId}.analyze.outputs" must be an array`);
    }
    for (const out of obj["outputs"]) {
      if (typeof out !== "object" || out === null) {
        throw new DaemonParseError(
          `"triggers.${triggerId}.analyze.outputs" entries must be objects`
        );
      }
      const o = out as Record<string, unknown>;
      assertString(o["name"], `triggers.${triggerId}.analyze.outputs[].name`);
      assertString(o["path"], `triggers.${triggerId}.analyze.outputs[].path`);
    }
  }
  return obj as unknown as AnalyzeDef;
}

// ---------------------------------------------------------------------------
// Context validation
// ---------------------------------------------------------------------------

function validateContext(value: unknown, triggerId: string): TriggerContext {
  assertObject(value, `triggers.${triggerId}.context`);
  const obj = value as Record<string, unknown>;
  if (obj["env"] !== undefined) {
    assertObject(obj["env"], `triggers.${triggerId}.context.env`);
    const env = obj["env"] as Record<string, unknown>;
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== "string") {
        throw new DaemonParseError(
          `"triggers.${triggerId}.context.env.${k}" must be a string`
        );
      }
    }
  }
  if (obj["last_result"] !== undefined && typeof obj["last_result"] !== "boolean") {
    throw new DaemonParseError(`"triggers.${triggerId}.context.last_result" must be a boolean`);
  }
  if (obj["event_payload"] !== undefined && typeof obj["event_payload"] !== "boolean") {
    throw new DaemonParseError(`"triggers.${triggerId}.context.event_payload" must be a boolean`);
  }
  return obj as unknown as TriggerContext;
}

// ---------------------------------------------------------------------------
// Trigger validation
// ---------------------------------------------------------------------------

function validateTrigger(
  triggerId: string,
  trigger: unknown,
  eventIds: Set<string>
): TriggerDef {
  assertObject(trigger, `triggers.${triggerId}`);
  const obj = trigger as Record<string, unknown>;

  // Required: on
  assertString(obj["on"], `triggers.${triggerId}.on`);
  if (!eventIds.has(obj["on"])) {
    throw new DaemonParseError(
      `"triggers.${triggerId}.on" references unknown event "${obj["on"]}". Available events: ${[...eventIds].join(", ")}`
    );
  }

  // Required: workflow
  assertString(obj["workflow"], `triggers.${triggerId}.workflow`);

  // Optional: enabled
  if (obj["enabled"] !== undefined && typeof obj["enabled"] !== "boolean") {
    throw new DaemonParseError(`"triggers.${triggerId}.enabled" must be a boolean`);
  }

  // Optional: filter
  if (obj["filter"] !== undefined) {
    assertObject(obj["filter"], `triggers.${triggerId}.filter`);
    const filter = obj["filter"] as Record<string, unknown>;
    for (const [key, val] of Object.entries(filter)) {
      validateFilterValue(val, `triggers.${triggerId}.filter.${key}`);
    }
  }

  // Optional: debounce, cooldown (duration strings)
  if (obj["debounce"] !== undefined) {
    assertString(obj["debounce"], `triggers.${triggerId}.debounce`);
  }
  if (obj["cooldown"] !== undefined) {
    assertString(obj["cooldown"], `triggers.${triggerId}.cooldown`);
  }

  // Optional: max_queue
  if (obj["max_queue"] !== undefined && typeof obj["max_queue"] !== "number") {
    throw new DaemonParseError(`"triggers.${triggerId}.max_queue" must be a number`);
  }

  // Optional: evaluate
  if (obj["evaluate"] !== undefined) {
    validateEvaluateDef(obj["evaluate"], triggerId);
  }

  // Optional: context
  if (obj["context"] !== undefined) {
    validateContext(obj["context"], triggerId);
  }

  // Optional: analyze
  if (obj["analyze"] !== undefined) {
    validateAnalyzeDef(obj["analyze"], triggerId);
  }

  // Optional: on_workflow_failure
  if (obj["on_workflow_failure"] !== undefined) {
    if (
      typeof obj["on_workflow_failure"] !== "string" ||
      !VALID_ON_WORKFLOW_FAILURE.has(obj["on_workflow_failure"])
    ) {
      throw new DaemonParseError(
        `"triggers.${triggerId}.on_workflow_failure" must be "ignore", "retry", or "pause_trigger"`
      );
    }
  }

  // Optional: max_retries
  if (obj["max_retries"] !== undefined && typeof obj["max_retries"] !== "number") {
    throw new DaemonParseError(`"triggers.${triggerId}.max_retries" must be a number`);
  }

  return obj as unknown as TriggerDef;
}

// ---------------------------------------------------------------------------
// Top-level parser
// ---------------------------------------------------------------------------

const MAX_YAML_SIZE = 1024 * 1024; // 1MB

/**
 * Parse YAML content into a validated DaemonConfig.
 */
export function parseDaemonConfig(yamlContent: string): DaemonConfig {
  if (yamlContent.length > MAX_YAML_SIZE) {
    throw new DaemonParseError(
      `YAML content too large: ${yamlContent.length} bytes (max ${MAX_YAML_SIZE})`,
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlContent);
  } catch (e) {
    throw new DaemonParseError(`Invalid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new DaemonParseError("Daemon config YAML must be an object");
  }

  const doc = parsed as Record<string, unknown>;

  // Top-level required fields
  assertString(doc["name"], "name");

  if (doc["version"] !== "1") {
    throw new DaemonParseError(`"version" must be "1" (got "${String(doc["version"])}")`);
  }

  assertString(doc["workspace"], "workspace");

  // events
  assertObject(doc["events"], "events");
  const eventsObj = doc["events"] as Record<string, unknown>;
  const eventIds = Object.keys(eventsObj);
  if (eventIds.length === 0) {
    throw new DaemonParseError('"events" must contain at least one event source');
  }

  const validatedEvents: Record<string, EventSourceDef> = {};
  for (const eventId of eventIds) {
    validatedEvents[eventId] = validateEventSource(eventId, eventsObj[eventId]);
  }

  // triggers
  assertObject(doc["triggers"], "triggers");
  const triggersObj = doc["triggers"] as Record<string, unknown>;
  const triggerIds = Object.keys(triggersObj);
  if (triggerIds.length === 0) {
    throw new DaemonParseError('"triggers" must contain at least one trigger');
  }

  const eventIdSet = new Set(eventIds);
  const validatedTriggers: Record<string, TriggerDef> = {};
  for (const triggerId of triggerIds) {
    validatedTriggers[triggerId] = validateTrigger(triggerId, triggersObj[triggerId], eventIdSet);
  }

  return {
    name: doc["name"] as string,
    version: "1",
    description: typeof doc["description"] === "string" ? doc["description"] : undefined,
    workspace: doc["workspace"] as string,
    log_dir: typeof doc["log_dir"] === "string" ? doc["log_dir"] : undefined,
    max_concurrent_workflows:
      typeof doc["max_concurrent_workflows"] === "number"
        ? doc["max_concurrent_workflows"]
        : undefined,
    state_dir: typeof doc["state_dir"] === "string" ? doc["state_dir"] : undefined,
    events: validatedEvents,
    triggers: validatedTriggers,
  };
}
