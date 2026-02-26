/**
 * Unit tests: Sentinel / Stall parser validation
 */
import { describe, test, expect } from "bun:test";
import { parseWorkflow, WorkflowParseError } from "../../src/workflow/parser.js";

/** Minimal valid workflow YAML wrapper */
function wrapYaml(extra: string): string {
  return `
name: test-wf
version: "1"
timeout: "30s"
${extra}
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
`;
}

/** Minimal valid step with extra fields */
function stepYaml(stepExtra: string): string {
  return `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    ${stepExtra}
`;
}

describe("Sentinel parser: workflow-level sentinel block", () => {
  test("valid workflow with sentinel block parses successfully", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
sentinel:
  enabled: true
  telemetry:
    events_file: "_workflow/events.jsonl"
    state_file: "_workflow/state.json"
    include_worker_output: false
  defaults:
    no_output_timeout: "30s"
    interrupt:
      strategy: cancel
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
`;
    const def = parseWorkflow(yaml);
    expect(def.sentinel).toBeDefined();
    expect(def.sentinel!.enabled).toBe(true);
    expect(def.sentinel!.telemetry!.events_file).toBe("_workflow/events.jsonl");
    expect(def.sentinel!.defaults!.no_output_timeout).toBe("30s");
    expect(def.sentinel!.defaults!.interrupt!.strategy).toBe("cancel");
  });

  test("invalid sentinel.enabled (non-boolean) throws error", () => {
    const yaml = wrapYaml('sentinel:\n  enabled: "yes"');
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/sentinel\.enabled.*boolean/);
  });
});

describe("Sentinel parser: step-level stall block", () => {
  test("valid step with stall block parses successfully", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      enabled: true
      no_output_timeout: "10s"
      probe:
        interval: "5s"
        timeout: "3s"
        command: "echo test-probe"
        stall_threshold: 3
      on_stall:
        action: interrupt
        error_class: RETRYABLE_TRANSIENT
        fingerprint_prefix: ["custom-fp"]
      on_terminal:
        action: fail
`;
    const def = parseWorkflow(yaml);
    const stall = def.steps["A"]!.stall!;
    expect(stall.enabled).toBe(true);
    expect(stall.no_output_timeout).toBe("10s");
    expect(stall.probe!.interval).toBe("5s");
    expect(stall.probe!.stall_threshold).toBe(3);
    expect(stall.on_stall!.action).toBe("interrupt");
    expect(stall.on_terminal!.action).toBe("fail");
  });

  test("invalid stall.no_output_timeout (non-string) throws error", () => {
    const yaml = stepYaml("stall:\n      no_output_timeout: 10");
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/no_output_timeout.*string/);
  });

  test("invalid stall.probe.stall_threshold (< 1) throws error", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      probe:
        interval: "5s"
        command: "echo test"
        stall_threshold: 0
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/stall_threshold.*>= 1/);
  });

  test("invalid stall.on_stall.action (not in enum) throws error", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      on_stall:
        action: restart
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/action must be one of.*interrupt.*fail.*ignore/);
  });

  test("stall on completion_check parses successfully", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    max_iterations: 5
    on_iterations_exhausted: abort
    completion_check:
      worker: CUSTOM
      instructions: "check A"
      capabilities: [READ]
      stall:
        no_output_timeout: "5s"
        on_stall:
          action: interrupt
`;
    const def = parseWorkflow(yaml);
    const checkStall = def.steps["A"]!.completion_check!.stall!;
    expect(checkStall.no_output_timeout).toBe("5s");
    expect(checkStall.on_stall!.action).toBe("interrupt");
  });

  test("_workflow is rejected as a step ID (reserved for telemetry)", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  _workflow:
    worker: CUSTOM
    instructions: "step _workflow"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/step id "_workflow" is reserved/);
  });

  test("valid error_class passes validation", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      on_stall:
        action: interrupt
        error_class: RETRYABLE_TRANSIENT
`;
    const def = parseWorkflow(yaml);
    expect(def.steps["A"]!.stall!.on_stall!.error_class).toBe("RETRYABLE_TRANSIENT");
  });

  test("invalid error_class (typo) throws error", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      on_stall:
        action: interrupt
        error_class: RETRYABLE_TRANSIET
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/error_class must be one of/);
  });

  test("valid probe with capture_stderr: true parses successfully", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      probe:
        interval: "5s"
        command: "echo test"
        stall_threshold: 3
        capture_stderr: true
`;
    const def = parseWorkflow(yaml);
    expect(def.steps["A"]!.stall!.probe!.capture_stderr).toBe(true);
  });

  test("valid probe with capture_stderr: false parses successfully", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      probe:
        interval: "5s"
        command: "echo test"
        stall_threshold: 3
        capture_stderr: false
`;
    const def = parseWorkflow(yaml);
    expect(def.steps["A"]!.stall!.probe!.capture_stderr).toBe(false);
  });

  test("invalid probe.capture_stderr (non-boolean) throws error", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      probe:
        interval: "5s"
        command: "echo test"
        stall_threshold: 3
        capture_stderr: "yes"
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/capture_stderr.*boolean/);
  });

  test("valid probe with require_zero_exit: true parses successfully", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      probe:
        interval: "5s"
        command: "echo test"
        stall_threshold: 3
        require_zero_exit: true
`;
    const def = parseWorkflow(yaml);
    expect(def.steps["A"]!.stall!.probe!.require_zero_exit).toBe(true);
  });

  test("invalid probe.require_zero_exit (non-boolean) throws error", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      probe:
        interval: "5s"
        command: "echo test"
        stall_threshold: 3
        require_zero_exit: "yes"
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/require_zero_exit.*boolean/);
  });

  test("_stall is in reserved artifact names", () => {
    // Outputs with name="_stall" should be rejected as reserved
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    outputs:
      - name: "_stall"
        path: "some/path"
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/reserved artifact name "_stall"/);
  });
});

describe("Sentinel parser: activity_source", () => {
  test("valid activity_source values parse successfully", () => {
    for (const source of ["worker_event", "any_event", "probe_only"] as const) {
      const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      no_output_timeout: "10s"
      activity_source: ${source}
`;
      const def = parseWorkflow(yaml);
      expect(def.steps["A"]!.stall!.activity_source).toBe(source);
    }
  });

  test("invalid activity_source value throws error", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      no_output_timeout: "10s"
      activity_source: invalid_source
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/activity_source must be one of/);
  });

  test("activity_source at sentinel.defaults level parses successfully", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
sentinel:
  enabled: true
  defaults:
    no_output_timeout: "30s"
    activity_source: any_event
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
`;
    const def = parseWorkflow(yaml);
    expect(def.sentinel!.defaults!.activity_source).toBe("any_event");
  });

  test("invalid activity_source at sentinel.defaults level throws error", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
sentinel:
  enabled: true
  defaults:
    activity_source: bad_value
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/activity_source must be one of/);
  });
});

describe("Sentinel parser: probe error policy", () => {
  test("valid on_probe_error values parse successfully", () => {
    for (const action of ["ignore", "stall", "terminal"] as const) {
      const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      probe:
        interval: "5s"
        command: "echo test"
        stall_threshold: 3
        on_probe_error: ${action}
`;
      const def = parseWorkflow(yaml);
      expect(def.steps["A"]!.stall!.probe!.on_probe_error).toBe(action);
    }
  });

  test("invalid on_probe_error value throws error", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      probe:
        interval: "5s"
        command: "echo test"
        stall_threshold: 3
        on_probe_error: restart
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/on_probe_error must be one of/);
  });

  test("valid probe_error_threshold parses successfully", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      probe:
        interval: "5s"
        command: "echo test"
        stall_threshold: 3
        probe_error_threshold: 5
`;
    const def = parseWorkflow(yaml);
    expect(def.steps["A"]!.stall!.probe!.probe_error_threshold).toBe(5);
  });

  test("invalid probe_error_threshold (< 1) throws error", () => {
    const yaml = `
name: test-wf
version: "1"
timeout: "30s"
steps:
  A:
    worker: CUSTOM
    instructions: "step A"
    capabilities: [READ]
    stall:
      probe:
        interval: "5s"
        command: "echo test"
        stall_threshold: 3
        probe_error_threshold: 0
`;
    expect(() => parseWorkflow(yaml)).toThrow(WorkflowParseError);
    expect(() => parseWorkflow(yaml)).toThrow(/probe_error_threshold.*>= 1/);
  });
});
