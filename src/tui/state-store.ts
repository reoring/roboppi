import type { WorkerResult } from "../types/index.js";
import type { ExecEventSink, ExecEvent } from "./exec-event.js";
import { RingBuffer } from "./ring-buffer.js";
import { generateId } from "../types/index.js";

export type LogChannel = "stdout" | "stderr" | "progress" | "core" | "runner";

export interface PatchEntry {
  id: string;
  stepId: string;
  ts: number;
  filePath: string;
  diff: string;
}

export interface StepUiState {
  stepId: string;
  status: string;
  phase?: string;
  iteration: number;
  maxIterations: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  progress?: { ts: number; message: string; percent?: number };
  logs: {
    stdout: RingBuffer<string>;
    stderr: RingBuffer<string>;
    progress: RingBuffer<string>;
  };
  patches: {
    byId: Map<string, PatchEntry>;
    order: string[];
    byFilePath: Map<string, string[]>;
  };
  result?: WorkerResult;
}

export interface WorkflowUiState {
  workflowId?: string;
  name?: string;
  workspaceDir?: string;
  supervised?: boolean;
  startedAt?: number;
  finishedAt?: number;
  status?: string;
  steps: Map<string, StepUiState>;
  stepOrder: string[];
  selectedStepId?: string;
  followMode: "selected" | "running";
  selectedTab: "overview" | "logs" | "diffs" | "result" | "core" | "help";
  coreLogs: RingBuffer<string>;
  warnings: RingBuffer<string>;
}

export interface TuiStateStoreOptions {
  supervised?: boolean;
  logLimitLines?: number;
  logLimitBytes?: number;
}

export class TuiStateStore implements ExecEventSink {
  readonly state: WorkflowUiState;
  dirty = false;

  private readonly logLimitLines: number;
  private readonly logLimitBytes: number;

  constructor(opts?: TuiStateStoreOptions) {
    this.logLimitLines = opts?.logLimitLines ?? 5000;
    this.logLimitBytes = opts?.logLimitBytes ?? 2 * 1024 * 1024;

    this.state = {
      supervised: opts?.supervised,
      steps: new Map(),
      stepOrder: [],
      followMode: "running",
      selectedTab: "overview",
      coreLogs: new RingBuffer<string>({
        maxLines: this.logLimitLines,
        maxBytes: this.logLimitBytes,
      }),
      warnings: new RingBuffer<string>({
        maxLines: this.logLimitLines,
        maxBytes: this.logLimitBytes,
      }),
    };
  }

  emit(event: ExecEvent): void {
    this.dirty = true;

    switch (event.type) {
      case "workflow_started":
        this.reduceWorkflowStarted(event);
        break;
      case "workflow_finished":
        this.reduceWorkflowFinished(event);
        break;
      case "step_state":
        this.reduceStepState(event);
        break;
      case "step_phase":
        this.reduceStepPhase(event);
        break;
      case "worker_event":
        this.reduceWorkerEvent(event);
        break;
      case "worker_result":
        this.reduceWorkerResult(event);
        break;
      case "core_log":
        this.reduceCoreLog(event);
        break;
      case "warning":
        this.reduceWarning(event);
        break;
    }
  }

  getOrCreateStep(stepId: string): StepUiState {
    let step = this.state.steps.get(stepId);
    if (!step) {
      step = this.makeStepUiState(stepId);
      this.state.steps.set(stepId, step);
      if (!this.state.stepOrder.includes(stepId)) {
        this.state.stepOrder.push(stepId);
      }
    }
    return step;
  }

  private makeStepUiState(stepId: string): StepUiState {
    const logOpts = {
      maxLines: this.logLimitLines,
      maxBytes: this.logLimitBytes,
    };
    return {
      stepId,
      status: "PENDING",
      iteration: 0,
      maxIterations: 1,
      logs: {
        stdout: new RingBuffer<string>(logOpts),
        stderr: new RingBuffer<string>(logOpts),
        progress: new RingBuffer<string>(logOpts),
      },
      patches: {
        byId: new Map(),
        order: [],
        byFilePath: new Map(),
      },
    };
  }

  private reduceWorkflowStarted(
    event: Extract<ExecEvent, { type: "workflow_started" }>,
  ): void {
    this.state.workflowId = event.workflowId;
    this.state.name = event.name;
    this.state.workspaceDir = event.workspaceDir;
    this.state.supervised = event.supervised;
    this.state.startedAt = event.startedAt;
    this.state.status = "RUNNING";

    if (event.definitionSummary) {
      for (const stepId of event.definitionSummary.steps) {
        this.getOrCreateStep(stepId);
      }
    }
  }

  private reduceWorkflowFinished(
    event: Extract<ExecEvent, { type: "workflow_finished" }>,
  ): void {
    this.state.status = event.status;
    this.state.finishedAt = event.completedAt;
  }

  private reduceStepState(
    event: Extract<ExecEvent, { type: "step_state" }>,
  ): void {
    const step = this.getOrCreateStep(event.stepId);
    step.status = event.status;
    step.iteration = event.iteration;
    step.maxIterations = event.maxIterations;
    if (event.startedAt !== undefined) step.startedAt = event.startedAt;
    if (event.completedAt !== undefined) step.completedAt = event.completedAt;
    if (event.error !== undefined) step.error = event.error;
  }

  private reduceStepPhase(
    event: Extract<ExecEvent, { type: "step_phase" }>,
  ): void {
    const step = this.getOrCreateStep(event.stepId);
    step.phase = event.phase;
  }

  private reduceWorkerEvent(
    event: Extract<ExecEvent, { type: "worker_event" }>,
  ): void {
    const step = this.getOrCreateStep(event.stepId);
    const we = event.event;

    switch (we.type) {
      case "stdout":
        step.logs.stdout.push(we.data);
        break;
      case "stderr":
        step.logs.stderr.push(we.data);
        break;
      case "progress":
        step.logs.progress.push(we.message);
        step.progress = {
          ts: event.ts,
          message: we.message,
          percent: we.percent,
        };
        break;
      case "patch": {
        const id = generateId();
        const entry: PatchEntry = {
          id,
          stepId: event.stepId,
          ts: event.ts,
          filePath: we.filePath,
          diff: we.diff,
        };
        step.patches.byId.set(id, entry);
        step.patches.order.push(id);

        const existing = step.patches.byFilePath.get(we.filePath);
        if (existing) {
          existing.push(id);
        } else {
          step.patches.byFilePath.set(we.filePath, [id]);
        }
        break;
      }
    }
  }

  private reduceWorkerResult(
    event: Extract<ExecEvent, { type: "worker_result" }>,
  ): void {
    const step = this.getOrCreateStep(event.stepId);
    step.result = event.result;
  }

  private reduceCoreLog(
    event: Extract<ExecEvent, { type: "core_log" }>,
  ): void {
    this.state.coreLogs.push(event.line);
  }

  private reduceWarning(
    event: Extract<ExecEvent, { type: "warning" }>,
  ): void {
    this.state.warnings.push(event.message);
  }
}
