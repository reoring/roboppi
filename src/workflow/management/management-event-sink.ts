import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ExecEvent, ExecEventSink } from "../../tui/exec-event.js";

/**
 * Dedicated sink for management worker executions.
 *
 * Writes worker events/results to `_management/inv/<hookId>/worker.jsonl` for
 * debugging, but does not forward anything to the main sink.
 */
export class ManagementEventSink implements ExecEventSink {
  private readonly outPath: string;
  private initPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(invDir: string) {
    this.outPath = path.join(invDir, "worker.jsonl");
  }

  emit(event: ExecEvent): void {
    // Fire-and-forget; serialize writes to avoid file corruption.
    this.writeChain = this.writeChain
      .then(() => this.ensureInit())
      .then(() => appendFile(this.outPath, JSON.stringify(event) + "\n"))
      .catch(() => {});
  }

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = mkdir(path.dirname(this.outPath), { recursive: true }).then(() => {});
    }
    return this.initPromise;
  }
}
