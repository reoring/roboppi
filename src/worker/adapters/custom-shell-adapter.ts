import type { WorkerTask } from "../../types/index.js";
import type { Artifact, Observation } from "../../types/index.js";
import type { WorkerEvent, WorkerHandle } from "../worker-adapter.js";
import type { ProcessManager } from "../process-manager.js";

import { WorkerKind } from "../../types/index.js";
import { BaseProcessAdapter } from "./base-process-adapter.js";

export interface CustomShellAdapterConfig {
  bashCommand?: string;
  defaultArgs?: string[];
  gracePeriodMs?: number;
}

/**
 * Executes CUSTOM steps by running `instructions` as a bash script.
 *
 * This keeps CUSTOM execution under Core in supervised mode.
 */
export class CustomShellAdapter extends BaseProcessAdapter {
  readonly kind = WorkerKind.CUSTOM;
  private readonly config: Required<CustomShellAdapterConfig>;

  constructor(processManager: ProcessManager, config: CustomShellAdapterConfig = {}) {
    super(processManager, config.gracePeriodMs ?? 5000);
    this.config = {
      bashCommand: config.bashCommand ?? "bash",
      defaultArgs: config.defaultArgs ?? ["-e", "-c"],
      gracePeriodMs: config.gracePeriodMs ?? 5000,
    };
  }

  buildCommand(task: WorkerTask): string[] {
    return [this.config.bashCommand, ...this.config.defaultArgs, task.instructions];
  }

  async *streamEvents(handle: WorkerHandle): AsyncIterable<WorkerEvent> {
    const active = this.activeProcesses.get(handle.handleId);
    if (!active) return;

    active.streamConsumed = true;
    const { managed } = active;

    const queue: WorkerEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let pendingStreams = 2;

    const enqueue = (event: WorkerEvent) => {
      queue.push(event);
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    };

    const markStreamDone = () => {
      pendingStreams--;
      if (pendingStreams === 0) {
        done = true;
        if (resolve) {
          const r = resolve;
          resolve = null;
          r();
        }
      }
    };

    const readStream = async (
      stream: ReadableStream<Uint8Array>,
      source: "stdout" | "stderr",
    ) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) {
            if (buffer) {
            if (source === "stdout") {
              active.collectedStdout.push(buffer);
              enqueue({ type: "stdout", data: buffer });
            } else {
              active.collectedStderr.push(buffer);
              enqueue({ type: "stderr", data: buffer });
            }
            }
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.length > 0 ? (lines.pop() ?? "") : "";

          for (const line of lines) {
            if (source === "stdout") {
              active.collectedStdout.push(line);
              if (line) enqueue({ type: "stdout", data: line });
            } else if (line) {
              active.collectedStderr.push(line);
              enqueue({ type: "stderr", data: line });
            }
          }
        }
      } catch {
        // Stream error, stop reading.
      } finally {
        reader.releaseLock();
        markStreamDone();
      }
    };

    readStream(managed.stdout, "stdout");
    readStream(managed.stderr, "stderr");

    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else if (done) {
        break;
      } else {
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    }
  }

  protected parseArtifacts(_stdout: string): Artifact[] {
    return [];
  }

  protected parseObservations(stdout: string): Observation[] {
    const trimmed = stdout.trim();
    if (!trimmed) return [];

    const max = 4000;
    if (trimmed.length <= max) return [{ summary: trimmed }];

    const head = trimmed.slice(0, 1000);
    const tail = trimmed.slice(-1000);
    return [{ summary: `${head}\n...\n${tail}` }];
  }
}
