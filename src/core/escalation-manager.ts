import { now } from "../types/index.js";
import type { EscalationEvent } from "../types/index.js";
import { EscalationScope, EscalationAction } from "../types/index.js";

export interface EscalationManagerConfig {
  crashThreshold: number; // N crashes per minute to trigger FATAL
  cancelTimeoutMs: number; // how long cancel should take before ghost detection
  latestWinsThreshold: number; // max latest-wins on same workspace
}

const DEFAULT_CONFIG: EscalationManagerConfig = {
  crashThreshold: 5,
  cancelTimeoutMs: 30000,
  latestWinsThreshold: 3,
};

interface TimestampedEvent {
  timestamp: number;
}

export class EscalationManager {
  private readonly config: EscalationManagerConfig;
  private readonly workerCrashes = new Map<string, TimestampedEvent[]>();
  private readonly cancelTimeouts = new Map<string, number>();
  private readonly latestWinsCounts = new Map<string, number>();
  private readonly history: EscalationEvent[] = [];
  private readonly listeners: Array<(event: EscalationEvent) => void> = [];

  constructor(config?: Partial<EscalationManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  recordWorkerCrash(workerKind: string): void {
    const crashes = this.workerCrashes.get(workerKind) ?? [];
    crashes.push({ timestamp: now() });
    this.workerCrashes.set(workerKind, crashes);
  }

  recordCancelTimeout(workerKind: string): void {
    const count = this.cancelTimeouts.get(workerKind) ?? 0;
    this.cancelTimeouts.set(workerKind, count + 1);
  }

  recordLatestWins(workspaceRef: string): void {
    const count = this.latestWinsCounts.get(workspaceRef) ?? 0;
    this.latestWinsCounts.set(workspaceRef, count + 1);
  }

  onEscalation(callback: (event: EscalationEvent) => void): void {
    this.listeners.push(callback);
  }

  evaluate(): EscalationEvent[] {
    const events: EscalationEvent[] = [];
    const timestamp = now();
    const windowStart = timestamp - 60_000; // 1-minute sliding window

    // Snapshot cancelTimeouts before clearing (needed for global check below)
    const cancelTimeoutsSnapshot = new Map(this.cancelTimeouts);

    // Check worker crash rates (per worker kind)
    for (const [workerKind, crashes] of Array.from(this.workerCrashes.entries())) {
      // Trim old entries: keep only entries within the evaluation window
      const recentCrashes = crashes.filter((c) => c.timestamp > windowStart);
      this.workerCrashes.set(workerKind, recentCrashes);

      if (recentCrashes.length >= this.config.crashThreshold) {
        events.push({
          scope: EscalationScope.WORKER_KIND,
          action: EscalationAction.ISOLATE,
          target: workerKind,
          reason: `Worker ${workerKind} crashed ${recentCrashes.length} times in the last minute (threshold: ${this.config.crashThreshold})`,
          timestamp,
          severity: "error",
        });
      }
    }

    // Check cancel timeouts (ghost process detection)
    for (const [workerKind, count] of Array.from(cancelTimeoutsSnapshot.entries())) {
      if (count > 0) {
        events.push({
          scope: EscalationScope.WORKER_KIND,
          action: EscalationAction.ISOLATE,
          target: workerKind,
          reason: `Worker ${workerKind} has ${count} cancel timeout(s), possible ghost process`,
          timestamp,
          severity: "warning",
        });
      }
    }

    // Clear cancelTimeouts after processing
    this.cancelTimeouts.clear();

    // Check latest-wins thresholds (non-converging changes)
    for (const [workspaceRef, count] of Array.from(this.latestWinsCounts.entries())) {
      if (count >= this.config.latestWinsThreshold) {
        events.push({
          scope: EscalationScope.WORKSPACE,
          action: EscalationAction.STOP,
          target: workspaceRef,
          reason: `Workspace ${workspaceRef} had ${count} latest-wins replacements (threshold: ${this.config.latestWinsThreshold}), changes are not converging`,
          timestamp,
          severity: "error",
        });
      }
    }

    // Check for global-level escalation: multiple worker kinds failing
    const failingWorkerKinds = new Set<string>();
    for (const [workerKind, crashes] of Array.from(this.workerCrashes.entries())) {
      const recentCrashes = crashes.filter((c) => c.timestamp > windowStart);
      if (recentCrashes.length >= this.config.crashThreshold) {
        failingWorkerKinds.add(workerKind);
      }
    }
    for (const workerKind of Array.from(cancelTimeoutsSnapshot.keys())) {
      if ((cancelTimeoutsSnapshot.get(workerKind) ?? 0) > 0) {
        failingWorkerKinds.add(workerKind);
      }
    }
    if (failingWorkerKinds.size >= 2) {
      events.push({
        scope: EscalationScope.GLOBAL,
        action: EscalationAction.STOP,
        target: "system",
        reason: `Multiple worker kinds failing: ${Array.from(failingWorkerKinds).join(", ")}`,
        timestamp,
        severity: "fatal",
      });
    }

    // Record and notify
    for (const event of events) {
      this.history.push(event);
      for (const listener of this.listeners) {
        listener(event);
      }
    }

    return events;
  }

  getHistory(): EscalationEvent[] {
    return [...this.history];
  }

  reset(): void {
    this.workerCrashes.clear();
    this.cancelTimeouts.clear();
    this.latestWinsCounts.clear();
    this.history.length = 0;
  }
}
