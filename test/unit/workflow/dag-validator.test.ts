import { describe, it, expect } from "bun:test";
import { validateDag } from "../../../src/workflow/dag-validator.js";
import type { WorkflowDefinition } from "../../../src/workflow/types.js";

function makeWorkflow(steps: WorkflowDefinition["steps"]): WorkflowDefinition {
  return {
    name: "test",
    version: "1",
    timeout: "30m",
    steps,
  };
}

describe("validateDag", () => {
  describe("valid DAGs", () => {
    it("validates a single step with no dependencies", () => {
      const wf = makeWorkflow({
        step1: {
          worker: "CODEX_CLI",
          instructions: "do it",
          capabilities: ["READ"],
        },
      });
      expect(validateDag(wf)).toEqual([]);
    });

    it("validates a linear chain", () => {
      const wf = makeWorkflow({
        a: { worker: "CODEX_CLI", instructions: "a", capabilities: ["READ"] },
        b: {
          worker: "CODEX_CLI",
          instructions: "b",
          capabilities: ["READ"],
          depends_on: ["a"],
        },
        c: {
          worker: "CODEX_CLI",
          instructions: "c",
          capabilities: ["READ"],
          depends_on: ["b"],
        },
      });
      expect(validateDag(wf)).toEqual([]);
    });

    it("validates a diamond DAG", () => {
      const wf = makeWorkflow({
        start: { worker: "CODEX_CLI", instructions: "s", capabilities: ["READ"] },
        left: {
          worker: "CODEX_CLI",
          instructions: "l",
          capabilities: ["READ"],
          depends_on: ["start"],
        },
        right: {
          worker: "CODEX_CLI",
          instructions: "r",
          capabilities: ["READ"],
          depends_on: ["start"],
        },
        end: {
          worker: "CODEX_CLI",
          instructions: "e",
          capabilities: ["READ"],
          depends_on: ["left", "right"],
        },
      });
      expect(validateDag(wf)).toEqual([]);
    });

    it("validates steps with valid inputs from depends_on", () => {
      const wf = makeWorkflow({
        a: {
          worker: "CODEX_CLI",
          instructions: "a",
          capabilities: ["READ"],
          outputs: [{ name: "result", path: "out.txt" }],
        },
        b: {
          worker: "CODEX_CLI",
          instructions: "b",
          capabilities: ["READ"],
          depends_on: ["a"],
          inputs: [{ from: "a", artifact: "result" }],
        },
      });
      expect(validateDag(wf)).toEqual([]);
    });
  });

  describe("cycle detection", () => {
    it("detects a simple cycle (A -> B -> A)", () => {
      const wf = makeWorkflow({
        a: {
          worker: "CODEX_CLI",
          instructions: "a",
          capabilities: ["READ"],
          depends_on: ["b"],
        },
        b: {
          worker: "CODEX_CLI",
          instructions: "b",
          capabilities: ["READ"],
          depends_on: ["a"],
        },
      });
      const errors = validateDag(wf);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("cycle"))).toBe(true);
    });

    it("detects a three-step cycle", () => {
      const wf = makeWorkflow({
        a: {
          worker: "CODEX_CLI",
          instructions: "a",
          capabilities: ["READ"],
          depends_on: ["c"],
        },
        b: {
          worker: "CODEX_CLI",
          instructions: "b",
          capabilities: ["READ"],
          depends_on: ["a"],
        },
        c: {
          worker: "CODEX_CLI",
          instructions: "c",
          capabilities: ["READ"],
          depends_on: ["b"],
        },
      });
      const errors = validateDag(wf);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("cycle"))).toBe(true);
    });

    it("detects a self-loop", () => {
      const wf = makeWorkflow({
        a: {
          worker: "CODEX_CLI",
          instructions: "a",
          capabilities: ["READ"],
          depends_on: ["a"],
        },
      });
      const errors = validateDag(wf);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("cycle"))).toBe(true);
    });
  });

  describe("reference integrity", () => {
    it("detects unknown depends_on reference", () => {
      const wf = makeWorkflow({
        a: {
          worker: "CODEX_CLI",
          instructions: "a",
          capabilities: ["READ"],
          depends_on: ["nonexistent"],
        },
      });
      const errors = validateDag(wf);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.field === "depends_on" && e.message.includes("nonexistent"))).toBe(true);
    });

    it("detects multiple unknown references", () => {
      const wf = makeWorkflow({
        a: {
          worker: "CODEX_CLI",
          instructions: "a",
          capabilities: ["READ"],
          depends_on: ["x", "y"],
        },
      });
      const errors = validateDag(wf);
      expect(errors.filter((e) => e.field === "depends_on")).toHaveLength(2);
    });
  });

  describe("input integrity", () => {
    it("detects input from step not in depends_on", () => {
      const wf = makeWorkflow({
        a: {
          worker: "CODEX_CLI",
          instructions: "a",
          capabilities: ["READ"],
          outputs: [{ name: "result", path: "out.txt" }],
        },
        b: {
          worker: "CODEX_CLI",
          instructions: "b",
          capabilities: ["READ"],
          inputs: [{ from: "a", artifact: "result" }],
          // Note: depends_on is missing
        },
      });
      const errors = validateDag(wf);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.field === "inputs" && e.message.includes("not in depends_on"))).toBe(true);
    });
  });

  describe("output name uniqueness", () => {
    it("detects duplicate output names within a step", () => {
      const wf = makeWorkflow({
        a: {
          worker: "CODEX_CLI",
          instructions: "a",
          capabilities: ["READ"],
          outputs: [
            { name: "result", path: "out1.txt" },
            { name: "result", path: "out2.txt" },
          ],
        },
      });
      const errors = validateDag(wf);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.field === "outputs" && e.message.includes("duplicate"))).toBe(true);
    });

    it("allows same output name in different steps", () => {
      const wf = makeWorkflow({
        a: {
          worker: "CODEX_CLI",
          instructions: "a",
          capabilities: ["READ"],
          outputs: [{ name: "result", path: "out1.txt" }],
        },
        b: {
          worker: "CODEX_CLI",
          instructions: "b",
          capabilities: ["READ"],
          outputs: [{ name: "result", path: "out2.txt" }],
        },
      });
      expect(validateDag(wf)).toEqual([]);
    });
  });

  describe("completion_check integrity", () => {
    it("detects completion_check without sufficient max_iterations", () => {
      const wf = makeWorkflow({
        a: {
          worker: "CODEX_CLI",
          instructions: "a",
          capabilities: ["READ"],
          completion_check: {
            worker: "CLAUDE_CODE",
            instructions: "check",
            capabilities: ["READ"],
          },
          max_iterations: 1,
        },
      });
      const errors = validateDag(wf);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.field === "completion_check")).toBe(true);
    });

    it("passes with valid completion_check and max_iterations >= 2", () => {
      const wf = makeWorkflow({
        a: {
          worker: "CODEX_CLI",
          instructions: "a",
          capabilities: ["READ"],
          completion_check: {
            worker: "CLAUDE_CODE",
            instructions: "check",
            capabilities: ["READ"],
          },
          max_iterations: 5,
        },
      });
      expect(validateDag(wf)).toEqual([]);
    });
  });

  describe("multiple errors", () => {
    it("reports all errors at once", () => {
      const wf = makeWorkflow({
        a: {
          worker: "CODEX_CLI",
          instructions: "a",
          capabilities: ["READ"],
          depends_on: ["nonexistent"],
          inputs: [{ from: "nonexistent", artifact: "x" }],
          outputs: [
            { name: "dup", path: "1.txt" },
            { name: "dup", path: "2.txt" },
          ],
        },
      });
      const errors = validateDag(wf);
      // unknown depends_on + duplicate output (input from "nonexistent" IS in depends_on list)
      expect(errors.length).toBeGreaterThanOrEqual(2);
    });
  });
});
