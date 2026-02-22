import type { ExecEventSink, ExecEvent } from "./exec-event.js";

export class NoopExecEventSink implements ExecEventSink {
  emit(_event: ExecEvent): void {
    // intentionally empty
  }
}
