import { describe, it, expect } from "bun:test";
import { validateDirective } from "../../../src/workflow/management/directive-validator.js";
import type {
  ManagementDirective,
  ManagementHook,
  DirectiveValidationResult,
} from "../../../src/workflow/management/types.js";
import { StepStatus } from "../../../src/workflow/types.js";

describe("validateDirective", () => {
  // -------------------------------------------------------------------------
  // TC-MA-V-01: disallowed directive is rejected
  // -------------------------------------------------------------------------
  it("TC-MA-V-01: rejects a directive that is not allowed at the given hook", () => {
    const directive: ManagementDirective = { action: "skip", reason: "not needed" };
    const hook: ManagementHook = "post_step";
    const status = StepStatus.SUCCEEDED;

    const result: DirectiveValidationResult = validateDirective(directive, hook, status);

    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
    expect(typeof result.reason).toBe("string");
    expect(result.reason!.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // TC-MA-V-02: skip requires READY status
  // -------------------------------------------------------------------------
  it("TC-MA-V-02: rejects skip when step status is not READY", () => {
    const directive: ManagementDirective = { action: "skip", reason: "r" };
    const hook: ManagementHook = "pre_step";
    const status = StepStatus.RUNNING;

    const result: DirectiveValidationResult = validateDirective(directive, hook, status);

    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
    // The reason should mention READY or the state requirement
    expect(result.reason!).toMatch(/READY|state|status/i);
  });

  // -------------------------------------------------------------------------
  // TC-MA-V-03: adjust_timeout only at pre_step/pre_check
  // -------------------------------------------------------------------------
  it("TC-MA-V-03: rejects adjust_timeout at post_check", () => {
    const directive: ManagementDirective = {
      action: "adjust_timeout",
      timeout: "5m",
      reason: "r",
    };
    const hook: ManagementHook = "post_check";
    const status = StepStatus.CHECKING;

    const result: DirectiveValidationResult = validateDirective(directive, hook, status);

    expect(result.valid).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-MA-V-04: force_complete only at post_check
  // -------------------------------------------------------------------------
  it("TC-MA-V-04: rejects force_complete at pre_step", () => {
    const directive: ManagementDirective = { action: "force_complete", reason: "done" };
    const hook: ManagementHook = "pre_step";
    const status = StepStatus.READY;

    const result: DirectiveValidationResult = validateDirective(directive, hook, status);

    expect(result.valid).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-MA-V-05: retry only at on_stall
  // -------------------------------------------------------------------------
  it("TC-MA-V-05: rejects retry at pre_step", () => {
    const directive: ManagementDirective = { action: "retry", reason: "try again" };
    const hook: ManagementHook = "pre_step";
    const status = StepStatus.READY;

    const result: DirectiveValidationResult = validateDirective(directive, hook, status);

    expect(result.valid).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-MA-V-06: modify_instructions only at pre_step/pre_check/on_stall
  // -------------------------------------------------------------------------
  it("TC-MA-V-06: rejects modify_instructions at post_step", () => {
    const directive: ManagementDirective = {
      action: "modify_instructions",
      append: "new hint",
    };
    const hook: ManagementHook = "post_step";
    const status = StepStatus.SUCCEEDED;

    const result: DirectiveValidationResult = validateDirective(directive, hook, status);

    expect(result.valid).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TC-MA-V-07: annotate/abort_workflow/proceed always allowed
  // -------------------------------------------------------------------------
  describe("TC-MA-V-07: universally allowed directives", () => {
    const universalActions: ManagementDirective[] = [
      { action: "proceed" },
      { action: "abort_workflow", reason: "critical failure" },
      { action: "annotate", message: "note" },
    ];

    const allHooks: ManagementHook[] = [
      "pre_step",
      "post_step",
      "pre_check",
      "post_check",
      "on_stall",
      "periodic",
    ];

    // Map each hook to an appropriate StepStatus for that phase
    const hookStatusMap: Record<ManagementHook, StepStatus> = {
      pre_step: StepStatus.READY,
      post_step: StepStatus.SUCCEEDED,
      pre_check: StepStatus.CHECKING,
      post_check: StepStatus.CHECKING,
      on_stall: StepStatus.RUNNING,
      periodic: StepStatus.RUNNING,
    };

    for (const directive of universalActions) {
      for (const hook of allHooks) {
        it(`allows "${directive.action}" at "${hook}" hook`, () => {
          const status = hookStatusMap[hook];
          const result: DirectiveValidationResult = validateDirective(
            directive,
            hook,
            status,
          );

          expect(result.valid).toBe(true);
        });
      }
    }
  });
});
