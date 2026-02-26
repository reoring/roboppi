import { mkdir, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExecEventSink, ExecEvent } from "../../tui/exec-event.js";

export interface TelemetryOptions {
  eventsFile: string; // relative to contextDir
  stateFile: string; // relative to contextDir
  includeWorkerOutput: boolean;
}

export class TelemetrySink implements ExecEventSink {
  private inner: ExecEventSink;
  private options: TelemetryOptions;
  private eventsPath: string;
  private statePath: string;
  private initPromise: Promise<void> | null = null;
  private currentState: Record<string, unknown> = {};
  /** Serializes state.json writes to prevent concurrent corruption. */
  private stateWriteChain: Promise<void> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STATE_DEBOUNCE_MS = 500;

  constructor(
    inner: ExecEventSink,
    contextDir: string,
    options: TelemetryOptions,
  ) {
    this.inner = inner;
    this.options = options;
    this.eventsPath = path.resolve(contextDir, options.eventsFile);
    this.statePath = path.resolve(contextDir, options.stateFile);
  }

  emit(event: ExecEvent): void {
    // Forward to inner sink first
    this.inner.emit(event);
    // Async write (fire-and-forget, don't block the event loop)
    this.writeEvent(event).catch(() => {});
  }

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await mkdir(path.dirname(this.eventsPath), { recursive: true });
        await mkdir(path.dirname(this.statePath), { recursive: true });
      })();
    }
    return this.initPromise;
  }

  private redactEvent(event: ExecEvent): Record<string, unknown> {
    const base: Record<string, unknown> = { type: event.type };

    switch (event.type) {
      case "workflow_started":
        return {
          ...base,
          workflowId: event.workflowId,
          name: event.name,
          startedAt: event.startedAt,
        };
      case "workflow_finished":
        return {
          ...base,
          status: event.status,
          completedAt: event.completedAt,
        };
      case "step_state":
        return {
          ...base,
          stepId: event.stepId,
          status: event.status,
          iteration: event.iteration,
          maxIterations: event.maxIterations,
          startedAt: event.startedAt,
          completedAt: event.completedAt,
        };
      case "step_phase":
        return {
          ...base,
          stepId: event.stepId,
          phase: event.phase,
          at: event.at,
        };
      case "worker_event": {
        const redacted: Record<string, unknown> = {
          ...base,
          stepId: event.stepId,
          ts: event.ts,
          eventKind: event.event.type,
        };
        // Include byte length for stdout/stderr but not content
        if (
          (event.event.type === "stdout" || event.event.type === "stderr") &&
          !this.options.includeWorkerOutput
        ) {
          redacted.byteLength = event.event.data.length;
        } else if (this.options.includeWorkerOutput) {
          redacted.event = event.event;
        }
        return redacted;
      }
      case "worker_result":
        return {
          ...base,
          stepId: event.stepId,
          ts: event.ts,
          status: event.result.status,
        };
      case "core_log":
        return { ...base, ts: event.ts }; // Don't include log content
      case "warning":
        return { ...base, ts: event.ts, message: event.message };
      default:
        return base;
    }
  }

  private async writeEvent(event: ExecEvent): Promise<void> {
    await this.ensureInit();
    const redacted = this.redactEvent(event);
    await appendFile(this.eventsPath, JSON.stringify(redacted) + "\n");

    // Update state snapshot in memory immediately; debounce file write.
    this.updateState(event);
    this.scheduleStateWrite();
  }

  private scheduleStateWrite(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.stateWriteChain = this.stateWriteChain
        .then(() => writeFile(this.statePath, JSON.stringify(this.currentState, null, 2)))
        .catch(() => {});
    }, TelemetrySink.STATE_DEBOUNCE_MS);
  }

  /** Flush any pending debounced state.json write immediately. */
  async flush(): Promise<void> {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.stateWriteChain = this.stateWriteChain
        .then(() => writeFile(this.statePath, JSON.stringify(this.currentState, null, 2)))
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

/** Factory helper for creating TelemetrySink from SentinelConfig. */
export function createTelemetrySink(
  inner: ExecEventSink,
  contextDir: string,
  sentinel: {
    telemetry?: {
      events_file?: string;
      state_file?: string;
      include_worker_output?: boolean;
    };
  },
): TelemetrySink {
  return new TelemetrySink(inner, contextDir, {
    eventsFile: sentinel.telemetry?.events_file ?? "_workflow/events.jsonl",
    stateFile: sentinel.telemetry?.state_file ?? "_workflow/state.json",
    includeWorkerOutput: sentinel.telemetry?.include_worker_output ?? false,
  });
}
