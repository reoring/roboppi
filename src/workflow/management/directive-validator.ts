/**
 * Validates whether a ManagementDirective is allowed at a given hook point
 * and step status, based on the permission matrix.
 */

import type {
  ManagementDirective,
  ManagementHook,
  ManagementAction,
  DirectiveValidationResult,
} from "./types.js";
import { StepStatus } from "../types.js";

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

  return { valid: true };
}
