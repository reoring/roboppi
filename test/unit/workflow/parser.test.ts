import { describe, it, expect } from "bun:test";
import { parseWorkflow, WorkflowParseError } from "../../../src/workflow/parser.js";

const MINIMAL_WORKFLOW = `
name: test-workflow
version: "1"
timeout: "30m"
steps:
  step1:
    worker: CODEX_CLI
    instructions: "Do something"
    capabilities: [READ]
`;

describe("parseWorkflow", () => {
  describe("valid workflows", () => {
    it("parses a minimal workflow", () => {
      const wf = parseWorkflow(MINIMAL_WORKFLOW);
      expect(wf.name).toBe("test-workflow");
      expect(wf.version).toBe("1");
      expect(wf.timeout).toBe("30m");
      expect(wf.steps["step1"]).toBeDefined();
      expect(wf.steps["step1"]!.worker).toBe("CODEX_CLI");
      expect(wf.steps["step1"]!.instructions).toBe("Do something");
      expect(wf.steps["step1"]!.capabilities).toEqual(["READ"]);
    });

    it("parses optional top-level fields", () => {
      const yaml = `
name: full-workflow
version: "1"
description: "A full workflow"
timeout: "1h"
concurrency: 3
context_dir: "./my-context"
steps:
  s1:
    worker: CLAUDE_CODE
    instructions: "Do it"
    capabilities: [READ, EDIT]
`;
      const wf = parseWorkflow(yaml);
      expect(wf.description).toBe("A full workflow");
      expect(wf.concurrency).toBe(3);
      expect(wf.context_dir).toBe("./my-context");
    });

    it("parses step with all optional fields", () => {
      const yaml = `
name: full-steps
version: "1"
timeout: "1h"
steps:
  impl:
    description: "Implement feature"
    worker: CODEX_CLI
    workspace: "./src"
    instructions: "Build it"
    capabilities: [READ, EDIT, RUN_TESTS, RUN_COMMANDS]
    timeout: "15m"
    max_retries: 2
    max_steps: 100
    max_command_time: "1m"
    on_failure: retry
    outputs:
      - name: code
        path: "src/feature.ts"
        type: code
`;
      const wf = parseWorkflow(yaml);
      const step = wf.steps["impl"]!;
      expect(step.description).toBe("Implement feature");
      expect(step.workspace).toBe("./src");
      expect(step.timeout).toBe("15m");
      expect(step.max_retries).toBe(2);
      expect(step.max_steps).toBe(100);
      expect(step.max_command_time).toBe("1m");
      expect(step.on_failure).toBe("retry");
      expect(step.outputs).toHaveLength(1);
      expect(step.outputs![0]!.name).toBe("code");
    });

    it("parses depends_on and inputs", () => {
      const yaml = `
name: deps-workflow
version: "1"
timeout: "1h"
steps:
  step1:
    worker: CODEX_CLI
    instructions: "First"
    capabilities: [READ]
    outputs:
      - name: result
        path: "out.txt"
  step2:
    worker: CLAUDE_CODE
    instructions: "Second"
    capabilities: [READ]
    depends_on: [step1]
    inputs:
      - from: step1
        artifact: result
        as: input-file
`;
      const wf = parseWorkflow(yaml);
      expect(wf.steps["step2"]!.depends_on).toEqual(["step1"]);
      expect(wf.steps["step2"]!.inputs).toHaveLength(1);
      expect(wf.steps["step2"]!.inputs![0]!.from).toBe("step1");
      expect(wf.steps["step2"]!.inputs![0]!.artifact).toBe("result");
      expect(wf.steps["step2"]!.inputs![0]!.as).toBe("input-file");
    });

    it("parses completion_check with max_iterations", () => {
      const yaml = `
name: loop-workflow
version: "1"
timeout: "2h"
steps:
  impl:
    worker: CODEX_CLI
    instructions: "Build"
    capabilities: [READ, EDIT]
    completion_check:
      worker: CLAUDE_CODE
      instructions: "Check completeness"
      capabilities: [READ]
      timeout: "2m"
    max_iterations: 5
    on_iterations_exhausted: continue
`;
      const wf = parseWorkflow(yaml);
      const step = wf.steps["impl"]!;
      expect(step.completion_check).toBeDefined();
      expect(step.completion_check!.worker).toBe("CLAUDE_CODE");
      expect(step.completion_check!.instructions).toBe("Check completeness");
      expect(step.completion_check!.capabilities).toEqual(["READ"]);
      expect(step.completion_check!.timeout).toBe("2m");
      expect(step.max_iterations).toBe(5);
      expect(step.on_iterations_exhausted).toBe("continue");
    });

    it("parses all valid worker kinds", () => {
      const workers = ["CODEX_CLI", "CLAUDE_CODE", "OPENCODE", "CUSTOM"] as const;
      for (const worker of workers) {
        const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: ${worker}
    instructions: "x"
    capabilities: [READ]
`;
        const wf = parseWorkflow(yaml);
        expect(wf.steps["s"]!.worker).toBe(worker);
      }
    });

    it("parses all valid capabilities", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ, EDIT, RUN_TESTS, RUN_COMMANDS]
`;
      const wf = parseWorkflow(yaml);
      expect(wf.steps["s"]!.capabilities).toEqual(["READ", "EDIT", "RUN_TESTS", "RUN_COMMANDS"]);
    });
  });

  describe("validation errors", () => {
    it("rejects invalid YAML", () => {
      expect(() => parseWorkflow("{{invalid")).toThrow(WorkflowParseError);
    });

    it("rejects non-object YAML", () => {
      expect(() => parseWorkflow("hello")).toThrow(WorkflowParseError);
    });

    it("rejects missing name", () => {
      const yaml = `
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(/"name" must be a non-empty string/);
    });

    it("rejects wrong version", () => {
      const yaml = `
name: w
version: "2"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(/"version" must be "1"/);
    });

    it("rejects missing timeout", () => {
      const yaml = `
name: w
version: "1"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(/"timeout" must be a non-empty string/);
    });

    it("rejects missing steps", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
`;
      expect(() => parseWorkflow(yaml)).toThrow(/"steps" must be an object/);
    });

    it("rejects empty steps", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps: {}
`;
      expect(() => parseWorkflow(yaml)).toThrow(/"steps" must contain at least one step/);
    });

    it("rejects invalid worker kind", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: INVALID
    instructions: "x"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(/must be one of/);
    });

    it("rejects invalid capability", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ, INVALID_CAP]
`;
      expect(() => parseWorkflow(yaml)).toThrow(/invalid capability/);
    });

    it("rejects missing instructions", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(/instructions" must be a non-empty string/);
    });

    it("rejects empty capabilities", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: []
`;
      expect(() => parseWorkflow(yaml)).toThrow(/must be a non-empty array/);
    });

    it("rejects completion_check without max_iterations", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
    completion_check:
      worker: CLAUDE_CODE
      instructions: "check"
      capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(/max_iterations is required/);
    });

    it("rejects completion_check with max_iterations < 2", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
    completion_check:
      worker: CLAUDE_CODE
      instructions: "check"
      capabilities: [READ]
    max_iterations: 1
`;
      expect(() => parseWorkflow(yaml)).toThrow(/max_iterations must be >= 2/);
    });

    it("rejects invalid on_failure value", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
    on_failure: invalid
`;
      expect(() => parseWorkflow(yaml)).toThrow(/on_failure must be/);
    });

    it("rejects invalid on_iterations_exhausted value", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
    completion_check:
      worker: CLAUDE_CODE
      instructions: "check"
      capabilities: [READ]
    max_iterations: 5
    on_iterations_exhausted: invalid
`;
      expect(() => parseWorkflow(yaml)).toThrow(/on_iterations_exhausted must be/);
    });

    it("rejects invalid completion_check worker", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
    completion_check:
      worker: BAD_WORKER
      instructions: "check"
      capabilities: [READ]
    max_iterations: 3
`;
      expect(() => parseWorkflow(yaml)).toThrow(/must be one of/);
    });
  });
});
