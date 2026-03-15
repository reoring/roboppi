import path from "node:path";
import { parseDuration } from "../workflow/duration.js";
import { TaskDispatcher, type TaskDispatchOptions, type TaskDispatchResult } from "./dispatcher.js";
import { TaskRoutingError, TaskRouter } from "./router.js";
import { TaskRegistryStore } from "./state-store.js";
import { createTaskSources, type TaskSourceBinding } from "./sources.js";
import type {
  TaskClarificationConfig,
  TaskEnvelope,
  TaskLandingConfig,
  TaskOrchestratorConfig,
  TaskRecordState,
  TaskWaitingState,
} from "./types.js";
import type { StepRunner } from "../workflow/executor.js";
import type { ExecEventSink } from "../tui/exec-event.js";

export interface TaskDispatcherLike {
  dispatch(options: TaskDispatchOptions): Promise<TaskDispatchResult>;
}

export interface TaskOrchestratorServiceOptions {
  baseDir?: string;
  registry?: TaskRegistryStore;
  router?: TaskRouter;
  dispatcher?: TaskDispatcherLike;
  sources?: TaskSourceBinding[];
  stepRunner: StepRunner;
  abortSignal?: AbortSignal;
  sink?: ExecEventSink;
  supervised?: boolean;
  cliBaseBranch?: string;
  cliProtectedBranches?: string;
  cliAllowProtectedBranch?: boolean;
}

export interface TaskOrchestratorSourceRunResult {
  sourceId: string;
  candidates: number;
  dispatched: number;
  skipped_active: number;
  skipped_unchanged: number;
  unmatched: number;
  failed: number;
  acked: number;
  ack_failed: number;
  errors: TaskOrchestratorErrorEntry[];
}

export interface TaskOrchestratorErrorEntry {
  sourceId: string;
  stage:
    | "list_candidates"
    | "fetch_envelope"
    | "route"
    | "dispatch"
    | "ack";
  ref?: string;
  taskId?: string;
  message: string;
}

export interface TaskOrchestratorRunResult {
  sources: TaskOrchestratorSourceRunResult[];
  totals: {
    candidates: number;
    dispatched: number;
    skipped_active: number;
    skipped_unchanged: number;
    unmatched: number;
    failed: number;
    acked: number;
    ack_failed: number;
  };
}

export interface TaskOrchestratorBackgroundEvent {
  type: "completed" | "dispatch_failed" | "ack_failed";
  sourceId: string;
  taskId: string;
  ref?: string;
  runId?: string;
  message?: string;
}

export interface TaskOrchestratorRunOptions {
  detachDispatch?: boolean;
  onBackgroundEvent?: (event: TaskOrchestratorBackgroundEvent) => void | Promise<void>;
}

export class TaskOrchestratorService {
  readonly registry: TaskRegistryStore;
  readonly router: TaskRouter;
  readonly dispatcher: TaskDispatcherLike;
  readonly sources: TaskSourceBinding[];
  private readonly landing: TaskLandingConfig;
  private readonly clarification: TaskClarificationConfig;
  private readonly baseDir: string;
  private readonly stepRunner: StepRunner;
  private readonly abortSignal?: AbortSignal;
  private readonly sink?: ExecEventSink;
  private readonly supervised: boolean;
  private readonly cliBaseBranch?: string;
  private readonly cliProtectedBranches?: string;
  private readonly cliAllowProtectedBranch?: boolean;
  private readonly launchingTaskIds = new Set<string>();
  private readonly backgroundDispatches = new Set<Promise<void>>();

  constructor(
    config: TaskOrchestratorConfig,
    options: TaskOrchestratorServiceOptions,
  ) {
    this.baseDir = options.baseDir ?? process.cwd();
    this.registry =
      options.registry ??
      new TaskRegistryStore(resolveStateDir(config.state_dir, this.baseDir));
    this.router = options.router ?? new TaskRouter(config);
    this.dispatcher = options.dispatcher ?? new TaskDispatcher();
    this.sources = options.sources ?? createTaskSources(config, this.baseDir);
    this.landing = config.landing;
    this.clarification = config.clarification;
    this.stepRunner = options.stepRunner;
    this.abortSignal = options.abortSignal;
    this.sink = options.sink;
    this.supervised = options.supervised ?? false;
    this.cliBaseBranch = options.cliBaseBranch;
    this.cliProtectedBranches = options.cliProtectedBranches;
    this.cliAllowProtectedBranch = options.cliAllowProtectedBranch;
  }

  async runOnce(
    options: TaskOrchestratorRunOptions = {},
  ): Promise<TaskOrchestratorRunResult> {
    await this.reconcileWaitingTasks();
    const sourceResults: TaskOrchestratorSourceRunResult[] = [];

    for (const binding of this.sources) {
      const result: TaskOrchestratorSourceRunResult = {
        sourceId: binding.id,
        candidates: 0,
        dispatched: 0,
        skipped_active: 0,
        skipped_unchanged: 0,
        unmatched: 0,
        failed: 0,
        acked: 0,
        ack_failed: 0,
        errors: [],
      };

      let refs;
      try {
        refs = await binding.source.listCandidates(this.abortSignal);
      } catch (err) {
        result.failed++;
        result.errors.push({
          sourceId: binding.id,
          stage: "list_candidates",
          message: formatErrorMessage(err),
        });
        sourceResults.push(result);
        continue;
      }
      result.candidates = refs.length;

      for (const ref of refs) {
        if (this.abortSignal?.aborted) break;

        let task: TaskEnvelope | undefined;
        try {
          task = await binding.source.fetchEnvelope(ref, this.abortSignal);
          const existingTaskId = await this.registry.resolveTaskIdBySource(task.source);
          if (existingTaskId && existingTaskId !== task.task_id) {
            task = {
              ...task,
              task_id: existingTaskId,
            };
          }
          const previousState = await this.registry.getTaskState(task.task_id);
          await this.registry.upsertEnvelope(task);

          const state = await this.registry.getTaskState(task.task_id);
          if (state?.active_run_id || this.launchingTaskIds.has(task.task_id)) {
            result.skipped_active++;
            continue;
          }
          if (shouldSkipUnchangedTask(task, previousState)) {
            result.skipped_unchanged++;
            continue;
          }

          let decision;
          try {
            decision = this.router.route(task);
          } catch (err) {
            if (err instanceof TaskRoutingError) {
              result.unmatched++;
              result.errors.push({
                sourceId: binding.id,
                stage: "route",
                ref: ref.external_id,
                taskId: task.task_id,
                message: formatErrorMessage(err),
              });
              continue;
            }
            throw err;
          }

          const workspaceDir = resolveWorkspaceDir(task, this.baseDir);
          if (options.detachDispatch) {
            result.dispatched++;
            this.launchDetachedDispatch({
              binding,
              ref,
              task,
              previousState,
              decision,
              workspaceDir,
              onBackgroundEvent: options.onBackgroundEvent,
            });
          } else {
            const dispatchResult = await this.dispatcher.dispatch({
              registry: this.registry,
              task,
              decision,
              workspaceDir,
              stepRunner: this.stepRunner,
              abortSignal: this.abortSignal,
              sink: this.sink,
              supervised: this.supervised,
              cliBaseBranch: this.cliBaseBranch,
              cliProtectedBranches: this.cliProtectedBranches,
              cliAllowProtectedBranch: this.cliAllowProtectedBranch,
              landing: this.landing,
            });
            await this.applyPostDispatchPolicies(task, previousState);

            result.dispatched++;
            try {
              await binding.source.ack?.({
                task_id: task.task_id,
                run_id: dispatchResult.runId,
                state:
                  (await this.registry.getTaskState(task.task_id))?.lifecycle ??
                  "queued",
              }, this.abortSignal);
              if (binding.source.ack) {
                result.acked++;
              }
            } catch (err) {
              result.ack_failed++;
              result.errors.push({
                sourceId: binding.id,
                stage: "ack",
                ref: ref.external_id,
                taskId: task.task_id,
                message: formatErrorMessage(err),
              });
            }
          }
        } catch (err) {
          result.failed++;
          if (task) {
            const stage = inferFailureStage(err);
            result.errors.push({
              sourceId: binding.id,
              stage,
              ref: ref.external_id,
              taskId: task.task_id,
              message: formatErrorMessage(err),
            });
            try {
              await binding.source.ack?.({
                task_id: task.task_id,
                state:
                  (await this.registry.getTaskState(task.task_id))?.lifecycle ??
                  "failed",
              }, this.abortSignal);
              if (binding.source.ack) {
                result.acked++;
              }
            } catch (ackErr) {
              result.ack_failed++;
              result.errors.push({
                sourceId: binding.id,
                stage: "ack",
                ref: ref.external_id,
                taskId: task.task_id,
                message: formatErrorMessage(ackErr),
              });
            }
          } else {
            result.errors.push({
              sourceId: binding.id,
              stage: "fetch_envelope",
              ref: ref.external_id,
              message: formatErrorMessage(err),
            });
          }
        }
      }

      sourceResults.push(result);
    }

    return {
      sources: sourceResults,
      totals: sourceResults.reduce(
        (totals, result) => ({
          candidates: totals.candidates + result.candidates,
          dispatched: totals.dispatched + result.dispatched,
          skipped_active: totals.skipped_active + result.skipped_active,
          skipped_unchanged: totals.skipped_unchanged + result.skipped_unchanged,
          unmatched: totals.unmatched + result.unmatched,
          failed: totals.failed + result.failed,
          acked: totals.acked + result.acked,
          ack_failed: totals.ack_failed + result.ack_failed,
        }),
        {
          candidates: 0,
          dispatched: 0,
          skipped_active: 0,
          skipped_unchanged: 0,
          unmatched: 0,
          failed: 0,
          acked: 0,
          ack_failed: 0,
        },
      ),
    };
  }

  getBackgroundDispatchCount(): number {
    return this.backgroundDispatches.size;
  }

  async waitForBackgroundDispatches(): Promise<void> {
    const pending = [...this.backgroundDispatches];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }

  private launchDetachedDispatch(args: {
    binding: TaskSourceBinding;
    ref: { external_id: string };
    task: TaskEnvelope;
    previousState: TaskRecordState | null;
    decision: NonNullable<ReturnType<TaskRouter["route"]>>;
    workspaceDir: string;
    onBackgroundEvent?: (
      event: TaskOrchestratorBackgroundEvent,
    ) => void | Promise<void>;
  }): void {
    const { binding, ref, task, previousState, decision, workspaceDir, onBackgroundEvent } = args;
    this.launchingTaskIds.add(task.task_id);

    let backgroundPromise!: Promise<void>;
    backgroundPromise = (async () => {
      try {
        const dispatchResult = await this.dispatcher.dispatch({
          registry: this.registry,
          task,
          decision,
          workspaceDir,
          stepRunner: this.stepRunner,
          abortSignal: this.abortSignal,
          sink: this.sink,
          supervised: this.supervised,
          cliBaseBranch: this.cliBaseBranch,
          cliProtectedBranches: this.cliProtectedBranches,
          cliAllowProtectedBranch: this.cliAllowProtectedBranch,
          landing: this.landing,
        });
        await this.applyPostDispatchPolicies(task, previousState);
        try {
          await binding.source.ack?.({
            task_id: task.task_id,
            run_id: dispatchResult.runId,
            state:
              (await this.registry.getTaskState(task.task_id))?.lifecycle ??
              "queued",
          }, this.abortSignal);
        } catch (err) {
          await onBackgroundEvent?.({
            type: "ack_failed",
            sourceId: binding.id,
            taskId: task.task_id,
            ref: ref.external_id,
            runId: dispatchResult.runId,
            message: formatErrorMessage(err),
          });
          return;
        }
        await onBackgroundEvent?.({
          type: "completed",
          sourceId: binding.id,
          taskId: task.task_id,
          ref: ref.external_id,
          runId: dispatchResult.runId,
        });
      } catch (err) {
        await onBackgroundEvent?.({
          type: "dispatch_failed",
          sourceId: binding.id,
          taskId: task.task_id,
          ref: ref.external_id,
          message: formatErrorMessage(err),
        });
      } finally {
        this.launchingTaskIds.delete(task.task_id);
        this.backgroundDispatches.delete(backgroundPromise);
      }
    })();

    this.backgroundDispatches.add(backgroundPromise);
  }

  private async reconcileWaitingTasks(): Promise<void> {
    if (!this.clarification.enabled) {
      return;
    }

    const states = await this.registry.listTaskStates();
    const now = Date.now();
    for (const state of states) {
      if (state.active_run_id !== null) continue;
      if (state.lifecycle !== "waiting_for_input") continue;

      const waitingState = await this.registry.getWaitingState(state.task_id);
      if (!waitingState || waitingState.status !== "waiting") continue;

      let nextWaitingState = waitingState;
      if (
        waitingState.reminder_due_at !== null
        && waitingState.reminder_due_at <= now
        && waitingState.reminder_sent_at === null
      ) {
        nextWaitingState = {
          ...nextWaitingState,
          reminder_sent_at: now,
          updated_at: now,
        };
        await this.registry.saveWaitingState(nextWaitingState);
      }

      if (waitingState.block_after_at === null || waitingState.block_after_at > now) {
        continue;
      }

      await this.registry.saveTaskState({
        ...state,
        lifecycle: "blocked",
        updated_at: now,
        last_transition_at: now,
      });
      await this.registry.saveWaitingState({
        ...nextWaitingState,
        status: "blocked",
        blocked_at: now,
        updated_at: now,
      });
    }
  }

  private async applyPostDispatchPolicies(
    task: TaskEnvelope,
    previousState: TaskRecordState | null,
  ): Promise<void> {
    if (!this.clarification.enabled) {
      return;
    }

    const currentState = await this.registry.getTaskState(task.task_id);
    if (!currentState) return;

    if (previousState?.lifecycle === "waiting_for_input") {
      await this.markWaitingStateResumed(task);
    }

    if (currentState.lifecycle !== "waiting_for_input") {
      return;
    }

    const now = Date.now();
    const existingWaitingState = await this.registry.getWaitingState(task.task_id);
    const roundTripCount = (existingWaitingState?.round_trip_count ?? 0) + 1;
    const waitingState = buildWaitingState({
      task,
      now,
      roundTripCount,
      reminderAfterMs: parseOptionalDuration(this.clarification.reminder_after),
      blockAfterMs: parseOptionalDuration(this.clarification.block_after),
    });
    await this.registry.saveWaitingState(waitingState);

    if (roundTripCount <= this.clarification.max_round_trips) {
      return;
    }

    const blockedAt = Date.now();
    await this.registry.saveTaskState({
      ...currentState,
      lifecycle: "blocked",
      updated_at: blockedAt,
      last_transition_at: blockedAt,
    });
    await this.registry.saveWaitingState({
      ...waitingState,
      status: "blocked",
      blocked_at: blockedAt,
      updated_at: blockedAt,
    });
  }

  private async markWaitingStateResumed(task: TaskEnvelope): Promise<void> {
    const waitingState = await this.registry.getWaitingState(task.task_id);
    if (!waitingState) return;
    const now = Date.now();
    await this.registry.saveWaitingState({
      ...waitingState,
      status: "resumed",
      last_source_revision: task.source.revision ?? waitingState.last_source_revision,
      last_human_signal_at: inferHumanSignalAt(task),
      resumed_at: now,
      updated_at: now,
    });
  }
}

function shouldSkipUnchangedTask(
  task: TaskEnvelope,
  previousState: {
    active_run_id: string | null;
    lifecycle: string;
    run_count: number;
    source_revision: string | null;
  } | null,
): boolean {
  if (!previousState) return false;
  if (previousState.active_run_id !== null) return false;
  if (previousState.run_count === 0) return false;
  if (!SUCCESSFUL_UNCHANGED_SKIP_LIFECYCLES.has(previousState.lifecycle)) return false;
  if (!task.source.revision || !previousState.source_revision) return false;
  return task.source.revision === previousState.source_revision;
}

const SUCCESSFUL_UNCHANGED_SKIP_LIFECYCLES = new Set([
  "waiting_for_input",
  "blocked",
  "review_required",
  "ready_to_land",
  "landed",
  "closed_without_landing",
]);

function resolveStateDir(stateDir: string, baseDir: string): string {
  return path.isAbsolute(stateDir) ? stateDir : path.resolve(baseDir, stateDir);
}

function resolveWorkspaceDir(task: TaskEnvelope, baseDir: string): string {
  const fromTask = task.repository?.local_path;
  if (fromTask) return fromTask;
  return baseDir;
}

function formatErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function inferFailureStage(
  err: unknown,
): TaskOrchestratorErrorEntry["stage"] {
  if (err instanceof TaskRoutingError) return "route";
  if (err instanceof Error && err.name === "TaskDispatchError") return "dispatch";
  return "fetch_envelope";
}

function parseOptionalDuration(value: string | undefined): number | null {
  if (!value) return null;
  return parseDuration(value);
}

function inferHumanSignalAt(task: TaskEnvelope): number {
  const fromMetadata = task.metadata?.["last_human_comment_at"];
  if (typeof fromMetadata === "number" && Number.isFinite(fromMetadata)) {
    return fromMetadata;
  }
  return task.timestamps.updated_at;
}

function buildWaitingState(args: {
  task: TaskEnvelope;
  now: number;
  roundTripCount: number;
  reminderAfterMs: number | null;
  blockAfterMs: number | null;
}): TaskWaitingState {
  return {
    version: "1",
    task_id: args.task.task_id,
    status: "waiting",
    round_trip_count: args.roundTripCount,
    waiting_started_at: args.now,
    updated_at: args.now,
    last_source_revision: args.task.source.revision ?? null,
    last_human_signal_at: inferHumanSignalAt(args.task),
    reminder_due_at:
      args.reminderAfterMs === null ? null : args.now + args.reminderAfterMs,
    reminder_sent_at: null,
    block_after_at:
      args.blockAfterMs === null ? null : args.now + args.blockAfterMs,
    resumed_at: null,
    blocked_at: null,
  };
}
