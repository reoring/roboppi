import path from "node:path";
import { TaskOrchestratorParseError } from "./parser.js";
import type {
  TaskLandingConfig,
  TaskLandingDecision,
  TaskLandingDirective,
  TaskLandingLifecycle,
  TaskLifecycleState,
} from "./types.js";

const ALLOWED_LIFECYCLES = new Set<TaskLandingLifecycle>([
  "waiting_for_input",
  "review_required",
  "blocked",
  "ready_to_land",
  "landed",
  "closed_without_landing",
]);

export interface ResolveLandingDecisionOptions {
  contextDir: string;
  landing?: TaskLandingConfig;
  defaultLifecycle: TaskLifecycleState;
  defaultRationale: string;
  allowWorkflowDirective?: boolean;
}

export async function resolveLandingDecision(
  options: ResolveLandingDecisionOptions,
): Promise<TaskLandingDecision> {
  const defaultDecision: TaskLandingDecision = {
    version: "1",
    lifecycle: options.defaultLifecycle,
    rationale: options.defaultRationale,
    source: "default",
  };

  const landing = options.landing ?? { mode: "manual" };
  if (options.allowWorkflowDirective === false) {
    return defaultDecision;
  }
  const workflowDirectivePath = path.join(
    options.contextDir,
    "_task",
    "landing.json",
  );
  const directiveText = await Bun.file(workflowDirectivePath).text().catch(() => null);
  if (directiveText === null) {
    return defaultDecision;
  }

  let directive: TaskLandingDirective;
  try {
    directive = parseTaskLandingDirective(directiveText);
  } catch (err) {
    return {
      ...defaultDecision,
      source: "invalid",
      rationale: `Ignored invalid landing directive: ${formatError(err)}`,
      metadata: {
        landing_file: workflowDirectivePath,
      },
    };
  }

  if (landing.mode === "disabled") {
    return {
      ...defaultDecision,
      source: "ignored",
      rationale:
        directive.rationale?.trim() ||
        "Ignored workflow landing directive because landing.mode=disabled.",
      metadata: {
        landing_file: workflowDirectivePath,
        requested_lifecycle: directive.lifecycle,
        requested_metadata: directive.metadata,
      },
    };
  }

  return {
    ...directive,
    source: "workflow",
    metadata: {
      landing_file: workflowDirectivePath,
      ...(directive.metadata ?? {}),
    },
  };
}

export function parseTaskLandingDirective(text: string): TaskLandingDirective {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new TaskOrchestratorParseError(
      `landing.json must be valid JSON: ${formatError(err)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TaskOrchestratorParseError("landing.json must be an object");
  }

  const obj = parsed as Record<string, unknown>;
  if (obj["version"] !== "1") {
    throw new TaskOrchestratorParseError(
      `landing.json "version" must be "1" (got "${String(obj["version"])}")`,
    );
  }
  if (
    typeof obj["lifecycle"] !== "string" ||
    !ALLOWED_LIFECYCLES.has(obj["lifecycle"] as TaskLandingLifecycle)
  ) {
    throw new TaskOrchestratorParseError(
      `landing.json "lifecycle" must be one of: ${[...ALLOWED_LIFECYCLES].join(", ")}`,
    );
  }
  if (
    obj["rationale"] !== undefined &&
    (typeof obj["rationale"] !== "string" || obj["rationale"].trim() === "")
  ) {
    throw new TaskOrchestratorParseError(
      'landing.json "rationale" must be a non-empty string when present',
    );
  }
  if (
    obj["metadata"] !== undefined &&
    (typeof obj["metadata"] !== "object" ||
      obj["metadata"] === null ||
      Array.isArray(obj["metadata"]))
  ) {
    throw new TaskOrchestratorParseError(
      'landing.json "metadata" must be an object when present',
    );
  }

  return {
    version: "1",
    lifecycle: obj["lifecycle"] as TaskLandingLifecycle,
    rationale:
      typeof obj["rationale"] === "string" ? obj["rationale"] : undefined,
    metadata:
      typeof obj["metadata"] === "object" && obj["metadata"] !== null
        ? (obj["metadata"] as Record<string, unknown>)
        : undefined,
  };
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
