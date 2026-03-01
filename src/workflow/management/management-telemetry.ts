/**
 * ManagementTelemetrySink — lightweight telemetry for management-only mode.
 *
 * When management is enabled but Sentinel is NOT enabled, this sink ensures
 * that `_workflow/state.json` is written (step state snapshots), giving the
 * management controller a current state file to read.
 *
 * Unlike Sentinel's full TelemetrySink, this does NOT write events.jsonl.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecEventSink, ExecEvent } from "../../tui/exec-event.js";

export class ManagementTelemetrySink implements ExecEventSink {
  private readonly inner: ExecEventSink;
  private readonly statePath: string;
  private initPromise: Promise<void> | null = null;
  private currentState: Record<string, unknown> = {};
  private stateWriteChain: Promise<void> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STATE_DEBOUNCE_MS = 500;

  constructor(inner: ExecEventSink, contextDir: string) {
    this.inner = inner;
    this.statePath = path.resolve(contextDir, "_workflow", "state.json");
  }

  emit(event: ExecEvent): void {
    this.inner.emit(event);
    this.updateState(event);
    this.scheduleStateWrite();
  }

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = mkdir(path.dirname(this.statePath), {
        recursive: true,
      }).then(() => {});
    }
    return this.initPromise!;
  }

  private scheduleStateWrite(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.stateWriteChain = this.stateWriteChain
        .then(() => this.ensureInit())
        .then(() =>
          writeFile(
            this.statePath,
            JSON.stringify(this.currentState, null, 2),
          ),
        )
        .catch(() => {});
    }, ManagementTelemetrySink.STATE_DEBOUNCE_MS);
  }

  async flush(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.stateWriteChain = this.stateWriteChain
        .then(() => this.ensureInit())
        .then(() =>
          writeFile(
            this.statePath,
            JSON.stringify(this.currentState, null, 2),
          ),
        )
        .catch(() => {});
    }
    await this.stateWriteChain;
  }

  private updateState(event: ExecEvent): void {
    switch (event.type) {
      case "workflow_started":
        this.currentState = {
          workflowId: event.workflowId,
          name: event.name,
          status: "RUNNING",
          startedAt: event.startedAt,
          steps: {},
        };
        break;
      case "workflow_finished":
        this.currentState.status = event.status;
        this.currentState.completedAt = event.completedAt;
        break;
      case "step_state": {
        const steps = (this.currentState.steps ?? {}) as Record<
          string,
          unknown
        >;
        steps[event.stepId] = {
          status: event.status,
          iteration: event.iteration,
          maxIterations: event.maxIterations,
          startedAt: event.startedAt,
          completedAt: event.completedAt,
        };
        this.currentState.steps = steps;
        break;
      }
      case "step_phase": {
        const steps2 = (this.currentState.steps ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        const stepEntry = steps2[event.stepId];
        if (stepEntry) {
          stepEntry.phase = event.phase;
          stepEntry.phaseAt = event.at;
        }
        break;
      }
    }
  }
}
