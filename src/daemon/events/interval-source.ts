import type { DaemonEvent } from "../types.js";
import type { EventSource } from "./event-source.js";
import { waitOrAbort } from "./event-source.js";
import { parseDuration } from "../../workflow/duration.js";
import type { DurationString } from "../../workflow/types.js";

export class IntervalSource implements EventSource {
  readonly id: string;
  private readonly intervalMs: number;
  private abortController = new AbortController();

  constructor(id: string, every: DurationString) {
    this.intervalMs = parseDuration(every);
    this.id = id;
  }

  async *events(): AsyncGenerator<DaemonEvent> {
    const signal = this.abortController.signal;

    while (!signal.aborted) {
      const aborted = await waitOrAbort(this.intervalMs, signal);
      if (aborted) break;

      yield {
        sourceId: this.id,
        timestamp: Date.now(),
        payload: {
          type: "interval",
          firedAt: Date.now(),
        },
      };
    }
  }

  async stop(): Promise<void> {
    this.abortController.abort();
  }
}
