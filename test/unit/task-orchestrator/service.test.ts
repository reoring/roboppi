import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileInboxSource,
  TaskOrchestratorService,
  TaskRegistryStore,
  parseTaskOrchestratorConfig,
} from "../../../src/task-orchestrator/index.js";
import type {
  TaskSource,
  TaskDispatchOptions,
  TaskDispatchResult,
} from "../../../src/task-orchestrator/index.js";
import type { BranchRuntimeContext } from "../../../src/workflow/branch-context.js";
import type { StepRunner, StepRunResult, CheckResult } from "../../../src/workflow/executor.js";
import type { StepDefinition, CompletionCheckDef, WorkflowState } from "../../../src/workflow/types.js";
import { WorkflowStatus } from "../../../src/workflow/types.js";

class NoopStepRunner implements StepRunner {
  async runStep(
    _stepId: string,
    _step: StepDefinition,
    _workspaceDir: string,
    _abortSignal: AbortSignal,
    _env?: Record<string, string>,
  ): Promise<StepRunResult> {
    return { status: "SUCCEEDED" };
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

class FakeDispatcher {
  readonly calls: TaskDispatchOptions[] = [];

  async dispatch(options: TaskDispatchOptions): Promise<TaskDispatchResult> {
    this.calls.push(options);
    return {
      taskId: options.task.task_id,
      runId: "run-1",
      workflowPath: path.resolve(options.workspaceDir, options.decision.plan.workflow),
      workspaceDir: options.workspaceDir,
      contextDir: path.join(options.workspaceDir, "context"),
      workflowState: makeWorkflowState(),
      branchContext: disabledBranchContext(),
    };
  }
}

class DeferredDispatcher {
  readonly calls: TaskDispatchOptions[] = [];
  private readonly waiters = new Map<string, () => void>();

  async dispatch(options: TaskDispatchOptions): Promise<TaskDispatchResult> {
    this.calls.push(options);
    await new Promise<void>((resolve) => {
      this.waiters.set(options.task.task_id, resolve);
    });
    return {
      taskId: options.task.task_id,
      runId: "run-detached",
      workflowPath: path.resolve(options.workspaceDir, options.decision.plan.workflow),
      workspaceDir: options.workspaceDir,
      contextDir: path.join(options.workspaceDir, "context"),
      workflowState: makeWorkflowState(),
      branchContext: disabledBranchContext(),
    };
  }

  resolveTask(taskId: string): void {
    const resolve = this.waiters.get(taskId);
    if (!resolve) {
      throw new Error(`No pending task for ${taskId}`);
    }
    this.waiters.delete(taskId);
    resolve();
  }
}

class LifecycleSettingDispatcher extends FakeDispatcher {
  constructor(
    private readonly lifecycle: "waiting_for_input" | "review_required" | "blocked",
    private readonly updatedAt: number = 5000,
  ) {
    super();
  }

  override async dispatch(options: TaskDispatchOptions): Promise<TaskDispatchResult> {
    const result = await super.dispatch(options);
    const currentState = await options.registry.getTaskState(options.task.task_id);
    if (!currentState) {
      throw new Error(`Missing task state for ${options.task.task_id}`);
    }
    await options.registry.saveTaskState({
      ...currentState,
      lifecycle: this.lifecycle,
      updated_at: this.updatedAt,
      last_transition_at: this.updatedAt,
    });
    return result;
  }
}

function makeWorkflowState(): WorkflowState {
  return {
    workflowId: "wf-1",
    name: "task-workflow",
    status: WorkflowStatus.SUCCEEDED,
    steps: {},
    startedAt: 1000,
    completedAt: 2000,
  };
}

function disabledBranchContext(): BranchRuntimeContext {
  return {
    enabled: false,
    createBranch: false,
    protectedBranches: ["main", "master", "release/*"],
    protectedBranchesSource: "default",
    allowProtectedBranch: false,
    warnings: [],
  };
}

describe("TaskOrchestratorService", () => {
  let baseDir: string;
  let inboxDir: string;
  let repoDir: string;
  let registry: TaskRegistryStore;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "roboppi-task-service-"));
    inboxDir = path.join(baseDir, "inbox");
    repoDir = path.join(baseDir, "repo");
    await mkdir(inboxDir, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    registry = new TaskRegistryStore(path.join(baseDir, ".roboppi-task"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("polls a file inbox source and dispatches matched tasks", async () => {
    await writeFile(
      path.join(inboxDir, "task.json"),
      JSON.stringify({
        title: "Implement bug fix",
        labels: ["bug"],
        repository: {
          id: "owner/repo",
          local_path: "../repo",
        },
      }),
    );

    const config = parseTaskOrchestratorConfig(`
name: backlog
version: "1"
state_dir: ./.roboppi-task
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  bugfix:
    when:
      source: file_inbox
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
landing:
  mode: manual
`);
    const dispatcher = new FakeDispatcher();
    const service = new TaskOrchestratorService(config, {
      baseDir,
      registry,
      sources: [
        {
          id: "inbox",
          config: config.sources["inbox"]!,
          source: new FileInboxSource("inbox", config.sources["inbox"] as any, baseDir),
        },
      ],
      dispatcher,
      stepRunner: new NoopStepRunner(),
    });

    const result = await service.runOnce();

    expect(result.totals).toEqual({
      candidates: 1,
      dispatched: 1,
      skipped_active: 0,
      skipped_unchanged: 0,
      unmatched: 0,
      failed: 0,
      acked: 1,
      ack_failed: 0,
    });
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]?.workspaceDir).toBe(repoDir);
    expect(dispatcher.calls[0]?.task.task_id).toBe("file_inbox:inbox:task.json");
    expect(dispatcher.calls[0]?.decision.route_id).toBe("bugfix");

    const envelope = await registry.getEnvelope("file_inbox:inbox:task.json");
    expect(envelope?.title).toBe("Implement bug fix");
  });

  it("updates the envelope but skips dispatch when the task already has an active run", async () => {
    await writeFile(
      path.join(inboxDir, "task.json"),
      JSON.stringify({
        title: "Updated title",
        labels: ["bug"],
      }),
    );

    const config = parseTaskOrchestratorConfig(`
name: backlog
version: "1"
state_dir: ./.roboppi-task
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  bugfix:
    when:
      source: file_inbox
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
`);
    const source = new FileInboxSource("inbox", config.sources["inbox"] as any, baseDir);
    const [ref] = await source.listCandidates();
    const envelope = await source.fetchEnvelope(ref!);
    await registry.upsertEnvelope({
      ...envelope,
      title: "Old title",
    });
    await registry.createRun(envelope.task_id, {
      runId: "run-active",
      workflow: "workflows/task.yaml",
    });

    const dispatcher = new FakeDispatcher();
    const service = new TaskOrchestratorService(config, {
      baseDir,
      registry,
      sources: [{ id: "inbox", config: config.sources["inbox"]!, source }],
      dispatcher,
      stepRunner: new NoopStepRunner(),
    });

    const result = await service.runOnce();

    expect(result.totals).toEqual({
      candidates: 1,
      dispatched: 0,
      skipped_active: 1,
      skipped_unchanged: 0,
      unmatched: 0,
      failed: 0,
      acked: 0,
      ack_failed: 0,
    });
    expect(dispatcher.calls).toHaveLength(0);
    expect((await registry.getEnvelope(envelope.task_id))?.title).toBe("Updated title");
  });

  it("counts unmatched tasks when no route applies", async () => {
    await writeFile(
      path.join(inboxDir, "task.json"),
      JSON.stringify({
        title: "Docs task",
        labels: ["docs"],
      }),
    );

    const config = parseTaskOrchestratorConfig(`
name: backlog
version: "1"
state_dir: ./.roboppi-task
sources:
  inbox:
    type: file_inbox
    path: ./inbox
routes:
  bugfix:
    when:
      source: file_inbox
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
`);
    const dispatcher = new FakeDispatcher();
    const service = new TaskOrchestratorService(config, {
      baseDir,
      registry,
      sources: [
        {
          id: "inbox",
          config: config.sources["inbox"]!,
          source: new FileInboxSource("inbox", config.sources["inbox"] as any, baseDir),
        },
      ],
      dispatcher,
      stepRunner: new NoopStepRunner(),
    });

    const result = await service.runOnce();

    expect(result.totals).toEqual({
      candidates: 1,
      dispatched: 0,
      skipped_active: 0,
      skipped_unchanged: 0,
      unmatched: 1,
      failed: 0,
      acked: 0,
      ack_failed: 0,
    });
    expect(dispatcher.calls).toHaveLength(0);
    expect(result.sources[0]?.errors[0]).toMatchObject({
      stage: "route",
      ref: "task.json",
      taskId: "file_inbox:inbox:task.json",
    });
  });

  it("records ack failures without turning a successful dispatch into a failed run", async () => {
    const source: TaskSource = {
      async listCandidates() {
        return [{ source_id: "custom", external_id: "task-1" }];
      },
      async fetchEnvelope() {
        return {
          version: "1",
          task_id: "custom:task-1",
          source: {
            kind: "file_inbox",
            system_id: "file_inbox",
            external_id: "task-1",
          },
          title: "Ack failure demo",
          body: "",
          labels: ["bug"],
          priority: "normal",
          requested_action: "implement",
          timestamps: {
            created_at: 1000,
            updated_at: 1000,
          },
        };
      },
      async ack() {
        throw new Error("ack backend unavailable");
      },
    };

    const config = parseTaskOrchestratorConfig(`
name: backlog
version: "1"
state_dir: ./.roboppi-task
sources:
  custom:
    type: file_inbox
    path: ./inbox
routes:
  bugfix:
    when:
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
`);
    const dispatcher = new FakeDispatcher();
    const service = new TaskOrchestratorService(config, {
      baseDir,
      registry,
      sources: [{ id: "custom", config: config.sources["custom"]!, source }],
      dispatcher,
      stepRunner: new NoopStepRunner(),
    });

    const result = await service.runOnce();

    expect(result.totals).toEqual({
      candidates: 1,
      dispatched: 1,
      skipped_active: 0,
      skipped_unchanged: 0,
      unmatched: 0,
      failed: 0,
      acked: 0,
      ack_failed: 1,
    });
    expect(result.sources[0]?.errors).toEqual([
      {
        sourceId: "custom",
        stage: "ack",
        ref: "task-1",
        taskId: "custom:task-1",
        message: "ack backend unavailable",
      },
    ]);
  });

  it("can detach dispatches so a second polling cycle does not start the same task twice", async () => {
    const acks: Array<{ task_id: string; run_id?: string; state?: string }> = [];
    const source: TaskSource = {
      async listCandidates() {
        return [{ source_id: "custom", external_id: "task-1" }];
      },
      async fetchEnvelope() {
        return {
          version: "1",
          task_id: "custom:task-1",
          source: {
            kind: "github_issue",
            system_id: "github",
            external_id: "owner/repo#1",
          },
          title: "Detached dispatch demo",
          body: "",
          labels: ["bug"],
          priority: "normal",
          requested_action: "implement",
          timestamps: {
            created_at: 1000,
            updated_at: 1000,
          },
        };
      },
      async ack(update) {
        acks.push(update);
      },
    };

    const config = parseTaskOrchestratorConfig(`
name: backlog
version: "1"
sources:
  custom:
    type: github_issue
    repo: owner/repo
routes:
  bugfix:
    when:
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
`);
    const dispatcher = new DeferredDispatcher();
    const service = new TaskOrchestratorService(config, {
      baseDir,
      registry,
      sources: [{ id: "custom", config: config.sources["custom"]!, source }],
      dispatcher,
      stepRunner: new NoopStepRunner(),
    });

    const first = await service.runOnce({ detachDispatch: true });
    const second = await service.runOnce({ detachDispatch: true });

    expect(first.totals.dispatched).toBe(1);
    expect(second.totals).toEqual({
      candidates: 1,
      dispatched: 0,
      skipped_active: 1,
      skipped_unchanged: 0,
      unmatched: 0,
      failed: 0,
      acked: 0,
      ack_failed: 0,
    });
    expect(dispatcher.calls).toHaveLength(1);

    dispatcher.resolveTask("custom:task-1");
    await service.waitForBackgroundDispatches();

    expect(acks).toEqual([
      {
        task_id: "custom:task-1",
        run_id: "run-detached",
        state: "queued",
      },
    ]);
  });

  it("skips unchanged tasks that already completed for the same source revision", async () => {
    const source: TaskSource = {
      async listCandidates() {
        return [{ source_id: "custom", external_id: "owner/repo#1", revision: "rev-1" }];
      },
      async fetchEnvelope() {
        return {
          version: "1",
          task_id: "github:issue:owner/repo#1",
          source: {
            kind: "github_issue",
            system_id: "github",
            external_id: "owner/repo#1",
            revision: "rev-1",
          },
          title: "Unchanged issue",
          body: "",
          labels: ["bug"],
          priority: "normal",
          requested_action: "implement",
          timestamps: {
            created_at: 1000,
            updated_at: 1000,
          },
        };
      },
    };

    const config = parseTaskOrchestratorConfig(`
name: backlog
version: "1"
sources:
  custom:
    type: github_issue
    repo: owner/repo
routes:
  bugfix:
    when:
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
`);
    const dispatcher = new FakeDispatcher();
    const service = new TaskOrchestratorService(config, {
      baseDir,
      registry,
      sources: [{ id: "custom", config: config.sources["custom"]!, source }],
      dispatcher,
      stepRunner: new NoopStepRunner(),
    });

    await registry.upsertEnvelope(await source.fetchEnvelope({ source_id: "custom", external_id: "owner/repo#1", revision: "rev-1" }));
    await registry.createRun("github:issue:owner/repo#1", {
      runId: "run-1",
      workflow: "workflows/task.yaml",
      sourceRevision: "rev-1",
    });
    await registry.finishRun("github:issue:owner/repo#1", "run-1", {
      status: "completed",
      lifecycle: "ready_to_land",
    });

    const result = await service.runOnce();

    expect(result.totals).toEqual({
      candidates: 1,
      dispatched: 0,
      skipped_active: 0,
      skipped_unchanged: 1,
      unmatched: 0,
      failed: 0,
      acked: 0,
      ack_failed: 0,
    });
    expect(dispatcher.calls).toHaveLength(0);
  });

  it("does not skip unchanged tasks when the previous run failed", async () => {
    const source: TaskSource = {
      async listCandidates() {
        return [{ source_id: "custom", external_id: "owner/repo#2", revision: "rev-1" }];
      },
      async fetchEnvelope() {
        return {
          version: "1",
          task_id: "github:issue:owner/repo#2",
          source: {
            kind: "github_issue",
            system_id: "github",
            external_id: "owner/repo#2",
            revision: "rev-1",
          },
          title: "Retry after fix",
          body: "",
          labels: ["bug"],
          priority: "normal",
          requested_action: "implement",
          timestamps: {
            created_at: 1000,
            updated_at: 1000,
          },
        };
      },
    };

    const config = parseTaskOrchestratorConfig(`
name: backlog
version: "1"
sources:
  custom:
    type: github_issue
    repo: owner/repo
routes:
  bugfix:
    when:
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
`);
    const dispatcher = new FakeDispatcher();
    const service = new TaskOrchestratorService(config, {
      baseDir,
      registry,
      sources: [{ id: "custom", config: config.sources["custom"]!, source }],
      dispatcher,
      stepRunner: new NoopStepRunner(),
    });

    await registry.upsertEnvelope(await source.fetchEnvelope({ source_id: "custom", external_id: "owner/repo#2", revision: "rev-1" }));
    await registry.createRun("github:issue:owner/repo#2", {
      runId: "run-failed",
      workflow: "workflows/task.yaml",
      sourceRevision: "rev-1",
    });
    await registry.finishRun("github:issue:owner/repo#2", "run-failed", {
      status: "failed",
      lifecycle: "failed",
    });

    const result = await service.runOnce();

    expect(result.totals.dispatched).toBe(1);
    expect(result.totals.skipped_unchanged).toBe(0);
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("skips waiting_for_input tasks until the source revision changes", async () => {
    let revision = "rev-wait-1";
    const source: TaskSource = {
      async listCandidates() {
        return [{ source_id: "custom", external_id: "owner/repo#3", revision }];
      },
      async fetchEnvelope() {
        return {
          version: "1",
          task_id: "github:issue:owner/repo#3",
          source: {
            kind: "github_issue",
            system_id: "github",
            external_id: "owner/repo#3",
            revision,
          },
          title: "Need clarification",
          body: "",
          labels: ["bug"],
          priority: "normal",
          requested_action: "implement",
          timestamps: {
            created_at: 1000,
            updated_at: 1000,
          },
        };
      },
    };

    const config = parseTaskOrchestratorConfig(`
name: backlog
version: "1"
sources:
  custom:
    type: github_issue
    repo: owner/repo
routes:
  bugfix:
    when:
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
`);
    const dispatcher = new FakeDispatcher();
    const service = new TaskOrchestratorService(config, {
      baseDir,
      registry,
      sources: [{ id: "custom", config: config.sources["custom"]!, source }],
      dispatcher,
      stepRunner: new NoopStepRunner(),
    });

    await registry.upsertEnvelope(await source.fetchEnvelope({
      source_id: "custom",
      external_id: "owner/repo#3",
      revision,
    }));
    await registry.createRun("github:issue:owner/repo#3", {
      runId: "run-waiting",
      workflow: "workflows/task.yaml",
      sourceRevision: revision,
    });
    await registry.finishRun("github:issue:owner/repo#3", "run-waiting", {
      status: "completed",
      lifecycle: "waiting_for_input",
    });

    const skipped = await service.runOnce();
    expect(skipped.totals.skipped_unchanged).toBe(1);
    expect(skipped.totals.dispatched).toBe(0);

    revision = "rev-wait-2";
    const resumed = await service.runOnce();
    expect(resumed.totals.skipped_unchanged).toBe(0);
    expect(resumed.totals.dispatched).toBe(1);
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("records waiting-state metadata when a dispatch ends in waiting_for_input", async () => {
    const source: TaskSource = {
      async listCandidates() {
        return [{ source_id: "custom", external_id: "owner/repo#4", revision: "rev-clarify-1" }];
      },
      async fetchEnvelope() {
        return {
          version: "1",
          task_id: "github:issue:owner/repo#4",
          source: {
            kind: "github_issue",
            system_id: "github",
            external_id: "owner/repo#4",
            revision: "rev-clarify-1",
          },
          title: "Need more details",
          body: "",
          labels: ["bug"],
          priority: "normal",
          requested_action: "implement",
          timestamps: {
            created_at: 1000,
            updated_at: 1200,
          },
          metadata: {
            last_human_comment_at: 1150,
          },
        };
      },
    };

    const config = parseTaskOrchestratorConfig(`
name: backlog
version: "1"
clarification:
  reminder_after: 10m
  block_after: 1h
sources:
  custom:
    type: github_issue
    repo: owner/repo
routes:
  bugfix:
    when:
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
`);
    const dispatcher = new LifecycleSettingDispatcher("waiting_for_input");
    const service = new TaskOrchestratorService(config, {
      baseDir,
      registry,
      sources: [{ id: "custom", config: config.sources["custom"]!, source }],
      dispatcher,
      stepRunner: new NoopStepRunner(),
    });

    const result = await service.runOnce();

    expect(result.totals.dispatched).toBe(1);
    const waitingState = await registry.getWaitingState("github:issue:owner/repo#4");
    expect(waitingState).not.toBeNull();
    expect(waitingState).toMatchObject({
      task_id: "github:issue:owner/repo#4",
      status: "waiting",
      round_trip_count: 1,
      last_source_revision: "rev-clarify-1",
      last_human_signal_at: 1150,
    });
    expect(waitingState?.reminder_due_at).toBeGreaterThan(waitingState!.waiting_started_at);
    expect(waitingState?.block_after_at).toBeGreaterThan(waitingState!.waiting_started_at);
  });

  it("blocks clarification loops after max_round_trips is exceeded", async () => {
    let revision = "rev-loop-2";
    const source: TaskSource = {
      async listCandidates() {
        return [{ source_id: "custom", external_id: "owner/repo#5", revision }];
      },
      async fetchEnvelope() {
        return {
          version: "1",
          task_id: "github:issue:owner/repo#5",
          source: {
            kind: "github_issue",
            system_id: "github",
            external_id: "owner/repo#5",
            revision,
          },
          title: "Still underspecified",
          body: "",
          labels: ["bug"],
          priority: "normal",
          requested_action: "implement",
          timestamps: {
            created_at: 1000,
            updated_at: 2000,
          },
        };
      },
    };

    const config = parseTaskOrchestratorConfig(`
name: backlog
version: "1"
clarification:
  max_round_trips: 2
sources:
  custom:
    type: github_issue
    repo: owner/repo
routes:
  bugfix:
    when:
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
`);
    const dispatcher = new LifecycleSettingDispatcher("waiting_for_input");
    const service = new TaskOrchestratorService(config, {
      baseDir,
      registry,
      sources: [{ id: "custom", config: config.sources["custom"]!, source }],
      dispatcher,
      stepRunner: new NoopStepRunner(),
    });

    await registry.upsertEnvelope(await source.fetchEnvelope({
      source_id: "custom",
      external_id: "owner/repo#5",
      revision: "rev-loop-1",
    }));
    await registry.saveTaskState({
      ...(await registry.getTaskState("github:issue:owner/repo#5"))!,
      lifecycle: "waiting_for_input",
      run_count: 1,
      source_revision: "rev-loop-1",
      updated_at: 1500,
      last_transition_at: 1500,
    });
    await registry.saveWaitingState({
      version: "1",
      task_id: "github:issue:owner/repo#5",
      status: "waiting",
      round_trip_count: 2,
      waiting_started_at: 1500,
      updated_at: 1500,
      last_source_revision: "rev-loop-1",
      last_human_signal_at: 1500,
      reminder_due_at: null,
      reminder_sent_at: null,
      block_after_at: null,
      resumed_at: null,
      blocked_at: null,
    });

    const result = await service.runOnce();

    expect(result.totals.dispatched).toBe(1);
    expect((await registry.getTaskState("github:issue:owner/repo#5"))?.lifecycle).toBe("blocked");
    expect(await registry.getWaitingState("github:issue:owner/repo#5")).toMatchObject({
      status: "blocked",
      round_trip_count: 3,
      last_source_revision: "rev-loop-2",
    });
  });

  it("blocks timed-out waiting tasks before evaluating unchanged candidates", async () => {
    const source: TaskSource = {
      async listCandidates() {
        return [{ source_id: "custom", external_id: "owner/repo#6", revision: "rev-timeout-1" }];
      },
      async fetchEnvelope() {
        return {
          version: "1",
          task_id: "github:issue:owner/repo#6",
          source: {
            kind: "github_issue",
            system_id: "github",
            external_id: "owner/repo#6",
            revision: "rev-timeout-1",
          },
          title: "Waiting too long",
          body: "",
          labels: ["bug"],
          priority: "normal",
          requested_action: "implement",
          timestamps: {
            created_at: 1000,
            updated_at: 1000,
          },
        };
      },
    };

    const config = parseTaskOrchestratorConfig(`
name: backlog
version: "1"
clarification:
  block_after: 1h
sources:
  custom:
    type: github_issue
    repo: owner/repo
routes:
  bugfix:
    when:
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
`);
    const dispatcher = new FakeDispatcher();
    const service = new TaskOrchestratorService(config, {
      baseDir,
      registry,
      sources: [{ id: "custom", config: config.sources["custom"]!, source }],
      dispatcher,
      stepRunner: new NoopStepRunner(),
    });

    await registry.upsertEnvelope(await source.fetchEnvelope({
      source_id: "custom",
      external_id: "owner/repo#6",
      revision: "rev-timeout-1",
    }));
    await registry.saveTaskState({
      ...(await registry.getTaskState("github:issue:owner/repo#6"))!,
      lifecycle: "waiting_for_input",
      run_count: 1,
      source_revision: "rev-timeout-1",
      updated_at: 1000,
      last_transition_at: 1000,
    });
    await registry.saveWaitingState({
      version: "1",
      task_id: "github:issue:owner/repo#6",
      status: "waiting",
      round_trip_count: 1,
      waiting_started_at: 1000,
      updated_at: 1000,
      last_source_revision: "rev-timeout-1",
      last_human_signal_at: 1000,
      reminder_due_at: null,
      reminder_sent_at: null,
      block_after_at: Date.now() - 1000,
      resumed_at: null,
      blocked_at: null,
    });

    const result = await service.runOnce();

    expect(result.totals.dispatched).toBe(0);
    expect(result.totals.skipped_unchanged).toBe(1);
    expect(dispatcher.calls).toHaveLength(0);
    expect((await registry.getTaskState("github:issue:owner/repo#6"))?.lifecycle).toBe("blocked");
    expect(await registry.getWaitingState("github:issue:owner/repo#6")).toMatchObject({
      status: "blocked",
    });
  });

  it("marks due waiting tasks as reminded without redispatching them", async () => {
    const source: TaskSource = {
      async listCandidates() {
        return [{ source_id: "custom", external_id: "owner/repo#7", revision: "rev-remind-1" }];
      },
      async fetchEnvelope() {
        return {
          version: "1",
          task_id: "github:issue:owner/repo#7",
          source: {
            kind: "github_issue",
            system_id: "github",
            external_id: "owner/repo#7",
            revision: "rev-remind-1",
          },
          title: "Still waiting on details",
          body: "",
          labels: ["bug"],
          priority: "normal",
          requested_action: "implement",
          timestamps: {
            created_at: 1000,
            updated_at: 1000,
          },
        };
      },
    };

    const config = parseTaskOrchestratorConfig(`
name: backlog
version: "1"
clarification:
  reminder_after: 30m
sources:
  custom:
    type: github_issue
    repo: owner/repo
routes:
  bugfix:
    when:
      labels_any: [bug]
    workflow: workflows/task.yaml
    workspace_mode: shared
`);
    const dispatcher = new FakeDispatcher();
    const service = new TaskOrchestratorService(config, {
      baseDir,
      registry,
      sources: [{ id: "custom", config: config.sources["custom"]!, source }],
      dispatcher,
      stepRunner: new NoopStepRunner(),
    });

    await registry.upsertEnvelope(await source.fetchEnvelope({
      source_id: "custom",
      external_id: "owner/repo#7",
      revision: "rev-remind-1",
    }));
    await registry.saveTaskState({
      ...(await registry.getTaskState("github:issue:owner/repo#7"))!,
      lifecycle: "waiting_for_input",
      run_count: 1,
      source_revision: "rev-remind-1",
      updated_at: 1000,
      last_transition_at: 1000,
    });
    await registry.saveWaitingState({
      version: "1",
      task_id: "github:issue:owner/repo#7",
      status: "waiting",
      round_trip_count: 1,
      waiting_started_at: 1000,
      updated_at: 1000,
      last_source_revision: "rev-remind-1",
      last_human_signal_at: 1000,
      reminder_due_at: Date.now() - 1000,
      reminder_sent_at: null,
      block_after_at: null,
      resumed_at: null,
      blocked_at: null,
    });

    const result = await service.runOnce();

    expect(result.totals.dispatched).toBe(0);
    expect(result.totals.skipped_unchanged).toBe(1);
    expect(dispatcher.calls).toHaveLength(0);
    expect(await registry.getWaitingState("github:issue:owner/repo#7")).toMatchObject({
      status: "waiting",
    });
    expect((await registry.getWaitingState("github:issue:owner/repo#7"))?.reminder_sent_at).not.toBeNull();
  });
});
