import { beforeEach, afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  TaskDispatcher,
  TaskDispatchError,
  TaskRegistryStore,
  TaskRouter,
  parseTaskOrchestratorConfig,
} from "../../../src/task-orchestrator/index.js";
import type { TaskEnvelope } from "../../../src/task-orchestrator/index.js";
import type {
  CheckResult,
  StepRunResult,
  StepRunner,
} from "../../../src/workflow/executor.js";
import type {
  CompletionCheckDef,
  StepDefinition,
} from "../../../src/workflow/types.js";
import { ErrorClass } from "../../../src/types/common.js";
import { WorkflowStatus } from "../../../src/workflow/types.js";

class MockStepRunner implements StepRunner {
  readonly stepEnvs: Array<Record<string, string> | undefined> = [];
  readonly workspaceDirs: string[] = [];

  constructor(
    private readonly stepHandler: (
      stepId: string,
      env: Record<string, string> | undefined,
    ) => Promise<StepRunResult>,
  ) {}

  async runStep(
    stepId: string,
    _step: StepDefinition,
    workspaceDir: string,
    _abortSignal: AbortSignal,
    env?: Record<string, string>,
  ): Promise<StepRunResult> {
    this.workspaceDirs.push(workspaceDir);
    this.stepEnvs.push(env);
    return this.stepHandler(stepId, env);
  }

  async runCheck(
    _stepId: string,
    _check: CompletionCheckDef,
    _workspaceDir: string,
    _abortSignal: AbortSignal,
    _env?: Record<string, string>,
  ): Promise<CheckResult> {
    return { complete: true, failed: false };
  }
}

function makeTask(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
  return {
    version: "1",
    task_id: "github:issue:owner/repo#123",
    source: {
      kind: "github_issue",
      system_id: "github",
      external_id: "owner/repo#123",
      url: "https://example.invalid/owner/repo/issues/123",
      revision: "rev-2",
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

function makePullRequestTask(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
  return {
    version: "1",
    task_id: "github:pull_request:owner/repo#45",
    source: {
      kind: "github_pull_request",
      system_id: "github",
      external_id: "owner/repo#45",
      url: "https://example.invalid/owner/repo/pull/45",
      revision: "pr-rev-1",
    },
    title: "Review PR #45",
    body: "Implements the requested fix.\n\nCloses #123",
    labels: ["review"],
    priority: "normal",
    repository: {
      id: "owner/repo",
      default_branch: "main",
    },
    requested_action: "review",
    requested_by: "octocat",
    metadata: {
      base_ref: "main",
      head_ref: "feature/fix-45",
      head_sha: "abc123def456",
    },
    timestamps: {
      created_at: 3000,
      updated_at: 4000,
    },
    ...overrides,
  };
}

const CONFIG = parseTaskOrchestratorConfig(`
name: engineering-backlog
version: "1"
sources:
  github-main:
    type: github_issue
    repo: owner/repo
routes:
  bugfix:
    when:
      source: github_issue
      repository: owner/repo
      requested_action: implement
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: worktree
    branch_name: roboppi/task/{{task.slug}}
    base_ref: origin/main
    env:
      CI: "true"
`);

const PR_CONFIG = parseTaskOrchestratorConfig(`
name: engineering-backlog
version: "1"
sources:
  github-prs:
    type: github_pull_request
    repo: owner/repo
routes:
  pr-review:
    when:
      source: github_pull_request
      repository: owner/repo
      requested_action: review
    workflow: workflows/pr-review.yaml
    workspace_mode: shared
    env:
      CI: "true"
`);

describe("TaskDispatcher", () => {
  let workspaceDir: string;
  let stateDir: string;
  let registry: TaskRegistryStore;
  let router: TaskRouter;

  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "roboppi-task-dispatch-ws-"));
    stateDir = await mkdtemp(path.join(tmpdir(), "roboppi-task-dispatch-state-"));
    registry = new TaskRegistryStore(stateDir);
    router = new TaskRouter(CONFIG);
    await mkdir(path.join(workspaceDir, "workflows"), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("dispatches a workflow, injects task artifacts, and records completion", async () => {
    await writeFile(
      path.join(workspaceDir, "workflows", "task.yaml"),
      `
name: task-workflow
version: "1"
timeout: "5m"
agents:
  enabled: true
  team_name: "issue-team"
  members:
    lead:
      agent: lead-agent
      roles: [lead, publisher]
    reporter:
      agent: reporter-agent
      roles: [publisher, github_reporter]
reporting:
  default_publisher: lead
  sinks:
    github:
      enabled: true
      publisher_member: reporter
      allowed_members: [reporter]
      allowed_roles: [publisher]
      events: [progress, ready_to_land]
      projection: status_comment
      aggregate: latest_per_phase
task_policy:
  intents:
    activity:
      allowed_members: [reporter]
      allowed_roles: [publisher]
    landing_decision:
      allowed_members: [lead]
      allowed_roles: [lead]
steps:
  implement:
    worker: CUSTOM
    instructions: "implement task"
    capabilities: [READ]
`,
    );

    const task = makeTask();
    await registry.upsertEnvelope(task);
    const decision = router.route(task, 3000);
    const runner = new MockStepRunner(async () => ({ status: "SUCCEEDED" }));

    const dispatcher = new TaskDispatcher();
    const result = await dispatcher.dispatch({
      registry,
      task,
      decision,
      workspaceDir,
      stepRunner: runner,
      sourceEvent: { comment_id: 99, type: "issue_comment" },
    });

    expect(result.workflowState.status).toBe(WorkflowStatus.SUCCEEDED);
    expect(result.contextDir).toBe(
      path.join(registry.getRunDirectory(task.task_id, result.runId), "context"),
    );
    expect(runner.workspaceDirs).toEqual([workspaceDir]);
    expect(runner.stepEnvs[0]).toMatchObject({
      CI: "true",
      BASE_BRANCH: "origin/main",
      ROBOPPI_TASK_ID: task.task_id,
      ROBOPPI_TASK_SOURCE_KIND: "github_issue",
      ROBOPPI_TASK_EXTERNAL_ID: "owner/repo#123",
      ROBOPPI_TASK_URL: "https://example.invalid/owner/repo/issues/123",
      ROBOPPI_TASK_REQUESTED_ACTION: "implement",
      ROBOPPI_TASK_REPOSITORY: "owner/repo",
      ROBOPPI_TASK_REPOSITORY_DEFAULT_BRANCH: "main",
      ROBOPPI_TASK_REQUESTED_BY: "octocat",
      ROBOPPI_TASK_ISSUE_NUMBER: "123",
      ROBOPPI_TASK_TITLE: "Fix flaky scheduler restart test",
      ROBOPPI_TASK_ROUTE_ID: "bugfix",
      ROBOPPI_TASK_RUN_ID: result.runId,
      ROBOPPI_TASK_CONTEXT_DIR: result.contextDir,
      ROBOPPI_TASK_BRANCH_TEMPLATE: "roboppi/task/{{task.slug}}",
    });

    const taskJson = JSON.parse(
      await readFile(path.join(result.contextDir, "_task", "task.json"), "utf-8"),
    );
    const routingJson = JSON.parse(
      await readFile(path.join(result.contextDir, "_task", "routing.json"), "utf-8"),
    );
    const runJson = JSON.parse(
      await readFile(path.join(result.contextDir, "_task", "run.json"), "utf-8"),
    );
    const reportingJson = JSON.parse(
      await readFile(path.join(result.contextDir, "_task", "reporting.json"), "utf-8"),
    );
    const taskPolicyJson = JSON.parse(
      await readFile(path.join(result.contextDir, "_task", "task-policy.json"), "utf-8"),
    );
    const sourceEventJson = JSON.parse(
      await readFile(path.join(result.contextDir, "_task", "source-event.json"), "utf-8"),
    );
    expect(taskJson.task_id).toBe(task.task_id);
    expect(routingJson.route_id).toBe("bugfix");
    expect(runJson.run_id).toBe(result.runId);
    expect(reportingJson).toEqual({
      version: "1",
      default_publisher: "lead",
      members: {
        lead: {
          roles: ["lead", "publisher"],
        },
        reporter: {
          roles: ["publisher", "github_reporter"],
        },
      },
      sinks: {
        github: {
          enabled: true,
          publisher_member: "reporter",
          allowed_members: ["reporter"],
          allowed_roles: ["publisher"],
          events: ["progress", "ready_to_land"],
          projection: "status_comment",
          aggregate: "latest_per_phase",
        },
      },
    });
    expect(taskPolicyJson).toEqual({
      version: "1",
      members: {
        lead: {
          roles: ["lead", "publisher"],
        },
        reporter: {
          roles: ["publisher", "github_reporter"],
        },
      },
      intents: {
        activity: {
          allowed_members: ["reporter"],
          allowed_roles: ["publisher"],
        },
        landing_decision: {
          allowed_members: ["lead"],
          allowed_roles: ["lead"],
        },
      },
    });
    expect(sourceEventJson.comment_id).toBe(99);

    const state = await registry.getTaskState(task.task_id);
    expect(state).toMatchObject({
      lifecycle: "review_required",
      active_run_id: null,
      last_completed_run_id: result.runId,
      latest_run_id: result.runId,
      run_count: 1,
    });

    const runRecord = await registry.getRun(task.task_id, result.runId);
    expect(runRecord).toMatchObject({
      status: "completed",
      workflow: "workflows/task.yaml",
      workflow_id: result.workflowState.workflowId,
      workflow_status: "SUCCEEDED",
    });

    const summary = await registry.getRunSummary(task.task_id, result.runId);
    expect(summary).toMatchObject({
      final_lifecycle: "review_required",
      workflow_status: "SUCCEEDED",
    });
    expect(await registry.getWorkflowResult(task.task_id, result.runId)).toEqual(
      result.workflowState,
    );
  });

  it("records workflow failures as failed task runs without throwing", async () => {
    await writeFile(
      path.join(workspaceDir, "workflows", "task.yaml"),
      `
name: task-workflow
version: "1"
timeout: "5m"
steps:
  implement:
    worker: CUSTOM
    instructions: "implement task"
    capabilities: [READ]
`,
    );

    const task = makeTask();
    await registry.upsertEnvelope(task);
    const decision = router.route(task);
    const runner = new MockStepRunner(async () => ({
      status: "FAILED",
      errorClass: ErrorClass.NON_RETRYABLE,
    }));

    const dispatcher = new TaskDispatcher();
    const result = await dispatcher.dispatch({
      registry,
      task,
      decision,
      workspaceDir,
      stepRunner: runner,
    });

    expect(result.workflowState.status).toBe(WorkflowStatus.FAILED);

    const state = await registry.getTaskState(task.task_id);
    expect(state).toMatchObject({
      lifecycle: "failed",
      active_run_id: null,
    });

    const runRecord = await registry.getRun(task.task_id, result.runId);
    expect(runRecord).toMatchObject({
      status: "failed",
      workflow_status: "FAILED",
    });
  });

  it("derives BASE_BRANCH and PR metadata env for pull request tasks", async () => {
    await writeFile(
      path.join(workspaceDir, "workflows", "pr-review.yaml"),
      `
name: pr-review
version: "1"
timeout: "5m"
steps:
  review:
    worker: CUSTOM
    instructions: "review pull request"
    capabilities: [READ]
`,
    );

    const task = makePullRequestTask();
    await registry.upsertEnvelope(task);
    const decision = new TaskRouter(PR_CONFIG).route(task);
    const runner = new MockStepRunner(async () => ({ status: "SUCCEEDED" }));

    const dispatcher = new TaskDispatcher();
    await dispatcher.dispatch({
      registry,
      task,
      decision,
      workspaceDir,
      stepRunner: runner,
    });

    expect(runner.stepEnvs[0]).toMatchObject({
      CI: "true",
      BASE_BRANCH: "main",
      ROBOPPI_TASK_ID: task.task_id,
      ROBOPPI_TASK_SOURCE_KIND: "github_pull_request",
      ROBOPPI_TASK_EXTERNAL_ID: "owner/repo#45",
      ROBOPPI_TASK_URL: "https://example.invalid/owner/repo/pull/45",
      ROBOPPI_TASK_REQUESTED_ACTION: "review",
      ROBOPPI_TASK_REPOSITORY: "owner/repo",
      ROBOPPI_TASK_REPOSITORY_DEFAULT_BRANCH: "main",
      ROBOPPI_TASK_REQUESTED_BY: "octocat",
      ROBOPPI_TASK_PULL_REQUEST_NUMBER: "45",
      ROBOPPI_TASK_TITLE: "Review PR #45",
      ROBOPPI_TASK_BASE_REF: "main",
      ROBOPPI_TASK_HEAD_REF: "feature/fix-45",
      ROBOPPI_TASK_HEAD_SHA: "abc123def456",
      ROBOPPI_TASK_ROUTE_ID: "pr-review",
    });
  });

  it("applies a workflow-provided landing directive when landing.mode=manual", async () => {
    await writeFile(
      path.join(workspaceDir, "workflows", "task.yaml"),
      `
name: task-workflow
version: "1"
timeout: "5m"
steps:
  implement:
    worker: CUSTOM
    instructions: "implement task"
    capabilities: [READ]
`,
    );

    const task = makeTask();
    await registry.upsertEnvelope(task);
    const decision = router.route(task);
    const runner = new MockStepRunner(async (_stepId, env) => {
      await writeFile(
        path.join(env!.ROBOPPI_TASK_CONTEXT_DIR!, "_task", "landing.json"),
        JSON.stringify({
          version: "1",
          lifecycle: "ready_to_land",
          rationale: "PR created and waiting for maintainer merge",
          metadata: {
            pr_number: 42,
          },
        }),
      );
      return { status: "SUCCEEDED" };
    });

    const dispatcher = new TaskDispatcher();
    const result = await dispatcher.dispatch({
      registry,
      task,
      decision,
      workspaceDir,
      stepRunner: runner,
      landing: { mode: "manual" },
    });

    const state = await registry.getTaskState(task.task_id);
    expect(state?.lifecycle).toBe("ready_to_land");

    const landing = await registry.getLandingDecision(task.task_id, result.runId);
    expect(landing).toEqual({
      version: "1",
      lifecycle: "ready_to_land",
      rationale: "PR created and waiting for maintainer merge",
      metadata: {
        landing_file: path.join(result.contextDir, "_task", "landing.json"),
        pr_number: 42,
      },
      source: "workflow",
    });

    const summary = await registry.getRunSummary(task.task_id, result.runId);
    expect(summary).toMatchObject({
      final_lifecycle: "ready_to_land",
      metadata: {
        landing: {
          lifecycle: "ready_to_land",
          source: "workflow",
        },
      },
    });
  });

  it("ignores workflow landing directives when landing.mode=disabled", async () => {
    await writeFile(
      path.join(workspaceDir, "workflows", "task.yaml"),
      `
name: task-workflow
version: "1"
timeout: "5m"
steps:
  implement:
    worker: CUSTOM
    instructions: "implement task"
    capabilities: [READ]
`,
    );

    const task = makeTask();
    await registry.upsertEnvelope(task);
    const decision = router.route(task);
    const runner = new MockStepRunner(async (_stepId, env) => {
      await writeFile(
        path.join(env!.ROBOPPI_TASK_CONTEXT_DIR!, "_task", "landing.json"),
        JSON.stringify({
          version: "1",
          lifecycle: "ready_to_land",
        }),
      );
      return { status: "SUCCEEDED" };
    });

    const dispatcher = new TaskDispatcher();
    const result = await dispatcher.dispatch({
      registry,
      task,
      decision,
      workspaceDir,
      stepRunner: runner,
      landing: { mode: "disabled" },
    });

    const state = await registry.getTaskState(task.task_id);
    expect(state?.lifecycle).toBe("review_required");

    const landing = await registry.getLandingDecision(task.task_id, result.runId);
    expect(landing).toMatchObject({
      lifecycle: "review_required",
      source: "ignored",
      metadata: {
        landing_file: path.join(result.contextDir, "_task", "landing.json"),
        requested_lifecycle: "ready_to_land",
      },
    });
  });

  it("marks the run failed and throws on infrastructure errors", async () => {
    const task = makeTask();
    await registry.upsertEnvelope(task);
    const decision = router.route(task);
    const runner = new MockStepRunner(async () => ({ status: "SUCCEEDED" }));

    const dispatcher = new TaskDispatcher();
    await expect(
      dispatcher.dispatch({
        registry,
        task,
        decision,
        workspaceDir,
        stepRunner: runner,
      }),
    ).rejects.toBeInstanceOf(TaskDispatchError);

    const state = await registry.getTaskState(task.task_id);
    expect(state).toMatchObject({
      lifecycle: "failed",
      active_run_id: null,
      run_count: 1,
    });

    const runs = await registry.listRuns(task.task_id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("ENOENT"),
    });
  });
});
