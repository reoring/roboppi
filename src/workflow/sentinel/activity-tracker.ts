import type { ExecEvent } from "../../tui/exec-event.js";

export interface StepActivity {
  stepId: string;
  lastWorkerOutputTs: number;
  lastStepPhaseTs: number;
  lastStepStateTs: number;
  hasReceivedWorkerEvent: boolean;
}

export class ActivityTracker {
  private activities = new Map<string, StepActivity>();

  /** Register a step for activity tracking. */
  register(stepId: string, startTs: number): void {
    this.activities.set(stepId, {
      stepId,
      lastWorkerOutputTs: startTs,
      lastStepPhaseTs: startTs,
      lastStepStateTs: startTs,
      hasReceivedWorkerEvent: false,
    });
  }

  /** Unregister a step (when it finishes). */
  unregister(stepId: string): void {
    this.activities.delete(stepId);
  }

  /** Update timestamps based on an incoming event. */
  onEvent(event: ExecEvent): void {
    switch (event.type) {
      case "worker_event": {
        const act = this.activities.get(event.stepId);
        if (act) {
          act.lastWorkerOutputTs = event.ts;
          act.hasReceivedWorkerEvent = true;
        }
        break;
      }
      case "step_phase": {
        const act = this.activities.get(event.stepId);
        if (act) act.lastStepPhaseTs = event.at;
        break;
      }
      case "step_state": {
        // step_state events don't carry a ts/at field (unlike worker_event
        // and step_phase), so Date.now() is the only available timestamp.
        const act = this.activities.get(event.stepId);
        if (act) act.lastStepStateTs = Date.now();
        break;
      }
    }
  }

  /** Get activity info for a step (or undefined if not tracked). */
  get(stepId: string): StepActivity | undefined {
    return this.activities.get(stepId);
  }

  /** Get all currently tracked steps. */
  allActive(): StepActivity[] {
    return [...this.activities.values()];
  }
}
