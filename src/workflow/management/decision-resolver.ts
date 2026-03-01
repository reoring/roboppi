import { readFile, stat } from "node:fs/promises";

import type { ManagementDirective, ManagementDecisionResolution } from "./types.js";
import { DEFAULT_PROCEED_DIRECTIVE } from "./types.js";
import { validateDirectiveShape } from "./directive-validator.js";

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
  const shape = validateDirectiveShape(directive);
  if (!shape.valid) {
    return proceedFallback(hookIdMatch, "file-json", shape.reason ?? "directive shape validation failed");
  }

  // 7. Acceptance
  const result: ManagementDecisionResolution = {
    directive: shape.directive as ManagementDirective,
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
