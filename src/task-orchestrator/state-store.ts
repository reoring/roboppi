import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { generateId } from "../types/index.js";
import type {
  ActiveTaskEntry,
  TaskEnvelope,
  TaskGitHubStatusBridgeState,
  TaskLandingDecision,
  TaskExecutionPlan,
  TaskId,
  TaskLifecycleState,
  TaskRecordState,
  TaskRunId,
  TaskRunRecord,
  TaskRunStatus,
  TaskRunSummary,
  TaskSourceRef,
  TaskWaitingState,
} from "./types.js";
import { buildTaskSourceKey, isTerminalTaskRunStatus } from "./types.js";

export interface CreateTaskRunOptions {
  runId?: TaskRunId;
  workflow?: string;
  sourceRevision?: string | null;
  createdAt?: number;
}

export interface MarkTaskRunRunningOptions {
  startedAt?: number;
  workflowId?: string | null;
}

export interface FinishTaskRunOptions {
  status: Extract<TaskRunStatus, "completed" | "failed" | "cancelled">;
  lifecycle: TaskLifecycleState;
  completedAt?: number;
  workflowId?: string | null;
  workflowStatus?: string | null;
  error?: string | null;
}

interface SourceIndexEntry {
  source_key: string;
  task_id: TaskId;
  updated_at: number;
}

export class TaskRegistryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRegistryConflictError";
  }
}

export class TaskRegistryStore {
  private readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  async upsertEnvelope(envelope: TaskEnvelope): Promise<void> {
    await this.writeJson(this.envelopePath(envelope.task_id), envelope);
    await this.writeJson(this.sourceIndexPath(envelope.source), {
      source_key: buildTaskSourceKey(envelope.source),
      task_id: envelope.task_id,
      updated_at: envelope.timestamps.updated_at,
    } satisfies SourceIndexEntry);

    const existing = await this.getTaskState(envelope.task_id);
    if (existing) {
      await this.saveTaskState({
        ...existing,
        updated_at: envelope.timestamps.updated_at,
        source_revision: envelope.source.revision ?? existing.source_revision,
      });
      return;
    }

    await this.saveTaskState(defaultTaskRecordState(envelope));
  }

  async getEnvelope(taskId: TaskId): Promise<TaskEnvelope | null> {
    return this.readJson<TaskEnvelope>(this.envelopePath(taskId));
  }

  async resolveTaskIdBySource(source: TaskSourceRef): Promise<TaskId | null> {
    const entry = await this.readJson<SourceIndexEntry>(this.sourceIndexPath(source));
    return entry?.task_id ?? null;
  }

  async getTaskState(taskId: TaskId): Promise<TaskRecordState | null> {
    return this.readJson<TaskRecordState>(this.taskStatePath(taskId));
  }

  async saveTaskState(state: TaskRecordState): Promise<void> {
    await this.writeJson(this.taskStatePath(state.task_id), state);
    await this.syncActiveIndex(state);
  }

  async getWaitingState(taskId: TaskId): Promise<TaskWaitingState | null> {
    return this.readJson<TaskWaitingState>(this.waitingStatePath(taskId));
  }

  async saveWaitingState(state: TaskWaitingState): Promise<void> {
    await this.writeJson(this.waitingStatePath(state.task_id), state);
  }

  async listActiveTasks(): Promise<ActiveTaskEntry[]> {
    const active = await this.readJson<ActiveTaskEntry[]>(this.activeIndexPath());
    return active ?? [];
  }

  async listTaskStates(limit: number = Number.POSITIVE_INFINITY): Promise<TaskRecordState[]> {
    const tasksDir = path.join(this.stateDir, "tasks");
    let entries;
    try {
      entries = await readdir(tasksDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const states: TaskRecordState[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const state = await this.readJson<TaskRecordState>(
        path.join(tasksDir, entry.name, "state.json"),
      );
      if (state) states.push(state);
    }

    return states
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, Number.isFinite(limit) ? limit : undefined);
  }

  async createRun(
    taskId: TaskId,
    options: CreateTaskRunOptions = {},
  ): Promise<TaskRunRecord> {
    const state = await this.requireTaskState(taskId);
    if (state.active_run_id) {
      throw new TaskRegistryConflictError(
        `Task "${taskId}" already has active run "${state.active_run_id}"`,
      );
    }

    const now = options.createdAt ?? Date.now();
    const runId = options.runId ?? generateId();
    const run: TaskRunRecord = {
      version: "1",
      task_id: taskId,
      run_id: runId,
      attempt: state.run_count + 1,
      status: "preparing",
      workflow: options.workflow,
      workflow_id: null,
      workflow_status: null,
      error: null,
      source_revision: options.sourceRevision ?? state.source_revision,
      artifacts: {},
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
    };

    await this.writeJson(this.runRecordPath(taskId, runId), run);
    await this.saveTaskState({
      ...state,
      lifecycle: "preparing",
      active_run_id: runId,
      latest_run_id: runId,
      run_count: run.attempt,
      updated_at: now,
      last_transition_at: now,
      source_revision: run.source_revision,
    });

    return run;
  }

  async markRunRunning(
    taskId: TaskId,
    runId: TaskRunId,
    options: MarkTaskRunRunningOptions = {},
  ): Promise<TaskRunRecord> {
    const state = await this.requireTaskState(taskId);
    if (state.active_run_id !== runId) {
      throw new TaskRegistryConflictError(
        `Task "${taskId}" does not have active run "${runId}"`,
      );
    }

    const run = await this.requireRun(taskId, runId);
    const now = options.startedAt ?? Date.now();
    const nextRun: TaskRunRecord = {
      ...run,
      status: "running",
      workflow_id: options.workflowId ?? run.workflow_id,
      started_at: run.started_at ?? now,
      updated_at: now,
    };
    await this.writeJson(this.runRecordPath(taskId, runId), nextRun);
    await this.saveTaskState({
      ...state,
      lifecycle: "running",
      updated_at: now,
      last_transition_at: now,
    });
    return nextRun;
  }

  async finishRun(
    taskId: TaskId,
    runId: TaskRunId,
    options: FinishTaskRunOptions,
  ): Promise<TaskRunRecord> {
    const state = await this.requireTaskState(taskId);
    if (state.active_run_id !== runId) {
      throw new TaskRegistryConflictError(
        `Task "${taskId}" does not have active run "${runId}"`,
      );
    }

    const run = await this.requireRun(taskId, runId);
    if (isTerminalTaskRunStatus(run.status)) {
      throw new TaskRegistryConflictError(
        `Run "${runId}" for task "${taskId}" is already terminal`,
      );
    }

    const now = options.completedAt ?? Date.now();
    const nextRun: TaskRunRecord = {
      ...run,
      status: options.status,
      workflow_id: options.workflowId ?? run.workflow_id,
      workflow_status: options.workflowStatus ?? run.workflow_status,
      error: options.error ?? run.error,
      started_at: run.started_at ?? run.created_at,
      completed_at: now,
      updated_at: now,
    };
    await this.writeJson(this.runRecordPath(taskId, runId), nextRun);
    await this.saveTaskState({
      ...state,
      lifecycle: options.lifecycle,
      active_run_id: null,
      latest_run_id: runId,
      last_completed_run_id: runId,
      updated_at: now,
      last_transition_at: now,
    });
    return nextRun;
  }

  async getRun(taskId: TaskId, runId: TaskRunId): Promise<TaskRunRecord | null> {
    return this.readJson<TaskRunRecord>(this.runRecordPath(taskId, runId));
  }

  async listRuns(taskId: TaskId, limit: number): Promise<TaskRunRecord[]> {
    const runsDir = this.runsDir(taskId);
    let files: string[];
    try {
      files = await readdir(runsDir);
    } catch {
      return [];
    }

    const records: TaskRunRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      if (file === "plan.json" || file === "summary.json") continue;
      const runId = decodeURIComponent(file.replace(/\.json$/, ""));
      const run = await this.getRun(taskId, runId);
      if (run) records.push(run);
    }

    return records
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, limit);
  }

  async saveRunPlan(
    taskId: TaskId,
    runId: TaskRunId,
    plan: TaskExecutionPlan,
  ): Promise<void> {
    await this.requireRun(taskId, runId);
    await this.writeJson(this.runPlanPath(taskId, runId), plan);
    await this.updateRunArtifacts(taskId, runId, { plan: "plan.json" });
  }

  async getRunPlan(
    taskId: TaskId,
    runId: TaskRunId,
  ): Promise<TaskExecutionPlan | null> {
    return this.readJson<TaskExecutionPlan>(this.runPlanPath(taskId, runId));
  }

  async saveRunSummary(
    taskId: TaskId,
    runId: TaskRunId,
    summary: TaskRunSummary,
  ): Promise<void> {
    await this.requireRun(taskId, runId);
    await this.writeJson(this.runSummaryPath(taskId, runId), summary);
    await this.updateRunArtifacts(taskId, runId, { summary: "summary.json" });
  }

  async getRunSummary(
    taskId: TaskId,
    runId: TaskRunId,
  ): Promise<TaskRunSummary | null> {
    return this.readJson<TaskRunSummary>(this.runSummaryPath(taskId, runId));
  }

  async saveWorkflowResult(
    taskId: TaskId,
    runId: TaskRunId,
    workflowResult: unknown,
  ): Promise<void> {
    await this.requireRun(taskId, runId);
    await this.writeJson(this.workflowResultPath(taskId, runId), workflowResult);
    await this.updateRunArtifacts(taskId, runId, {
      workflow_result: "workflow-result.json",
    });
  }

  async saveLandingDecision(
    taskId: TaskId,
    runId: TaskRunId,
    decision: TaskLandingDecision,
  ): Promise<void> {
    await this.requireRun(taskId, runId);
    await this.writeJson(this.landingDecisionPath(taskId, runId), decision);
    await this.updateRunArtifacts(taskId, runId, {
      landing: "landing.json",
    });
  }

  async getLandingDecision(
    taskId: TaskId,
    runId: TaskRunId,
  ): Promise<TaskLandingDecision | null> {
    return this.readJson<TaskLandingDecision>(this.landingDecisionPath(taskId, runId));
  }

  async saveGitHubStatusBridgeState(
    taskId: TaskId,
    state: TaskGitHubStatusBridgeState,
  ): Promise<void> {
    await this.writeJson(this.githubStatusBridgeStatePath(taskId), state);
  }

  async getGitHubStatusBridgeState(
    taskId: TaskId,
  ): Promise<TaskGitHubStatusBridgeState | null> {
    return this.readJson<TaskGitHubStatusBridgeState>(
      this.githubStatusBridgeStatePath(taskId),
    );
  }

  async getWorkflowResult(taskId: TaskId, runId: TaskRunId): Promise<unknown | null> {
    return this.readJson<unknown>(this.workflowResultPath(taskId, runId));
  }

  getTaskDirectory(taskId: TaskId): string {
    return this.taskDir(taskId);
  }

  getRunDirectory(taskId: TaskId, runId: TaskRunId): string {
    return this.runDir(taskId, runId);
  }

  getStateDirectory(): string {
    return this.stateDir;
  }

  private async updateRunArtifacts(
    taskId: TaskId,
    runId: TaskRunId,
    artifacts: Partial<TaskRunRecord["artifacts"]>,
  ): Promise<void> {
    const run = await this.requireRun(taskId, runId);
    await this.writeJson(this.runRecordPath(taskId, runId), {
      ...run,
      artifacts: {
        ...run.artifacts,
        ...artifacts,
      },
      updated_at: Date.now(),
    } satisfies TaskRunRecord);
  }

  private async syncActiveIndex(state: TaskRecordState): Promise<void> {
    const active = await this.listActiveTasks();
    const filtered = active.filter((entry) => entry.task_id !== state.task_id);
    if (state.active_run_id) {
      filtered.push({
        task_id: state.task_id,
        run_id: state.active_run_id,
        lifecycle: state.lifecycle,
        updated_at: state.updated_at,
      });
    }
    filtered.sort((a, b) => a.task_id.localeCompare(b.task_id));
    await this.writeJson(this.activeIndexPath(), filtered);
  }

  private async requireTaskState(taskId: TaskId): Promise<TaskRecordState> {
    const state = await this.getTaskState(taskId);
    if (!state) {
      throw new Error(`Task state not found for "${taskId}"`);
    }
    return state;
  }

  private async requireRun(taskId: TaskId, runId: TaskRunId): Promise<TaskRunRecord> {
    const run = await this.getRun(taskId, runId);
    if (!run) {
      throw new Error(`Run "${runId}" not found for task "${taskId}"`);
    }
    return run;
  }

  private taskDir(taskId: TaskId): string {
    return path.join(this.stateDir, "tasks", encodePathSegment(taskId));
  }

  private envelopePath(taskId: TaskId): string {
    return path.join(this.taskDir(taskId), "envelope.json");
  }

  private taskStatePath(taskId: TaskId): string {
    return path.join(this.taskDir(taskId), "state.json");
  }

  private runsDir(taskId: TaskId): string {
    return path.join(this.taskDir(taskId), "runs");
  }

  private waitingStatePath(taskId: TaskId): string {
    return path.join(this.taskDir(taskId), "waiting-state.json");
  }

  private runDir(taskId: TaskId, runId: TaskRunId): string {
    return path.join(this.runsDir(taskId), encodePathSegment(runId));
  }

  private runRecordPath(taskId: TaskId, runId: TaskRunId): string {
    return path.join(this.runsDir(taskId), `${encodePathSegment(runId)}.json`);
  }

  private runPlanPath(taskId: TaskId, runId: TaskRunId): string {
    return path.join(this.runDir(taskId, runId), "plan.json");
  }

  private runSummaryPath(taskId: TaskId, runId: TaskRunId): string {
    return path.join(this.runDir(taskId, runId), "summary.json");
  }

  private workflowResultPath(taskId: TaskId, runId: TaskRunId): string {
    return path.join(this.runDir(taskId, runId), "workflow-result.json");
  }

  private landingDecisionPath(taskId: TaskId, runId: TaskRunId): string {
    return path.join(this.runDir(taskId, runId), "landing.json");
  }

  private githubStatusBridgeStatePath(taskId: TaskId): string {
    return path.join(this.taskDir(taskId), "github-status.json");
  }

  private activeIndexPath(): string {
    return path.join(this.stateDir, "indexes", "active.json");
  }

  private sourceIndexPath(source: TaskSourceRef): string {
    return path.join(
      this.stateDir,
      "indexes",
      "by-source",
      `${encodePathSegment(buildTaskSourceKey(source))}.json`,
    );
  }

  private tmpDir(): string {
    return path.join(this.stateDir, "_tmp");
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const text = await Bun.file(filePath).text();
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await mkdir(this.tmpDir(), { recursive: true });
    const tmpPath = path.join(this.tmpDir(), `${generateId()}.tmp`);
    const content = JSON.stringify(data, null, 2) + "\n";
    await Bun.write(tmpPath, content);
    try {
      await rename(tmpPath, filePath);
    } catch {
      await Bun.write(filePath, content);
    }
  }
}

export function defaultTaskRecordState(envelope: TaskEnvelope): TaskRecordState {
  return {
    version: "1",
    task_id: envelope.task_id,
    lifecycle: "queued",
    created_at: envelope.timestamps.created_at,
    updated_at: envelope.timestamps.updated_at,
    last_transition_at: envelope.timestamps.updated_at,
    active_run_id: null,
    latest_run_id: null,
    last_completed_run_id: null,
    run_count: 0,
    source_revision: envelope.source.revision ?? null,
  };
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}
