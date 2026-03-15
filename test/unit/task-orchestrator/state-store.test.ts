import { beforeEach, afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  TaskRegistryConflictError,
  TaskRegistryStore,
  buildTaskSourceKey,
} from "../../../src/task-orchestrator/index.js";
import type {
  TaskEnvelope,
  TaskExecutionPlan,
  TaskRunSummary,
  TaskWaitingState,
} from "../../../src/task-orchestrator/index.js";

function makeEnvelope(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
  return {
    version: "1",
    task_id: "github:issue:owner/repo#123",
    source: {
      kind: "github_issue",
      system_id: "github",
      external_id: "owner/repo#123",
      url: "https://example.invalid/owner/repo/issues/123",
      revision: "rev-1",
    },
    title: "Fix flaky scheduler restart test",
    body: "normalized markdown body",
    labels: ["bug", "ci-flake"],
    priority: "normal",
    repository: {
      id: "owner/repo",
      default_branch: "main",
    },
    requested_action: "implement",
    requested_by: "octocat",
    metadata: {
      milestone: "v0.2",
    },
    timestamps: {
      created_at: 1000,
      updated_at: 2000,
    },
    ...overrides,
  };
}

function makePlan(overrides: Partial<TaskExecutionPlan> = {}): TaskExecutionPlan {
  return {
    workflow: "examples/agent-pr-loop.yaml",
    workspaceMode: "worktree",
    worktree: {
      baseRef: "origin/main",
      branchNameTemplate: "roboppi/task/{{task.slug}}",
    },
    env: {
      ROBOPPI_TASK_ID: "github:issue:owner/repo#123",
    },
    priorityClass: "normal",
    managementEnabled: true,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<TaskRunSummary> = {}): TaskRunSummary {
  return {
    version: "1",
    task_id: "github:issue:owner/repo#123",
    run_id: "run-1",
    generated_at: 5000,
    final_lifecycle: "review_required",
    workflow_status: "SUCCEEDED",
    rationale: "Implementation completed; waiting for human review.",
    ...overrides,
  };
}

function makeWaitingState(overrides: Partial<TaskWaitingState> = {}): TaskWaitingState {
  return {
    version: "1",
    task_id: "github:issue:owner/repo#123",
    status: "waiting",
    round_trip_count: 1,
    waiting_started_at: 4000,
    updated_at: 4000,
    last_source_revision: "rev-1",
    last_human_signal_at: 2000,
    reminder_due_at: 5800,
    reminder_sent_at: null,
    block_after_at: 7600,
    resumed_at: null,
    blocked_at: null,
    ...overrides,
  };
}

describe("TaskRegistryStore", () => {
  let stateDir: string;
  let store: TaskRegistryStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "roboppi-task-registry-"));
    store = new TaskRegistryStore(stateDir);
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("persists task envelopes, initializes queued state, and indexes by source", async () => {
    const envelope = makeEnvelope();
    await store.upsertEnvelope(envelope);

    expect(await store.getEnvelope(envelope.task_id)).toEqual(envelope);
    expect(await store.resolveTaskIdBySource(envelope.source)).toBe(envelope.task_id);

    const state = await store.getTaskState(envelope.task_id);
    expect(state).not.toBeNull();
    expect(state).toMatchObject({
      task_id: envelope.task_id,
      lifecycle: "queued",
      active_run_id: null,
      latest_run_id: null,
      last_completed_run_id: null,
      run_count: 0,
      source_revision: "rev-1",
      created_at: 1000,
      updated_at: 2000,
    });

    expect(buildTaskSourceKey(envelope.source)).toBe(
      "github:github_issue:owner/repo#123",
    );
  });

  it("creates runs, marks them active, and transitions them to running", async () => {
    const envelope = makeEnvelope();
    await store.upsertEnvelope(envelope);

    const run = await store.createRun(envelope.task_id, {
      runId: "run-1",
      workflow: "examples/agent-pr-loop.yaml",
      createdAt: 3000,
    });
    expect(run).toMatchObject({
      task_id: envelope.task_id,
      run_id: "run-1",
      attempt: 1,
      status: "preparing",
      workflow: "examples/agent-pr-loop.yaml",
      created_at: 3000,
    });

    expect(await store.listActiveTasks()).toEqual([
      {
        task_id: envelope.task_id,
        run_id: "run-1",
        lifecycle: "preparing",
        updated_at: 3000,
      },
    ]);

    const running = await store.markRunRunning(envelope.task_id, "run-1", {
      startedAt: 3500,
      workflowId: "wf-1",
    });
    expect(running).toMatchObject({
      run_id: "run-1",
      status: "running",
      started_at: 3500,
      workflow_id: "wf-1",
    });

    const state = await store.getTaskState(envelope.task_id);
    expect(state?.lifecycle).toBe("running");
    expect(state?.active_run_id).toBe("run-1");
  });

  it("rejects a second active run for the same task", async () => {
    const envelope = makeEnvelope();
    await store.upsertEnvelope(envelope);
    await store.createRun(envelope.task_id, { runId: "run-1" });

    await expect(
      store.createRun(envelope.task_id, { runId: "run-2" }),
    ).rejects.toBeInstanceOf(TaskRegistryConflictError);
  });

  it("persists run artifacts and clears the active index when a run finishes", async () => {
    const envelope = makeEnvelope();
    await store.upsertEnvelope(envelope);
    await store.createRun(envelope.task_id, { runId: "run-1", createdAt: 3000 });
    await store.markRunRunning(envelope.task_id, "run-1", { startedAt: 3500 });

    const plan = makePlan();
    const summary = makeSummary();
    const workflowResult = {
      workflowId: "wf-1",
      status: "SUCCEEDED",
    };

    await store.saveRunPlan(envelope.task_id, "run-1", plan);
    await store.saveRunSummary(envelope.task_id, "run-1", summary);
    await store.saveWorkflowResult(envelope.task_id, "run-1", workflowResult);

    expect(await store.getRunPlan(envelope.task_id, "run-1")).toEqual(plan);
    expect(await store.getRunSummary(envelope.task_id, "run-1")).toEqual(summary);
    expect(await store.getWorkflowResult(envelope.task_id, "run-1")).toEqual(workflowResult);

    const finished = await store.finishRun(envelope.task_id, "run-1", {
      status: "completed",
      lifecycle: "review_required",
      completedAt: 4000,
      workflowStatus: "SUCCEEDED",
    });
    expect(finished).toMatchObject({
      run_id: "run-1",
      status: "completed",
      workflow_status: "SUCCEEDED",
      completed_at: 4000,
      artifacts: {
        plan: "plan.json",
        summary: "summary.json",
        workflow_result: "workflow-result.json",
      },
    });

    const state = await store.getTaskState(envelope.task_id);
    expect(state).toMatchObject({
      lifecycle: "review_required",
      active_run_id: null,
      latest_run_id: "run-1",
      last_completed_run_id: "run-1",
      run_count: 1,
    });
    expect(await store.listActiveTasks()).toEqual([]);
  });

  it("lists runs newest first", async () => {
    const envelope = makeEnvelope();
    await store.upsertEnvelope(envelope);

    await store.createRun(envelope.task_id, { runId: "run-1", createdAt: 1000 });
    await store.finishRun(envelope.task_id, "run-1", {
      status: "completed",
      lifecycle: "review_required",
      completedAt: 1500,
    });

    await store.createRun(envelope.task_id, { runId: "run-2", createdAt: 2000 });
    await store.finishRun(envelope.task_id, "run-2", {
      status: "failed",
      lifecycle: "failed",
      completedAt: 2500,
      error: "tests failed",
    });

    const runs = await store.listRuns(envelope.task_id, 10);
    expect(runs.map((run) => run.run_id)).toEqual(["run-2", "run-1"]);
    expect(runs.map((run) => run.attempt)).toEqual([2, 1]);
  });

  it("lists task states newest first", async () => {
    const older = makeEnvelope({
      task_id: "github:issue:owner/repo#100",
      source: {
        kind: "github_issue",
        system_id: "github",
        external_id: "owner/repo#100",
      },
      timestamps: {
        created_at: 1000,
        updated_at: 1500,
      },
    });
    const newer = makeEnvelope({
      task_id: "github:issue:owner/repo#200",
      source: {
        kind: "github_issue",
        system_id: "github",
        external_id: "owner/repo#200",
      },
      timestamps: {
        created_at: 2000,
        updated_at: 2500,
      },
    });

    await store.upsertEnvelope(older);
    await store.upsertEnvelope(newer);

    const tasks = await store.listTaskStates();
    expect(tasks.map((task) => task.task_id)).toEqual([
      "github:issue:owner/repo#200",
      "github:issue:owner/repo#100",
    ]);
    expect(store.getStateDirectory()).toBe(stateDir);
  });

  it("persists waiting-state metadata separately from state.json", async () => {
    const envelope = makeEnvelope();
    await store.upsertEnvelope(envelope);

    const waitingState = makeWaitingState();
    await store.saveWaitingState(waitingState);

    expect(await store.getWaitingState(envelope.task_id)).toEqual(waitingState);
    expect((await store.getTaskState(envelope.task_id))?.lifecycle).toBe("queued");
  });
});
