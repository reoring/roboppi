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

describe("parseWorkflow – management agent validation", () => {
  it("TC-MA-P-01: management not specified means disabled", () => {
    const wf = parseWorkflow(MINIMAL_WORKFLOW);
    expect(wf.management).toBeUndefined();
  });

  it("TC-MA-P-02: management.enabled=true without agent is an error", () => {
    const yaml = `
name: test-workflow
version: "1"
timeout: "30m"
management:
  enabled: true
steps:
  step1:
    worker: CODEX_CLI
    instructions: "Do something"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/management\.agent/);
  });

  it("TC-MA-P-03: unknown hook key is an error", () => {
    const yaml = `
name: test-workflow
version: "1"
timeout: "30m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "30s"
  hooks:
    pre_step: true
    unknown_hook: true
steps:
  step1:
    worker: CODEX_CLI
    instructions: "Do something"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/unknown_hook/);
  });

  it("TC-MA-P-04: max_consecutive_interventions < 1 is an error", () => {
    const yaml = `
name: test-workflow
version: "1"
timeout: "30m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "30s"
  max_consecutive_interventions: 0
steps:
  step1:
    worker: CODEX_CLI
    instructions: "Do something"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/max_consecutive_interventions/);
  });

  it("TC-MA-P-05: reserved step id _management", () => {
    const yaml = `
name: test-workflow
version: "1"
timeout: "30m"
steps:
  _management:
    worker: CODEX_CLI
    instructions: "x"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/reserved/);
  });

  it("TC-MA-P-06: reserved artifact name _management", () => {
    const yaml = `
name: test-workflow
version: "1"
timeout: "30m"
steps:
  step1:
    worker: CODEX_CLI
    instructions: "Do something"
    capabilities: [READ]
    outputs:
      - name: _management
        path: "./out"
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/_management/);
  });

  it("TC-MA-P-07: management.agent with both worker and agent (catalog ref) is an error", () => {
    const yaml = `
name: test-workflow
version: "1"
timeout: "30m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    agent: workflow-manager
    capabilities: [READ]
    timeout: "30s"
steps:
  step1:
    worker: CODEX_CLI
    instructions: "Do something"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/mutually exclusive/);
  });

  it("TC-MA-P-08: management.agent.timeout must be a valid DurationString", () => {
    const yaml = `
name: test-workflow
version: "1"
timeout: "30m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "not-a-duration"
steps:
  step1:
    worker: CODEX_CLI
    instructions: "Do something"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/duration|timeout/i);
  });

  it("TC-MA-P-09: min_remaining_time must be a valid DurationString", () => {
    const yaml = `
name: test-workflow
version: "1"
timeout: "30m"
management:
  enabled: true
  agent:
    worker: OPENCODE
    capabilities: [READ]
    timeout: "30s"
  min_remaining_time: "xxx"
steps:
  step1:
    worker: CODEX_CLI
    instructions: "Do something"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/duration|min_remaining_time/i);
  });

  it("TC-MA-P-10: step-level management.enabled must be boolean", () => {
    const yaml = `
name: test-workflow
version: "1"
timeout: "30m"
steps:
  step1:
    worker: CODEX_CLI
    instructions: "Do something"
    capabilities: [READ]
    management:
      enabled: "yes"
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/boolean|management\.enabled/i);
  });

  it("TC-MA-P-11: step-level management.context_hint must be string", () => {
    const yaml = `
name: test-workflow
version: "1"
timeout: "30m"
steps:
  step1:
    worker: CODEX_CLI
    instructions: "Do something"
    capabilities: [READ]
    management:
      context_hint: 123
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/string|context_hint/i);
  });

  it("TC-MA-P-12: management.agent.agent must reference a known agent", () => {
    const agents = {
      mgr: {
        worker: "OPENCODE",
        model: "openai/gpt-5.2",
        capabilities: ["READ"],
      },
    };

    const yaml = `
name: test-workflow
version: "1"
timeout: "30m"
management:
  enabled: true
  agent:
    agent: unknown
    timeout: "30s"
    capabilities: [READ]
steps:
  step1:
    worker: CODEX_CLI
    instructions: "Do something"
    capabilities: [READ]
`;

    expect(() => parseWorkflow(yaml, { agents: agents as any })).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml, { agents: agents as any })).toThrow(/unknown agent/);
  });
});
