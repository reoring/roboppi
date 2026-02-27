import { readFile, stat } from "node:fs/promises";

import type { ManagementDirective, ManagementDecisionResolution } from "./types.js";
import {
  VALID_MANAGEMENT_ACTIONS,
  MAX_STRING_FIELD_LENGTH,
  DEFAULT_PROCEED_DIRECTIVE,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function proceedFallback(
  hookIdMatch: boolean | undefined,
  source: "file-json" | "none",
  reason: string,
): ManagementDecisionResolution {
  return {
    directive: { ...DEFAULT_PROCEED_DIRECTIVE },
    hookIdMatch,
    source,
    reason,
  };
}

/**
 * Required fields per action type. Each entry maps an action name to an array
 * of field names that must be present (and be non-empty strings, or a string
 * for `timeout`).
 */
const REQUIRED_FIELDS: Record<string, { field: string; type: "string" }[]> = {
  proceed: [],
  skip: [{ field: "reason", type: "string" }],
  modify_instructions: [{ field: "append", type: "string" }],
  force_complete: [{ field: "reason", type: "string" }],
  force_incomplete: [{ field: "reason", type: "string" }],
  retry: [{ field: "reason", type: "string" }],
  abort_workflow: [{ field: "reason", type: "string" }],
  adjust_timeout: [
    { field: "timeout", type: "string" },
    { field: "reason", type: "string" },
  ],
  annotate: [{ field: "message", type: "string" }],
};

/** String field names that are subject to the length limit. */
const STRING_FIELDS = ["append", "reason", "message", "modify_instructions"] as const;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function resolveManagementDecision(
  decisionFilePath: string,
  hookId: string,
  hook: string,
  stepId: string,
  hookStartedAt: number,
): Promise<ManagementDecisionResolution> {
  // 1. Read the file
  let raw: string;
  try {
    raw = await readFile(decisionFilePath, "utf-8");
  } catch {
    return proceedFallback(undefined, "none", "decision file not found");
  }

  // 2. Parse JSON
  let decision: Record<string, unknown>;
  try {
    decision = JSON.parse(raw);
    if (decision === null || typeof decision !== "object" || Array.isArray(decision)) {
      return proceedFallback(undefined, "file-json", "json parse failure: not an object");
    }
  } catch {
    return proceedFallback(undefined, "file-json", "json parse failure");
  }

  // 3. hook_id staleness check
  let hookIdMatch: boolean | undefined;

  if (decision.hook_id !== undefined) {
    if (decision.hook_id === hookId) {
      hookIdMatch = true;
    } else {
      hookIdMatch = false;
      return proceedFallback(false, "file-json", "stale decision: hook_id mismatch");
    }
  } else {
    // No hook_id — fall back to mtime check
    const fileStat = await stat(decisionFilePath);
    const mtime = fileStat.mtimeMs;
    if (mtime < hookStartedAt - 2000) {
      return proceedFallback(undefined, "file-json", "stale decision: file mtime too old");
    }
    hookIdMatch = undefined;
  }

  // 4. hook / step_id mismatch
  if (decision.hook !== undefined && decision.step_id !== undefined) {
    if (decision.hook !== hook || decision.step_id !== stepId) {
      return proceedFallback(
        hookIdMatch,
        "file-json",
        "misattribution: hook or step_id mismatch",
      );
    }
  }

  // 5. Directive validation
  const directive = decision.directive;
  if (directive === null || directive === undefined || typeof directive !== "object" || Array.isArray(directive)) {
    return proceedFallback(hookIdMatch, "file-json", "directive must be an object");
  }

  const dir = directive as Record<string, unknown>;
  const action = dir.action;

  if (typeof action !== "string" || !VALID_MANAGEMENT_ACTIONS.has(action as ManagementDirective["action"])) {
    return proceedFallback(hookIdMatch, "file-json", `unknown action: ${String(action)}`);
  }

  // Check string field lengths
  for (const field of STRING_FIELDS) {
    const value = dir[field];
    if (typeof value === "string" && value.length > MAX_STRING_FIELD_LENGTH) {
      return proceedFallback(
        hookIdMatch,
        "file-json",
        `string field "${field}" exceeds max length of ${MAX_STRING_FIELD_LENGTH}`,
      );
    }
  }

  // Check required fields per action type
  const requiredFields = REQUIRED_FIELDS[action as string];
  if (requiredFields) {
    for (const { field, type } of requiredFields) {
      const value = dir[field];
      if (value === undefined || value === null || typeof value !== type) {
        return proceedFallback(
          hookIdMatch,
          "file-json",
          `required field "${field}" missing or invalid for action "${action}"`,
        );
      }
    }
  }

  // 7. Acceptance
  const result: ManagementDecisionResolution = {
    directive: directive as ManagementDirective,
    hookIdMatch,
    source: "file-json",
  };

  // 8. Pass through optional fields
  if (typeof decision.reasoning === "string") {
    result.reasoning = decision.reasoning;
  }
  if (typeof decision.confidence === "number") {
    result.confidence = decision.confidence;
  }

  return result;
}
