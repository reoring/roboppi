import { describe, it, expect } from "bun:test";
import type {
  WorkflowDefinition,
  StepDefinition,
  StepState,
} from "../../../src/workflow/types.js";
import { StepStatus } from "../../../src/workflow/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<StepDefinition> = {}): StepDefinition {
  return {
    worker: "CODEX_CLI",
    instructions: "do work",
    capabilities: ["READ"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StepStatus.OMITTED dependency resolution types", () => {
  it("StepStatus.OMITTED exists", () => {
    expect(StepStatus.OMITTED as string).toBe("OMITTED");
  });

  it("OMITTED is distinct from SKIPPED", () => {
    expect(StepStatus.OMITTED).not.toBe(StepStatus.SKIPPED);
  });

  it("StepState can hold OMITTED status", () => {
    const state: StepState = {
      status: StepStatus.OMITTED,
      iteration: 0,
      maxIterations: 1,
      completedAt: Date.now(),
    };
    expect(state.status).toBe(StepStatus.OMITTED);
  });

  it("StepState supports managementPending flag", () => {
    const state: StepState = {
      status: StepStatus.READY,
      iteration: 0,
      maxIterations: 1,
      managementPending: true,
    };
    expect(state.managementPending).toBe(true);
  });

  it("WorkflowDefinition.management is optional", () => {
    const wf: WorkflowDefinition = {
      name: "test",
      version: "1",
      timeout: "10m",
      steps: { s1: makeStep() },
    };
    expect(wf.management).toBeUndefined();
  });

  it("StepDefinition.management is optional", () => {
    const step = makeStep();
    expect(step.management).toBeUndefined();
  });
});
