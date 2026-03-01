/**
 * Directive validation
 *
 * - validateDirectiveShape: structural validation (required fields, bounds)
 * - validateDirective: permission matrix + step-state constraints
 */

import type {
  ManagementDirective,
  ManagementHook,
  ManagementAction,
  DirectiveValidationResult,
} from "./types.js";
import {
  VALID_MANAGEMENT_ACTIONS,
  MAX_STRING_FIELD_LENGTH,
} from "./types.js";
import { StepStatus } from "../types.js";

// ---------------------------------------------------------------------------
// Structural validation (shared across engines)
// ---------------------------------------------------------------------------

export interface DirectiveShapeValidationResult {
  valid: boolean;
  reason?: string;
  directive?: ManagementDirective;
}

const REQUIRED_FIELDS: Record<ManagementAction, Array<{ field: string; type: "string" }>> = {
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

const STRING_FIELDS = ["append", "reason", "message", "modify_instructions"] as const;

export function validateDirectiveShape(value: unknown): DirectiveShapeValidationResult {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, reason: "directive must be an object" };
  }
  const dir = value as Record<string, unknown>;
  const action = dir.action;
  if (typeof action !== "string" || !VALID_MANAGEMENT_ACTIONS.has(action as ManagementAction)) {
    return { valid: false, reason: `unknown action: ${String(action)}` };
  }

  // Check bounded string fields.
  for (const field of STRING_FIELDS) {
    const v = dir[field];
    if (typeof v === "string" && v.length > MAX_STRING_FIELD_LENGTH) {
      return {
        valid: false,
        reason: `string field "${field}" exceeds max length of ${MAX_STRING_FIELD_LENGTH}`,
      };
    }
  }

  // Required fields per action.
  for (const { field, type } of REQUIRED_FIELDS[action as ManagementAction]) {
    const v = dir[field];
    if (v === undefined || v === null || typeof v !== type) {
      return {
        valid: false,
        reason: `required field "${field}" missing or invalid for action "${action}"`,
      };
    }
    if (type === "string" && (v as string).trim().length === 0) {
      return {
        valid: false,
        reason: `required field "${field}" must be a non-empty string for action "${action}"`,
      };
    }
  }

  // Optional string fields: if provided, must be strings.
  if (action === "retry" && dir.modify_instructions !== undefined && typeof dir.modify_instructions !== "string") {
    return {
      valid: false,
      reason: `field "modify_instructions" must be a string when present for action "retry"`,
    };
  }

  return { valid: true, directive: dir as unknown as ManagementDirective };
}

// ---------------------------------------------------------------------------
// Permission matrix
// ---------------------------------------------------------------------------
// Maps each action to the set of hooks where it is allowed.

const PERMISSION_MATRIX: Record<ManagementAction, ReadonlySet<ManagementHook>> = {
  proceed: new Set([
    "pre_step", "post_step", "pre_check", "post_check", "on_stall", "periodic",
  ]),
  skip: new Set(["pre_step"]),
  modify_instructions: new Set(["pre_step", "pre_check", "on_stall"]),
  force_complete: new Set(["post_check"]),
  force_incomplete: new Set(["post_check"]),
  retry: new Set(["on_stall"]),
  abort_workflow: new Set([
    "pre_step", "post_step", "pre_check", "post_check", "on_stall", "periodic",
  ]),
  adjust_timeout: new Set(["pre_step", "pre_check"]),
  annotate: new Set([
    "pre_step", "post_step", "pre_check", "post_check", "on_stall", "periodic",
  ]),
};

// ---------------------------------------------------------------------------
// validateDirective
// ---------------------------------------------------------------------------

export function validateDirective(
  directive: ManagementDirective,
  hook: ManagementHook,
  stepStatus: StepStatus,
): DirectiveValidationResult {
  const { action } = directive;

  // 1. Check the permission matrix: is this action allowed at this hook?
  const allowedHooks = PERMISSION_MATRIX[action];
  if (!allowedHooks || !allowedHooks.has(hook)) {
    return {
      valid: false,
      reason: `Directive "${action}" is not allowed at hook "${hook}".`,
    };
  }

  // 2. Additional step-state constraints
  if (action === "skip" && stepStatus !== StepStatus.READY) {
    return {
      valid: false,
      reason: `Directive "skip" requires step status READY, but current status is "${stepStatus}".`,
    };
  }

  if ((action === "force_complete" || action === "force_incomplete") && stepStatus !== StepStatus.CHECKING) {
    return {
      valid: false,
      reason: `Directive "${action}" requires step status CHECKING, but current status is "${stepStatus}".`,
    };
  }

  if (action === "adjust_timeout" && stepStatus !== StepStatus.READY && stepStatus !== StepStatus.CHECKING) {
    return {
      valid: false,
      reason: `Directive "adjust_timeout" requires step status READY or CHECKING, but current status is "${stepStatus}".`,
    };
  }

  if (action === "retry" && stepStatus !== StepStatus.RUNNING) {
    return {
      valid: false,
      reason: `Directive "retry" requires step status RUNNING, but current status is "${stepStatus}".`,
    };
  }

  return { valid: true };
}
