import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import type { ExecEventSink } from "../../tui/exec-event.js";
import type { StallPolicy } from "../types.js";
import { parseDuration } from "../duration.js";
import type { ActivityTracker } from "./activity-tracker.js";
import { ProbeRunner, type ProbeResult } from "./probe-runner.js";

export interface StallTriggerResult {
  kind: "no_output" | "no_progress" | "terminal";
  reason: string;
  fingerprints: string[];
  reasons: string[];
  probeData?: Record<string, unknown>;
}

export interface StallWatcherOptions {
  stepId: string;
  iteration: number;
  policy: StallPolicy;
  contextDir: string;
  workflowId: string;
  workflowName: string;
  activityTracker: ActivityTracker;
  abortStep: () => void; // Callback to abort the step
  sink: ExecEventSink;
  onTrigger: (result: StallTriggerResult) => void;
  phase: "executing" | "checking";
  activitySource?: "worker_event" | "any_event" | "probe_only";
  telemetryPaths: {
    eventsFile: string;
    stateFile: string;
  };
}

export class NoOutputWatcher {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private options: StallWatcherOptions;
  private timeoutMs: number;
  private ignoreFired = false;

  constructor(options: StallWatcherOptions) {
    this.options = options;
    const timeoutStr = options.policy.no_output_timeout;
    if (!timeoutStr)
      throw new Error("no_output_timeout is required for NoOutputWatcher");
    this.timeoutMs = parseDuration(timeoutStr);
  }

  start(): void {
    // Check every second (or more frequently than the timeout)
    const checkIntervalMs = Math.min(1000, this.timeoutMs / 2);
    this.intervalId = setInterval(() => this.check(), checkIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async check(): Promise<void> {
    if (this.stopped) return;

    const activity = this.options.activityTracker.get(this.options.stepId);
    if (!activity) return;

    // Select reference timestamp based on activity_source
    let referenceTs: number;
    const source = this.options.activitySource ?? "worker_event";
    switch (source) {
      case "any_event":
        referenceTs = Math.max(
          activity.lastWorkerOutputTs,
          activity.lastStepPhaseTs,
          activity.lastStepStateTs,
        );
        break;
      case "worker_event":
      default:
        referenceTs = activity.lastWorkerOutputTs;
        break;
    }
    const elapsed = Date.now() - referenceTs;
    if (elapsed >= this.timeoutMs) {
      const action = this.options.policy.on_stall?.action ?? "interrupt";

      // When no worker_event has ever been received, add diagnostic fingerprint
      // so operators can identify potential false positives (e.g. BATCH/CUSTOM
      // workers that don't emit worker_event).
      const noInitialEvent = source === "any_event"
        ? false  // any_event always has initial timestamps from register()
        : !activity.hasReceivedWorkerEvent;

      const trigger: StallTriggerResult = {
        kind: "no_output",
        reason: noInitialEvent
          ? `no worker output received since step start (threshold: ${Math.round(this.timeoutMs / 1000)}s) — no worker_event ever observed; consider using probe-based detection`
          : `no worker output for ${Math.round(elapsed / 1000)}s (threshold: ${Math.round(this.timeoutMs / 1000)}s)`,
        fingerprints: [
          "stall/no-output",
          ...(noInitialEvent ? ["stall/no-initial-output"] : []),
          ...(this.options.policy.on_stall?.fingerprint_prefix ?? []),
        ],
        reasons: [
          "no worker output detected",
          ...(noInitialEvent ? ["no worker_event received since step start — detection may be unreliable for this worker type"] : []),
        ],
      };

      if (action === "ignore") {
        // Write event.json once for observability, but don't abort
        if (!this.ignoreFired) {
          this.ignoreFired = true;
          await this.writeStallEvent(trigger);
          this.options.sink.emit({
            type: "warning",
            ts: Date.now(),
            message: `[sentinel] Step "${this.options.stepId}" stalled (ignored): ${trigger.reason}`,
            data: { trigger },
          });
        }
        // Continue watching — don't stop, don't call onTrigger or abortStep
        return;
      }

      this.stop();

      // Write event.json artifact
      await this.writeStallEvent(trigger);

      // Emit warning event
      this.options.sink.emit({
        type: "warning",
        ts: Date.now(),
        message: `[sentinel] Step "${this.options.stepId}" stalled: ${trigger.reason}`,
        data: { trigger },
      });

      // Notify callback
      this.options.onTrigger(trigger);

      // Abort the step
      this.options.abortStep();
    }
  }

  private async writeStallEvent(trigger: StallTriggerResult): Promise<void> {
    const stallDir = path.join(
      this.options.contextDir,
      this.options.stepId,
      "_stall",
    );
    await mkdir(stallDir, { recursive: true });

    const actionKind = this.options.policy.on_stall?.action ?? "interrupt";
    const event = {
      schema: "roboppi.sentinel.stall.v1",
      workflow: {
        workflow_id: this.options.workflowId,
        name: this.options.workflowName,
      },
      step: {
        id: this.options.stepId,
        iteration: this.options.iteration,
        phase: this.options.phase,
      },
      trigger: {
        kind: trigger.kind,
        reason: trigger.reason,
        observed_at: Date.now(),
      },
      action: {
        kind: actionKind,
        strategy: actionKind === "ignore" ? "none" : "cancel",
        terminated: actionKind !== "ignore",
      },
      reasons: trigger.reasons,
      fingerprints: trigger.fingerprints,
      pointers: {
        telemetry: this.options.telemetryPaths.eventsFile,
      },
    };

    await writeFile(
      path.join(stallDir, "event.json"),
      JSON.stringify(event, null, 2),
    );
  }
}

// ---------------------------------------------------------------------------
// NoProgressWatcher — probe-based stall detection
// ---------------------------------------------------------------------------

export class NoProgressWatcher {
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private options: StallWatcherOptions;
  private probeRunner: ProbeRunner;
  private lastDigest: string = "";
  private sameDigestCount: number = 0;
  private intervalMs: number;
  private stallThreshold: number;
  private probeLogPath: string;
  private captureStderr: boolean;
  private ignoreStallFired = false;
  private ignoreTerminalFired = false;
  private consecutiveProbeErrors = 0;
  private onProbeError: "ignore" | "stall" | "terminal";
  private probeErrorThreshold: number;

  constructor(options: StallWatcherOptions, cwd?: string, env?: Record<string, string>) {
    this.options = options;
    const probe = options.policy.probe;
    if (!probe) throw new Error("probe config is required for NoProgressWatcher");

    this.intervalMs = parseDuration(probe.interval);
    const probeTimeoutMs = probe.timeout ? parseDuration(probe.timeout) : 5000;
    this.stallThreshold = probe.stall_threshold;
    this.captureStderr = probe.capture_stderr ?? false;

    this.onProbeError = probe.on_probe_error ?? "ignore";
    this.probeErrorThreshold = probe.probe_error_threshold ?? 3;

    this.probeRunner = new ProbeRunner(
      probe.command,
      probeTimeoutMs,
      cwd,
      probe.require_zero_exit ?? false,
      env,
    );

    this.probeLogPath = path.join(
      options.contextDir,
      options.stepId,
      "_stall",
      "probe.jsonl",
    );
  }

  start(): void {
    this.scheduleNextProbe(0); // immediate first probe
  }

  private scheduleNextProbe(delayMs: number): void {
    this.timeoutId = setTimeout(async () => {
      await this.runProbe();
      if (!this.stopped) this.scheduleNextProbe(this.intervalMs);
    }, delayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private async runProbe(): Promise<void> {
    if (this.stopped) return;

    const result = await this.probeRunner.run();

    // Re-check after async — step may have completed during probe run.
    if (this.stopped) return;

    // Append to probe.jsonl (best-effort)
    await this.appendProbeLog(result);

    if (!result.success) {
      this.consecutiveProbeErrors++;
      if (this.onProbeError !== "ignore" && this.consecutiveProbeErrors >= this.probeErrorThreshold) {
        await this.triggerProbeError(result);
      }
      return;
    }

    // Probe succeeded — reset error counter.
    this.consecutiveProbeErrors = 0;

    const output = result.output!;

    // class=terminal → trigger on_terminal immediately
    if (output.class === "terminal") {
      const terminalAction = this.options.policy.on_terminal?.action ?? "interrupt";
      if (terminalAction !== "ignore") this.stop();
      await this.triggerTerminal(output, result);
      return;
    }

    // class=progressing → reset the no-progress counter
    if (output.class === "progressing") {
      this.lastDigest = result.digest;
      this.sameDigestCount = 0;
      return;
    }

    // Otherwise use digest equality for no-progress detection.
    if (result.digest === this.lastDigest) {
      this.sameDigestCount++;
    } else {
      this.lastDigest = result.digest;
      this.sameDigestCount = 1;
    }

    if (this.sameDigestCount >= this.stallThreshold) {
      const stallAction = this.options.policy.on_stall?.action ?? "interrupt";
      if (stallAction !== "ignore") this.stop();
      await this.triggerNoProgress(output, result);
    }
  }

  private async triggerNoProgress(
    output: NonNullable<ProbeResult["output"]>,
    _result: ProbeResult,
  ): Promise<void> {
    const action = this.options.policy.on_stall?.action ?? "interrupt";

    const trigger: StallTriggerResult = {
      kind: "no_progress",
      reason: `probe digest unchanged for ${this.sameDigestCount} intervals (threshold: ${this.stallThreshold})`,
      fingerprints: [
        "stall/no-progress",
        ...(this.options.policy.on_stall?.fingerprint_prefix ?? []),
        ...(output.fingerprints ?? []),
      ],
      reasons: [
        "probe digest unchanged",
        ...(output.reasons ?? []),
      ],
      probeData: output.summary,
    };

    if (action === "ignore") {
      if (!this.ignoreStallFired) {
        this.ignoreStallFired = true;
        await this.writeStallEvent(trigger, "no_progress");
        this.options.sink.emit({
          type: "warning",
          ts: Date.now(),
          message: `[sentinel] Step "${this.options.stepId}" stalled (ignored): ${trigger.reason}`,
          data: { trigger },
        });
      }
      // Reset counter so probe continues monitoring
      this.sameDigestCount = 0;
      return;
    }

    await this.writeStallEvent(trigger, "no_progress");

    this.options.sink.emit({
      type: "warning",
      ts: Date.now(),
      message: `[sentinel] Step "${this.options.stepId}" stalled: ${trigger.reason}`,
      data: { trigger },
    });

    this.options.onTrigger(trigger);
    this.options.abortStep();
  }

  private async triggerTerminal(
    output: NonNullable<ProbeResult["output"]>,
    _result: ProbeResult,
  ): Promise<void> {
    const action = this.options.policy.on_terminal?.action ?? "interrupt";

    const trigger: StallTriggerResult = {
      kind: "terminal",
      reason: "probe reported terminal condition",
      fingerprints: [
        "stall/terminal",
        ...(this.options.policy.on_terminal?.fingerprint_prefix ?? []),
        ...(output.fingerprints ?? []),
      ],
      reasons: [
        "probe classified as terminal",
        ...(output.reasons ?? []),
      ],
      probeData: output.summary,
    };

    if (action === "ignore") {
      if (!this.ignoreTerminalFired) {
        this.ignoreTerminalFired = true;
        await this.writeStallEvent(trigger, "terminal");
        this.options.sink.emit({
          type: "warning",
          ts: Date.now(),
          message: `[sentinel] Step "${this.options.stepId}" terminal (ignored): ${trigger.reason}`,
          data: { trigger },
        });
      }
      // Continue watching — don't stop, don't call onTrigger or abortStep
      return;
    }

    await this.writeStallEvent(trigger, "terminal");

    this.options.sink.emit({
      type: "warning",
      ts: Date.now(),
      message: `[sentinel] Step "${this.options.stepId}" terminal: ${trigger.reason}`,
      data: { trigger },
    });

    this.options.onTrigger(trigger);
    this.options.abortStep();
  }

  private async triggerProbeError(lastResult: ProbeResult): Promise<void> {
    const kind = this.onProbeError === "terminal" ? "terminal" : "no_progress";
    const actionConfig = kind === "terminal"
      ? this.options.policy.on_terminal
      : this.options.policy.on_stall;
    const action = actionConfig?.action ?? "interrupt";

    const trigger: StallTriggerResult = {
      kind,
      reason: `probe failed ${this.consecutiveProbeErrors} consecutive times (threshold: ${this.probeErrorThreshold}): ${lastResult.error ?? "unknown error"}`,
      fingerprints: [
        `stall/probe-error`,
        ...(actionConfig?.fingerprint_prefix ?? []),
      ],
      reasons: [
        `probe consecutively failed ${this.consecutiveProbeErrors} times`,
        ...(lastResult.error ? [lastResult.error] : []),
      ],
    };

    if (action === "ignore") {
      await this.writeStallEvent(trigger, kind);
      this.options.sink.emit({
        type: "warning",
        ts: Date.now(),
        message: `[sentinel] Step "${this.options.stepId}" probe errors (ignored): ${trigger.reason}`,
        data: { trigger },
      });
      // Reset counter so monitoring continues
      this.consecutiveProbeErrors = 0;
      return;
    }

    this.stop();

    await this.writeStallEvent(trigger, kind);

    this.options.sink.emit({
      type: "warning",
      ts: Date.now(),
      message: `[sentinel] Step "${this.options.stepId}" probe errors: ${trigger.reason}`,
      data: { trigger },
    });

    this.options.onTrigger(trigger);
    this.options.abortStep();
  }

  private async appendProbeLog(result: ProbeResult): Promise<void> {
    try {
      const logDir = path.dirname(this.probeLogPath);
      await mkdir(logDir, { recursive: true });

      const entry: Record<string, unknown> = {
        ts: result.ts,
        digest: result.digest,
      };
      if (result.success && result.output?.summary) {
        entry.summary = result.output.summary;
      }
      if (result.error) {
        entry.error = result.error;
      }
      if (result.exitCode !== undefined) {
        entry.exitCode = result.exitCode;
      }
      if (result.stderr && this.captureStderr) {
        entry.stderr = result.stderr;
      }

      await appendFile(this.probeLogPath, JSON.stringify(entry) + "\n");
    } catch {
      // Best-effort: don't let log writing failure break the watcher.
    }
  }

  private async writeStallEvent(
    trigger: StallTriggerResult,
    triggerKind: "no_progress" | "terminal",
  ): Promise<void> {
    const stallDir = path.join(
      this.options.contextDir,
      this.options.stepId,
      "_stall",
    );
    await mkdir(stallDir, { recursive: true });

    const actionConfig = triggerKind === "terminal"
      ? this.options.policy.on_terminal
      : this.options.policy.on_stall;

    const actionKind = actionConfig?.action ?? "interrupt";
    const event = {
      schema: "roboppi.sentinel.stall.v1",
      workflow: {
        workflow_id: this.options.workflowId,
        name: this.options.workflowName,
      },
      step: {
        id: this.options.stepId,
        iteration: this.options.iteration,
        phase: this.options.phase,
      },
      trigger: {
        kind: trigger.kind,
        reason: trigger.reason,
        observed_at: Date.now(),
      },
      action: {
        kind: actionKind,
        strategy: actionKind === "ignore" ? "none" : "cancel",
        terminated: actionKind !== "ignore",
      },
      reasons: trigger.reasons,
      fingerprints: trigger.fingerprints,
      pointers: {
        probe_log: `${this.options.stepId}/_stall/probe.jsonl`,
        telemetry: this.options.telemetryPaths.eventsFile,
      },
    };

    await writeFile(
      path.join(stallDir, "event.json"),
      JSON.stringify(event, null, 2),
    );
  }
}
