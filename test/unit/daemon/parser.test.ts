import { describe, it, expect } from "bun:test";
import { parseDaemonConfig, DaemonParseError } from "../../../src/daemon/parser.js";

const MINIMAL_CONFIG = `
name: my-daemon
version: "1"
workspace: ./project
events:
  every5m:
    type: interval
    every: "5m"
triggers:
  run-tests:
    on: every5m
    workflow: ./workflows/test.yaml
`;

const FULL_CONFIG = `
name: full-daemon
version: "1"
description: "A full daemon config"
workspace: ./project
log_dir: ./logs
state_dir: ./state
max_concurrent_workflows: 3
events:
  cron-hourly:
    type: cron
    schedule: "0 * * * *"
  file-changes:
    type: fswatch
    paths:
      - ./src
      - ./lib
    ignore:
      - "*.tmp"
    events: [create, modify]
  webhook-deploy:
    type: webhook
    path: /deploy
    port: 8080
    secret: my-secret
    method: POST
  cmd-check:
    type: command
    command: "git status --porcelain"
    interval: "30s"
    trigger_on: change
triggers:
  on-file-change:
    on: file-changes
    workflow: ./workflows/lint.yaml
    enabled: true
    filter:
      path:
        pattern: "src/.+"
      severity:
        in: [high, critical]
      count: 5
      active: true
    debounce: "2s"
    cooldown: "10m"
    max_queue: 5
    evaluate:
      worker: CLAUDE_CODE
      instructions: "Decide if this change is worth linting"
      capabilities: [READ]
      timeout: "30s"
    context:
      env:
        CI: "true"
      last_result: true
      event_payload: true
    analyze:
      worker: CODEX_CLI
      instructions: "Summarize lint results"
      capabilities: [READ, EDIT]
      timeout: "1m"
      outputs:
        - name: report
          path: "./reports/lint.md"
    on_workflow_failure: retry
    max_retries: 5
  on-deploy:
    on: webhook-deploy
    workflow: ./workflows/deploy.yaml
`;

describe("parseDaemonConfig", () => {
  describe("valid configs", () => {
    it("parses a minimal config", () => {
      const cfg = parseDaemonConfig(MINIMAL_CONFIG);
      expect(cfg.name).toBe("my-daemon");
      expect(cfg.version).toBe("1");
      expect(cfg.workspace).toBe("./project");
      expect(cfg.events["every5m"]).toBeDefined();
      expect(cfg.events["every5m"]!.type).toBe("interval");
      expect(cfg.triggers["run-tests"]).toBeDefined();
      expect(cfg.triggers["run-tests"]!.on).toBe("every5m");
      expect(cfg.triggers["run-tests"]!.workflow).toBe("./workflows/test.yaml");
    });

    it("parses a full config with all optional fields", () => {
      const cfg = parseDaemonConfig(FULL_CONFIG);
      expect(cfg.name).toBe("full-daemon");
      expect(cfg.description).toBe("A full daemon config");
      expect(cfg.log_dir).toBe("./logs");
      expect(cfg.state_dir).toBe("./state");
      expect(cfg.max_concurrent_workflows).toBe(3);
    });

    it("parses cron event source", () => {
      const cfg = parseDaemonConfig(FULL_CONFIG);
      const ev = cfg.events["cron-hourly"]!;
      expect(ev.type).toBe("cron");
      if (ev.type === "cron") {
        expect(ev.schedule).toBe("0 * * * *");
      }
    });

    it("parses interval event source", () => {
      const cfg = parseDaemonConfig(MINIMAL_CONFIG);
      const ev = cfg.events["every5m"]!;
      expect(ev.type).toBe("interval");
      if (ev.type === "interval") {
        expect(ev.every).toBe("5m");
      }
    });

    it("parses fswatch event source with all options", () => {
      const cfg = parseDaemonConfig(FULL_CONFIG);
      const ev = cfg.events["file-changes"]!;
      expect(ev.type).toBe("fswatch");
      if (ev.type === "fswatch") {
        expect(ev.paths).toEqual(["./src", "./lib"]);
        expect(ev.ignore).toEqual(["*.tmp"]);
        expect(ev.events).toEqual(["create", "modify"]);
      }
    });

    it("parses webhook event source", () => {
      const cfg = parseDaemonConfig(FULL_CONFIG);
      const ev = cfg.events["webhook-deploy"]!;
      expect(ev.type).toBe("webhook");
      if (ev.type === "webhook") {
        expect(ev.path).toBe("/deploy");
        expect(ev.port).toBe(8080);
        expect(ev.secret).toBe("my-secret");
        expect(ev.method).toBe("POST");
      }
    });

    it("parses command event source", () => {
      const cfg = parseDaemonConfig(FULL_CONFIG);
      const ev = cfg.events["cmd-check"]!;
      expect(ev.type).toBe("command");
      if (ev.type === "command") {
        expect(ev.command).toBe("git status --porcelain");
        expect(ev.interval).toBe("30s");
        expect(ev.trigger_on).toBe("change");
      }
    });

    it("parses trigger with filter values", () => {
      const cfg = parseDaemonConfig(FULL_CONFIG);
      const trigger = cfg.triggers["on-file-change"]!;
      expect(trigger.filter).toBeDefined();
      expect(trigger.filter!["path"]).toEqual({ pattern: "src/.+" });
      expect(trigger.filter!["severity"]).toEqual({ in: ["high", "critical"] });
      expect(trigger.filter!["count"]).toBe(5);
      expect(trigger.filter!["active"]).toBe(true);
    });

    it("parses trigger with rate control", () => {
      const cfg = parseDaemonConfig(FULL_CONFIG);
      const trigger = cfg.triggers["on-file-change"]!;
      expect(trigger.debounce).toBe("2s");
      expect(trigger.cooldown).toBe("10m");
      expect(trigger.max_queue).toBe(5);
    });

    it("parses trigger with evaluate gate", () => {
      const cfg = parseDaemonConfig(FULL_CONFIG);
      const trigger = cfg.triggers["on-file-change"]!;
      expect(trigger.evaluate).toBeDefined();
      expect(trigger.evaluate!.worker).toBe("CLAUDE_CODE");
      expect(trigger.evaluate!.instructions).toBe("Decide if this change is worth linting");
      expect(trigger.evaluate!.capabilities).toEqual(["READ"]);
      expect(trigger.evaluate!.timeout).toBe("30s");
    });

    it("parses trigger with context injection", () => {
      const cfg = parseDaemonConfig(FULL_CONFIG);
      const trigger = cfg.triggers["on-file-change"]!;
      expect(trigger.context).toBeDefined();
      expect(trigger.context!.env).toEqual({ CI: "true" });
      expect(trigger.context!.last_result).toBe(true);
      expect(trigger.context!.event_payload).toBe(true);
    });

    it("parses trigger with analyze definition", () => {
      const cfg = parseDaemonConfig(FULL_CONFIG);
      const trigger = cfg.triggers["on-file-change"]!;
      expect(trigger.analyze).toBeDefined();
      expect(trigger.analyze!.worker).toBe("CODEX_CLI");
      expect(trigger.analyze!.instructions).toBe("Summarize lint results");
      expect(trigger.analyze!.capabilities).toEqual(["READ", "EDIT"]);
      expect(trigger.analyze!.outputs).toHaveLength(1);
      expect(trigger.analyze!.outputs![0]!.name).toBe("report");
    });

    it("parses trigger with failure handling", () => {
      const cfg = parseDaemonConfig(FULL_CONFIG);
      const trigger = cfg.triggers["on-file-change"]!;
      expect(trigger.on_workflow_failure).toBe("retry");
      expect(trigger.max_retries).toBe(5);
    });

    it("parses all valid event types", () => {
      const types = ["cron", "interval", "fswatch", "webhook", "command"] as const;
      for (const t of types) {
        let eventDef = "";
        switch (t) {
          case "cron":
            eventDef = 'schedule: "* * * * *"';
            break;
          case "interval":
            eventDef = 'every: "1m"';
            break;
          case "fswatch":
            eventDef = "paths:\n      - ./src";
            break;
          case "webhook":
            eventDef = "path: /hook";
            break;
          case "command":
            eventDef = 'command: "echo hi"\n    interval: "10s"';
            break;
        }
        const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: ${t}
    ${eventDef}
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
        const cfg = parseDaemonConfig(yaml);
        expect(cfg.events["ev"]!.type).toBe(t);
      }
    });

    it("parses all valid worker kinds in evaluate", () => {
      const workers = ["CODEX_CLI", "CLAUDE_CODE", "OPENCODE", "CUSTOM"] as const;
      for (const worker of workers) {
        const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
    evaluate:
      worker: ${worker}
      instructions: "check"
      capabilities: [READ]
`;
        const cfg = parseDaemonConfig(yaml);
        expect(cfg.triggers["tr"]!.evaluate!.worker).toBe(worker);
      }
    });

    it("parses all valid on_workflow_failure values", () => {
      for (const val of ["ignore", "retry", "pause_trigger"] as const) {
        const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
    on_workflow_failure: ${val}
`;
        const cfg = parseDaemonConfig(yaml);
        expect(cfg.triggers["tr"]!.on_workflow_failure).toBe(val);
      }
    });

    it("parses string filter value", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
    filter:
      branch: main
`;
      const cfg = parseDaemonConfig(yaml);
      expect(cfg.triggers["tr"]!.filter!["branch"]).toBe("main");
    });
  });

  describe("validation errors", () => {
    it("rejects invalid YAML", () => {
      expect(() => parseDaemonConfig("{{invalid")).toThrow(DaemonParseError);
    });

    it("rejects non-object YAML", () => {
      expect(() => parseDaemonConfig("hello")).toThrow(DaemonParseError);
    });

    it("rejects missing name", () => {
      const yaml = `
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"name" must be a non-empty string/);
    });

    it("rejects wrong version", () => {
      const yaml = `
name: t
version: "2"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"version" must be "1"/);
    });

    it("rejects missing workspace", () => {
      const yaml = `
name: t
version: "1"
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"workspace" must be a non-empty string/);
    });

    it("rejects missing events", () => {
      const yaml = `
name: t
version: "1"
workspace: .
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"events" must be an object/);
    });

    it("rejects empty events", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events: {}
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"events" must contain at least one event source/);
    });

    it("rejects missing triggers", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"triggers" must be an object/);
    });

    it("rejects empty triggers", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers: {}
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"triggers" must contain at least one trigger/);
    });

    it("rejects invalid event type", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: invalid_type
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/must be one of.*cron.*interval.*fswatch.*webhook.*command/);
    });

    it("rejects event missing required type-specific fields (cron)", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: cron
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"events.ev.schedule" must be a non-empty string/);
    });

    it("rejects event missing required type-specific fields (interval)", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"events.ev.every" must be a non-empty string/);
    });

    it("rejects fswatch without paths", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: fswatch
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"events.ev.paths" must be a non-empty array/);
    });

    it("rejects fswatch with empty paths", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: fswatch
    paths: []
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"events.ev.paths" must be a non-empty array/);
    });

    it("rejects fswatch with invalid event names", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: fswatch
    paths: [./src]
    events: [create, invalid_event]
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/invalid value "invalid_event"/);
    });

    it("rejects webhook without path", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: webhook
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"events.ev.path" must be a non-empty string/);
    });

    it("rejects command event without command", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: command
    interval: "10s"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"events.ev.command" must be a non-empty string/);
    });

    it("rejects command event without interval", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: command
    command: "echo hi"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"events.ev.interval" must be a non-empty string/);
    });

    it("rejects command event with invalid trigger_on", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: command
    command: "echo hi"
    interval: "10s"
    trigger_on: invalid
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/trigger_on" must be "change" or "always"/);
    });

    it("rejects trigger referencing unknown event", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: nonexistent
    workflow: ./w.yaml
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/references unknown event "nonexistent"/);
    });

    it("rejects trigger missing workflow", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/"triggers.tr.workflow" must be a non-empty string/);
    });

    it("rejects trigger with invalid on_workflow_failure", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
    on_workflow_failure: crash
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/on_workflow_failure" must be "ignore", "retry", or "pause_trigger"/);
    });

    it("rejects invalid worker in evaluate", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
    evaluate:
      worker: BAD_WORKER
      instructions: "check"
      capabilities: [READ]
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/must be one of/);
    });

    it("rejects invalid capability in evaluate", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
    evaluate:
      worker: CLAUDE_CODE
      instructions: "check"
      capabilities: [INVALID_CAP]
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/invalid capability/);
    });

    it("rejects evaluate missing instructions", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
    evaluate:
      worker: CLAUDE_CODE
      capabilities: [READ]
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/instructions" must be a non-empty string/);
    });

    it("rejects invalid filter value (array)", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
    filter:
      bad: [1, 2, 3]
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/must be a string, number, boolean/);
    });

    it("rejects invalid filter value (object without pattern or in)", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
    filter:
      bad:
        unknown_key: value
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/must be a primitive/);
    });

    it("rejects invalid worker in analyze", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
    analyze:
      worker: INVALID
      instructions: "analyze"
      capabilities: [READ]
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/must be one of/);
    });

    it("rejects non-boolean enabled field", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
    enabled: "yes"
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/enabled" must be a boolean/);
    });

    it("rejects non-number max_queue", () => {
      const yaml = `
name: t
version: "1"
workspace: .
events:
  ev:
    type: interval
    every: "1m"
triggers:
  tr:
    on: ev
    workflow: ./w.yaml
    max_queue: "five"
`;
      expect(() => parseDaemonConfig(yaml)).toThrow(/max_queue" must be a number/);
    });
  });
});
