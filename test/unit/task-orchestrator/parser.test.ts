import { describe, expect, it } from "bun:test";

import {
  TaskOrchestratorParseError,
  parseTaskOrchestratorConfig,
} from "../../../src/task-orchestrator/index.js";

const MINIMAL_CONFIG = `
name: engineering-backlog
version: "1"
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  default:
    workflow: examples/agent-pr-loop.yaml
    workspace_mode: shared
`;

const FULL_CONFIG = `
name: engineering-backlog
version: "1"
runtime:
  poll_every: 45s
  max_active_instances: 4
state_dir: ./.roboppi-task
activity:
  github:
    enabled: true
clarification:
  enabled: true
  max_round_trips: 3
  reminder_after: 30m
  block_after: 72h
sources:
  github-main:
    type: github_issue
    repo: owner/repo
    labels: [roboppi, bug]
    local_path: /tmp/repo
    poll_every: 5m
  github-prs:
    type: github_pull_request
    repo: owner/repo
    base_branches: [main]
    local_path: /tmp/repo
  local-inbox:
    type: file_inbox
    path: ./inbox
    pattern: "*.json"
routes:
  bugfix:
    when:
      source: github_issue
      repository: owner/repo
      requested_action: implement
      labels_any: [bug, flaky]
      labels_all: [roboppi]
    workflow: examples/agent-pr-loop.yaml
    agents_files:
      - ./agents/reviewers.yaml
    workspace_mode: worktree
    branch_name: roboppi/task/{{task.slug}}
    base_ref: origin/main
    env:
      CI: "true"
    priority_class: background
    management:
      enabled: true
  fallback:
    workflow: examples/triage.yaml
    workspace_mode: shared
landing:
  mode: manual
`;

describe("parseTaskOrchestratorConfig", () => {
  it("parses a minimal config and applies defaults", () => {
    const cfg = parseTaskOrchestratorConfig(MINIMAL_CONFIG);

    expect(cfg.name).toBe("engineering-backlog");
    expect(cfg.version).toBe("1");
    expect(cfg.state_dir).toBe("./.roboppi-task");
    expect(cfg.runtime).toEqual({
      poll_every: "30s",
    });
    expect(cfg.clarification).toEqual({
      enabled: true,
      max_round_trips: 2,
    });
    expect(cfg.sources["inbox"]).toEqual({
      type: "file_inbox",
      path: "./inbox",
    });
    expect(cfg.routes["default"]).toMatchObject({
      workflow: "examples/agent-pr-loop.yaml",
      workspace_mode: "shared",
    });
    expect(cfg.landing.mode).toBe("manual");
  });

  it("parses a full config with route matching and worktree options", () => {
    const cfg = parseTaskOrchestratorConfig(FULL_CONFIG);
    const bugfix = cfg.routes["bugfix"];

    expect(cfg.state_dir).toBe("./.roboppi-task");
    expect(cfg.runtime).toEqual({
      poll_every: "45s",
      max_active_instances: 4,
    });
    expect(cfg.activity).toEqual({
      github: {
        enabled: true,
      },
    });
    expect(cfg.clarification).toEqual({
      enabled: true,
      max_round_trips: 3,
      reminder_after: "30m",
      block_after: "72h",
    });
    expect(cfg.sources["github-main"]).toMatchObject({
      type: "github_issue",
      repo: "owner/repo",
      labels: ["roboppi", "bug"],
      local_path: "/tmp/repo",
      poll_every: "5m",
    });
    expect(cfg.sources["github-prs"]).toMatchObject({
      type: "github_pull_request",
      repo: "owner/repo",
      base_branches: ["main"],
      local_path: "/tmp/repo",
    });
    expect(bugfix).toMatchObject({
      workflow: "examples/agent-pr-loop.yaml",
      workspace_mode: "worktree",
      branch_name: "roboppi/task/{{task.slug}}",
      base_ref: "origin/main",
      agents_files: ["./agents/reviewers.yaml"],
      env: { CI: "true" },
      priority_class: "background",
    });
    expect(bugfix?.management?.enabled).toBe(true);
    expect(bugfix?.when).toEqual({
      source: "github_issue",
      repository: "owner/repo",
      requested_action: "implement",
      labels_any: ["bug", "flaky"],
      labels_all: ["roboppi"],
    });
  });

  it("rejects worktree routes without branch_name", () => {
    const yaml = `
name: engineering-backlog
version: "1"
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  broken:
    workflow: examples/run.yaml
    workspace_mode: worktree
`;

    expect(() => parseTaskOrchestratorConfig(yaml)).toThrow(
      new TaskOrchestratorParseError(`"routes.broken.branch_name" must be a non-empty string`),
    );
  });

  it("rejects routes that reference missing source types", () => {
    const yaml = `
name: engineering-backlog
version: "1"
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  github-only:
    when:
      source: github_issue
    workflow: examples/run.yaml
    workspace_mode: shared
`;

    expect(() => parseTaskOrchestratorConfig(yaml)).toThrow(
      /references source type "github_issue" not present/,
    );
  });

  it("rejects invalid landing mode", () => {
    const yaml = `
name: engineering-backlog
version: "1"
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  default:
    workflow: examples/run.yaml
    workspace_mode: shared
landing:
  mode: auto
`;

    expect(() => parseTaskOrchestratorConfig(yaml)).toThrow(
      /"landing.mode" must be one of: disabled, manual/,
    );
  });

  it("rejects invalid runtime poll_every duration", () => {
    const yaml = `
name: engineering-backlog
version: "1"
runtime:
  poll_every: often
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  default:
    workflow: examples/run.yaml
    workspace_mode: shared
`;

    expect(() => parseTaskOrchestratorConfig(yaml)).toThrow(
      /runtime\.poll_every: invalid duration "often"/,
    );
  });

  it("rejects non-boolean activity.github.enabled", () => {
    const yaml = `
name: engineering-backlog
version: "1"
activity:
  github:
    enabled: yes
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  default:
    workflow: examples/run.yaml
    workspace_mode: shared
`;

    expect(() => parseTaskOrchestratorConfig(yaml)).toThrow(
      /"activity\.github\.enabled" must be a boolean/,
    );
  });

  it("rejects clarification block_after that is not greater than reminder_after", () => {
    const yaml = `
name: engineering-backlog
version: "1"
clarification:
  reminder_after: 30m
  block_after: 15m
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  default:
    workflow: examples/run.yaml
    workspace_mode: shared
`;

    expect(() => parseTaskOrchestratorConfig(yaml)).toThrow(
      /"clarification\.block_after" must be greater than "clarification\.reminder_after"/,
    );
  });

  it("rejects non-string route env values", () => {
    const yaml = `
name: engineering-backlog
version: "1"
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  default:
    workflow: examples/run.yaml
    workspace_mode: shared
    env:
      CI: true
`;

    expect(() => parseTaskOrchestratorConfig(yaml)).toThrow(
      /"routes.default.env.CI" must be a string/,
    );
  });
});
