import type { ExecEventSink, ExecEvent } from "../../tui/exec-event.js";
import type { SentinelConfig, StallPolicy } from "../types.js";
import { ActivityTracker } from "./activity-tracker.js";
import {
  NoOutputWatcher,
  NoProgressWatcher,
  type StallTriggerResult,
} from "./stall-watcher.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Abort reason tag used to distinguish sentinel aborts from other aborts. */
export const SENTINEL_ABORT_REASON = "sentinel:stall";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface SentinelGuard {
  stop(): void;
  /** Returns the last stall trigger result, if any. */
  getLastTrigger(): StallTriggerResult | null;
}

// ---------------------------------------------------------------------------
// SentinelController
// ---------------------------------------------------------------------------

export class SentinelController {
  private activityTracker: ActivityTracker;
  private guards = new Map<string, { watchers: Array<{ stop(): void }> }>();
  private config: SentinelConfig;
  private contextDir: string;
  private sink: ExecEventSink;
  private workflowId: string;
  private workflowName: string;
  private workspaceDir?: string;

  constructor(
    config: SentinelConfig,
    contextDir: string,
    sink: ExecEventSink,
    workflowId: string,
    workflowName: string,
    workspaceDir?: string,
  ) {
    this.config = config;
    this.contextDir = contextDir;
    this.sink = sink;
    this.workflowId = workflowId;
    this.workflowName = workflowName;
    this.workspaceDir = workspaceDir;
    this.activityTracker = new ActivityTracker();
  }

  /** Called on every ExecEvent to update activity tracking. */
  onEvent(event: ExecEvent): void {
    this.activityTracker.onEvent(event);
  }

  /**
   * Guard a running step — starts watchers based on the stall policy.
   *
   * The returned guard handle MUST be stopped when the step/check finishes.
   */
  guardStep(
    stepId: string,
    iteration: number,
    policy: StallPolicy,
    abortController: AbortController,
    env?: Record<string, string>,
  ): SentinelGuard {
    return this.startGuard(stepId, iteration, policy, abortController, "executing", env);
  }

  /**
   * Guard a running completion check — starts watchers based on the stall policy.
   */
  guardCheck(
    stepId: string,
    iteration: number,
    policy: StallPolicy,
    abortController: AbortController,
    env?: Record<string, string>,
  ): SentinelGuard {
    return this.startGuard(stepId, iteration, policy, abortController, "checking", env);
  }

  /** Stop all active watchers (called on workflow teardown). */
  stopAll(): void {
    for (const [, entry] of this.guards) {
      for (const w of entry.watchers) w.stop();
    }
    this.guards.clear();
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private startGuard(
    stepId: string,
    iteration: number,
    policy: StallPolicy,
    abortController: AbortController,
    phase: "executing" | "checking",
    env?: Record<string, string>,
  ): SentinelGuard {
    const guardKey = `${stepId}:${phase}:${iteration}`;

    // Register step with activity tracker
    this.activityTracker.register(stepId, Date.now());

    const watchers: Array<{ stop(): void }> = [];
    let lastTrigger: StallTriggerResult | null = null;

    const abortStep = () => {
      // Tag the abort reason so the executor can distinguish sentinel aborts.
      abortController.abort(SENTINEL_ABORT_REASON);
    };

    // Compute effective telemetry paths from config
    const telemetryPaths = {
      eventsFile: this.config.telemetry?.events_file ?? "_workflow/events.jsonl",
      stateFile: this.config.telemetry?.state_file ?? "_workflow/state.json",
    };

    const watcherOptions = {
      stepId,
      iteration,
      policy,
      contextDir: this.contextDir,
      workflowId: this.workflowId,
      workflowName: this.workflowName,
      activityTracker: this.activityTracker,
      abortStep,
      sink: this.sink,
      onTrigger: (result: StallTriggerResult) => {
        lastTrigger = result;
      },
      phase,
      telemetryPaths,
    };

    // Resolve effective no_output_timeout: step policy → workflow defaults
    const effectiveNoOutputTimeout =
      policy.no_output_timeout ?? this.config.defaults?.no_output_timeout;

    // Resolve effective activity_source: step policy → workflow defaults
    const effectiveActivitySource =
      policy.activity_source ?? this.config.defaults?.activity_source ?? "worker_event";

    // Create NoOutputWatcher if configured (skip for probe_only mode)
    if (effectiveNoOutputTimeout && effectiveActivitySource !== "probe_only") {
      const noOutputPolicy: StallPolicy = {
        ...policy,
        no_output_timeout: effectiveNoOutputTimeout,
      };
      const noOutputWatcher = new NoOutputWatcher({
        ...watcherOptions,
        policy: noOutputPolicy,
        activitySource: effectiveActivitySource,
      });
      noOutputWatcher.start();
      watchers.push(noOutputWatcher);
    }

    // Create NoProgressWatcher if probe is configured
    if (policy.probe) {
      const noProgressWatcher = new NoProgressWatcher(
        watcherOptions,
        this.workspaceDir,
        env,
      );
      noProgressWatcher.start();
      watchers.push(noProgressWatcher);
    }

    this.guards.set(guardKey, { watchers });

    return {
      stop: () => {
        for (const w of watchers) w.stop();
        this.guards.delete(guardKey);
        this.activityTracker.unregister(stepId);
      },
      getLastTrigger: () => lastTrigger,
    };
  }
}
