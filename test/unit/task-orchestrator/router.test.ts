import { describe, expect, it } from "bun:test";

import {
  TaskRouter,
  TaskRoutingError,
  parseTaskOrchestratorConfig,
} from "../../../src/task-orchestrator/index.js";
import type { TaskEnvelope } from "../../../src/task-orchestrator/index.js";

const CONFIG = parseTaskOrchestratorConfig(`
name: engineering-backlog
version: "1"
sources:
  github-main:
    type: github_issue
    repo: owner/repo
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  bugfix:
    when:
      source: github_issue
      repository: owner/repo
      requested_action: implement
      labels_any: [bug, flaky]
    workflow: examples/agent-pr-loop.yaml
    workspace_mode: worktree
    branch_name: roboppi/task/{{task.slug}}
    env:
      CI: "true"
      ROBOPPI_TASK_ID: "should-not-win"
    priority_class: background
    management:
      enabled: true
  catch-all:
    workflow: examples/triage.yaml
    workspace_mode: shared
`);

function makeTask(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
  return {
    version: "1",
    task_id: "github:issue:owner/repo#123",
    source: {
      kind: "github_issue",
      system_id: "github",
      external_id: "owner/repo#123",
      url: "https://example.invalid/owner/repo/issues/123",
    },
    title: "Fix flaky scheduler restart test",
    body: "normalized issue body",
    labels: ["bug", "ci-flake"],
    priority: "normal",
    repository: {
      id: "owner/repo",
      default_branch: "main",
    },
    requested_action: "implement",
    requested_by: "octocat",
    timestamps: {
      created_at: 1000,
      updated_at: 2000,
    },
    ...overrides,
  };
}

describe("TaskRouter", () => {
  it("selects the first matching route and explains why", () => {
    const router = new TaskRouter(CONFIG);
    const decision = router.route(makeTask(), 3000);

    expect(decision).toMatchObject({
      task_id: "github:issue:owner/repo#123",
      route_id: "bugfix",
      decided_at: 3000,
      matched_on: [
        "source=github_issue",
        "repository=owner/repo",
        "requested_action=implement",
        "labels_any=bug",
      ],
      plan: {
        workflow: "examples/agent-pr-loop.yaml",
        workspaceMode: "worktree",
        priorityClass: "background",
        managementEnabled: true,
        worktree: {
          branchNameTemplate: "roboppi/task/{{task.slug}}",
        },
      },
    });
  });

  it("injects task-derived env and protects reserved task keys", () => {
    const router = new TaskRouter(CONFIG);
    const decision = router.route(makeTask());

    expect(decision.plan.env).toEqual({
      CI: "true",
      ROBOPPI_TASK_ID: "github:issue:owner/repo#123",
      ROBOPPI_TASK_SOURCE_KIND: "github_issue",
      ROBOPPI_TASK_EXTERNAL_ID: "owner/repo#123",
      ROBOPPI_TASK_REQUESTED_ACTION: "implement",
      ROBOPPI_TASK_PRIORITY: "normal",
      ROBOPPI_TASK_SLUG: "fix-flaky-scheduler-restart-test",
      ROBOPPI_TASK_REPOSITORY: "owner/repo",
      ROBOPPI_TASK_REQUESTED_BY: "octocat",
    });
  });

  it("falls back to a default route when specific predicates do not match", () => {
    const router = new TaskRouter(CONFIG);
    const decision = router.route(
      makeTask({
        labels: ["docs"],
        requested_action: "triage",
      }),
    );

    expect(decision.route_id).toBe("catch-all");
    expect(decision.matched_on).toEqual(["default route"]);
    expect(decision.plan.workflow).toBe("examples/triage.yaml");
    expect(decision.plan.workspaceMode).toBe("shared");
  });

  it("throws when no route matches", () => {
    const router = new TaskRouter(
      parseTaskOrchestratorConfig(`
name: engineering-backlog
version: "1"
sources:
  github-main:
    type: github_issue
    repo: owner/repo
routes:
  review:
    when:
      source: github_issue
      requested_action: review
    workflow: examples/review.yaml
    workspace_mode: shared
`),
    );

    expect(() => router.route(makeTask())).toThrow(TaskRoutingError);
  });
});
