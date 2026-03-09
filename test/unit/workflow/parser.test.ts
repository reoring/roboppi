import { describe, it, expect } from "bun:test";
import { parseWorkflow, WorkflowParseError } from "../../../src/workflow/parser.js";
import { parseAgentCatalog } from "../../../src/workflow/agent-catalog.js";

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
create_branch: true
branch_transition_step: "s1"
expected_work_branch: "feature/demo"
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
      expect(wf.create_branch).toBe(true);
      expect(wf.branch_transition_step).toBe("s1");
      expect(wf.expected_work_branch).toBe("feature/demo");
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
      decision_file: ".roboppi-loop/review.verdict"
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
      expect(step.completion_check!.decision_file).toBe(".roboppi-loop/review.verdict");
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

    it("resolves step.agent from an agent catalog", () => {
      const agents = parseAgentCatalog(`
version: "1"
agents:
  research:
    worker: OPENCODE
    defaultArgs: [--sandbox, danger-full-access]
    model: openai/gpt-5.2
    capabilities: [READ]
    base_instructions: |
      You are a research agent.
`);

      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    agent: research
    instructions: "Find relevant docs"
`;

      const wf = parseWorkflow(yaml, { agents });
      expect(wf.steps["s"]!.worker).toBe("OPENCODE");
      expect(wf.steps["s"]!.defaultArgs).toEqual(["--sandbox", "danger-full-access"]);
      expect(wf.steps["s"]!.model).toBe("openai/gpt-5.2");
      expect(wf.steps["s"]!.capabilities).toEqual(["READ"]);
      expect(wf.steps["s"]!.instructions).toBe("You are a research agent.\n\nFind relevant docs");
    });

    it("resolves completion_check.agent from an agent catalog", () => {
      const agents = parseAgentCatalog(`
version: "1"
agents:
  checker:
    worker: CODEX_CLI
    defaultArgs: [--sandbox, danger-full-access]
    model: gpt-5.4
    capabilities: [READ]
`);

      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CUSTOM
    instructions: "echo ok"
    capabilities: [READ]
    completion_check:
      agent: checker
      instructions: "exit 0"
      decision_file: ".roboppi-loop/decision.txt"
    max_iterations: 2
`;

      const wf = parseWorkflow(yaml, { agents });
      expect(wf.steps["s"]!.completion_check!.worker).toBe("CODEX_CLI");
      expect(wf.steps["s"]!.completion_check!.defaultArgs).toEqual([
        "--sandbox",
        "danger-full-access",
      ]);
      expect(wf.steps["s"]!.completion_check!.model).toBe("gpt-5.4");
      expect(wf.steps["s"]!.completion_check!.capabilities).toEqual(["READ"]);
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

    it("rejects unknown branch_transition_step", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
branch_transition_step: "missing"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(/branch_transition_step/);
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
      decision_file: ".roboppi-loop/decision.json"
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
      decision_file: ".roboppi-loop/decision.json"
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
      decision_file: ".roboppi-loop/decision.json"
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

    it("rejects step.agent when no agent catalog is provided", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    agent: research
    instructions: "x"
`;
      expect(() => parseWorkflow(yaml)).toThrow(/no agent catalog/);
    });

    it("rejects step id with path traversal (..)", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  "../escape":
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/safe path segment/);
    });

    it("rejects step id with slash", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  "foo/bar":
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/safe path segment/);
    });

    it("rejects reserved step id _subworkflows", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  _subworkflows:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/reserved/);
    });

    it("rejects reserved step id _meta.json", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  _meta.json:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/reserved/);
    });

    it("rejects reserved step id _workflow.json", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  _workflow.json:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/reserved/);
    });

    it("rejects reserved step id _convergence", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  _convergence:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/reserved/);
    });

    it("rejects exports on worker steps", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
    exports:
      - from: step-a
        artifact: report
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/exports cannot be used on worker steps/);
    });

    it("accepts completion_check on subworkflow steps", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    workflow: "./child.yaml"
    bubble_subworkflow_events: true
    subworkflow_event_prefix: "auto"
    exports_mode: replace
    completion_check:
      worker: CUSTOM
      instructions: |
        set -e
        exit 0
      capabilities: [READ, RUN_COMMANDS]
    max_iterations: 3
    on_iterations_exhausted: continue
    convergence:
      enabled: true
      allowed_paths: ["src/**"]
`;
      const wf = parseWorkflow(yaml);
      expect(wf.steps["s"]?.workflow).toBe("./child.yaml");
      expect(wf.steps["s"]?.max_iterations).toBe(3);
      expect(wf.steps["s"]?.bubble_subworkflow_events).toBe(true);
      expect(wf.steps["s"]?.exports_mode).toBe("replace");
      expect(wf.steps["s"]?.completion_check?.worker).toBe("CUSTOM");
    });

    it("rejects missing decision_file on subworkflow completion_check (non-CUSTOM)", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    workflow: "./child.yaml"
    completion_check:
      worker: OPENCODE
      instructions: "check"
      capabilities: [READ]
    max_iterations: 2
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/decision_file/);
    });

    it("rejects bubble_subworkflow_events on worker steps", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
    bubble_subworkflow_events: true
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/bubble_subworkflow_events cannot be used on worker steps/);
    });

    it("rejects subworkflow_event_prefix on worker steps", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
    subworkflow_event_prefix: "x"
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/subworkflow_event_prefix cannot be used on worker steps/);
    });

    it("rejects exports_mode on worker steps", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
    exports_mode: replace
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/exports_mode cannot be used on worker steps/);
    });

    it("rejects invalid exports_mode on subworkflow steps", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
steps:
  s:
    workflow: "./child.yaml"
    exports_mode: nope
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/exports_mode must be "merge" or "replace"/);
    });
  });

  // -------------------------------------------------------------------------
  // Swarm DSL validation
  // -------------------------------------------------------------------------
  describe("agents config", () => {
    it("parses valid agents config", () => {
      const yaml = `
name: agents-wf
version: "1"
timeout: "30m"
agents:
  enabled: true
  team_name: "my-team"
  members:
    lead:
      agent: lead-agent
    researcher:
      agent: research-agent
      role: dormant
  tasks:
    - title: "Investigate"
      description: "Look at the code"
      assigned_to: researcher
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      const wf = parseWorkflow(yaml);
      expect(wf.agents).toBeDefined();
      expect(wf.agents!.enabled).toBe(true);
      expect(wf.agents!.team_name).toBe("my-team");
      expect(wf.agents!.members).toBeDefined();
      expect(wf.agents!.members!["lead"]!.agent).toBe("lead-agent");
      expect(wf.agents!.members!["researcher"]!.agent).toBe("research-agent");
      expect(wf.agents!.members!["researcher"]!.role).toBe("dormant");
      expect(wf.agents!.tasks).toHaveLength(1);
      expect(wf.agents!.tasks![0]!.title).toBe("Investigate");
      expect(wf.agents!.tasks![0]!.assigned_to).toBe("researcher");
    });

    it("parses disabled agents config (minimal)", () => {
      const yaml = `
name: agents-wf
version: "1"
timeout: "30m"
agents:
  enabled: false
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      const wf = parseWorkflow(yaml);
      expect(wf.agents).toBeDefined();
      expect(wf.agents!.enabled).toBe(false);
    });

    it("returns undefined agents when not present", () => {
      const wf = parseWorkflow(MINIMAL_WORKFLOW);
      expect(wf.agents).toBeUndefined();
    });

    it("rejects non-object agents", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
agents: "not-an-object"
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/agents must be an object/);
    });

    it("requires team_name when enabled", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
agents:
  enabled: true
  members:
    lead:
      agent: a
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/agents.team_name is required/);
    });

    it("requires members when enabled", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "t"
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/agents.members is required/);
    });

    it("rejects non-object members", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "t"
  members: ["bad"]
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/agents.members must be an object/);
    });

    it("rejects member key with path traversal", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "t"
  members:
    "../escape":
      agent: a
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/safe path segment/);
    });

    it("rejects member without agent field", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "t"
  members:
    lead:
      role: "lead"
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/agents.members.lead.agent/);
    });

    it("rejects tasks that are not an array", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "t"
  members:
    lead:
      agent: a
  tasks: "not-an-array"
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/agents.tasks must be an array/);
    });

    it("rejects task missing title", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "t"
  members:
    lead:
      agent: a
  tasks:
    - description: "desc only"
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/agents.tasks\[0\].title/);
    });

    it("rejects task missing description", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "t"
  members:
    lead:
      agent: a
  tasks:
    - title: "title only"
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/agents.tasks\[0\].description/);
    });

    it("rejects assigned_to referencing unknown member", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "t"
  members:
    lead:
      agent: a
  tasks:
    - title: "T"
      description: "D"
      assigned_to: unknown-member
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
      expect(() => parseWorkflow(yaml)).toThrow(/assigned_to references unknown member/);
    });

    it("parses agent seed task ids, dependencies, and tags", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "t"
  members:
    lead:
      agent: a
    reviewer:
      agent: b
  tasks:
    - id: bootstrap
      title: "Bootstrap"
      description: "Create initial plan"
      assigned_to: lead
      tags: [core, bootstrap]
    - id: review
      title: "Review"
      description: "Review implementation"
      assigned_to: reviewer
      depends_on: [bootstrap]
      requires_plan_approval: true
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      const wf = parseWorkflow(yaml);
      expect(wf.agents?.tasks).toEqual([
        {
          id: "bootstrap",
          title: "Bootstrap",
          description: "Create initial plan",
          assigned_to: "lead",
          tags: ["core", "bootstrap"],
        },
        {
          id: "review",
          title: "Review",
          description: "Review implementation",
          assigned_to: "reviewer",
          depends_on: ["bootstrap"],
          requires_plan_approval: true,
        },
      ]);
    });

    it("rejects task dependencies when a seed task id is missing", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "t"
  members:
    lead:
      agent: a
  tasks:
    - title: "Bootstrap"
      description: "Create initial plan"
    - id: review
      title: "Review"
      description: "Review implementation"
      depends_on: [bootstrap]
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(/agents.tasks\[0\].id is required when agents.tasks uses depends_on/);
    });

    it("rejects unknown task dependencies", () => {
      const yaml = `
name: w
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "t"
  members:
    lead:
      agent: a
  tasks:
    - id: bootstrap
      title: "Bootstrap"
      description: "Create initial plan"
    - id: review
      title: "Review"
      description: "Review implementation"
      depends_on: [unknown]
steps:
  s1:
    worker: CODEX_CLI
    instructions: "work"
    capabilities: [READ]
`;
      expect(() => parseWorkflow(yaml)).toThrow(/depends_on references unknown task "unknown"/);
    });
  });
});
