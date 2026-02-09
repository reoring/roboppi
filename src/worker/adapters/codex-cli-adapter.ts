import { WorkerKind, WorkerCapability } from "../../types/index.js";
import type { WorkerTask } from "../../types/index.js";
import type { Artifact, Observation } from "../../types/index.js";
import type { WorkerEvent, WorkerHandle } from "../worker-adapter.js";
import type { ProcessManager } from "../process-manager.js";
import { BaseProcessAdapter } from "./base-process-adapter.js";

export interface CodexCliAdapterConfig {
  codexCommand?: string;
  defaultArgs?: string[];
  gracePeriodMs?: number;
}

export class CodexCliAdapter extends BaseProcessAdapter {
  readonly kind = WorkerKind.CODEX_CLI;
  private readonly config: Required<CodexCliAdapterConfig>;

  constructor(
    processManager: ProcessManager,
    config: CodexCliAdapterConfig = {},
  ) {
    super(processManager, config.gracePeriodMs ?? 5000);
    this.config = {
      codexCommand: config.codexCommand ?? "codex",
      defaultArgs: config.defaultArgs ?? [],
      gracePeriodMs: config.gracePeriodMs ?? 5000,
    };
  }

  buildCommand(task: WorkerTask): string[] {
    const args: string[] = [this.config.codexCommand, ...this.config.defaultArgs];

    // Map capabilities to approval mode
    const hasWrite = task.capabilities.includes(WorkerCapability.EDIT);
    const hasRunCommands = task.capabilities.includes(WorkerCapability.RUN_COMMANDS);

    if (hasWrite && hasRunCommands) {
      args.push("--approval-mode=full-auto");
    } else if (hasWrite) {
      args.push("--approval-mode=auto-edit");
    }

    // Pass instructions via --prompt
    args.push("--prompt", task.instructions);

    return args;
  }

  async *streamEvents(handle: WorkerHandle): AsyncIterable<WorkerEvent> {
    const active = this.activeProcesses.get(handle.handleId);
    if (!active) return;

    active.streamConsumed = true;
    const { managed } = active;

    // Collect events from both streams into a shared queue
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
            // Flush remaining buffer
            if (buffer) {
              if (source === "stdout") {
                active.collectedStdout.push(buffer);
                for (const ev of this.parseStdoutLine(buffer)) {
                  enqueue(ev);
                }
              } else {
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
              for (const ev of this.parseStdoutLine(line)) {
                enqueue(ev);
              }
            } else if (line) {
              enqueue({ type: "stderr", data: line });
            }
          }
        }
      } catch {
        // Stream error, stop reading
      } finally {
        reader.releaseLock();
        markStreamDone();
      }
    };

    // Start reading both streams concurrently
    readStream(managed.stdout, "stdout");
    readStream(managed.stderr, "stderr");

    // Yield events as they arrive
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

  private *parseStdoutLine(line: string): Iterable<WorkerEvent> {
    if (!line) return;

    // Try parsing as JSON (structured codex output)
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        if (parsed.type === "patch" && parsed.filePath && parsed.diff) {
          yield { type: "patch", filePath: parsed.filePath, diff: parsed.diff };
          return;
        }
        if (parsed.type === "progress") {
          yield { type: "progress", message: parsed.message ?? "", percent: parsed.percent };
          return;
        }
      }
    } catch {
      // Not JSON, treat as plain stdout
    }

    yield { type: "stdout", data: line };
  }

  protected parseArtifacts(stdout: string): Artifact[] {
    const artifacts: Artifact[] = [];

    for (const line of stdout.split("\n")) {
      try {
        const parsed = JSON.parse(line);
        if (parsed?.type === "patch" && parsed.filePath) {
          artifacts.push({
            type: "patch",
            ref: parsed.filePath,
            content: parsed.diff,
          });
        }
      } catch {
        // Not JSON
      }
    }

    // Also detect unified diff blocks in plain text
    const diffPattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
    let match;
    while ((match = diffPattern.exec(stdout)) !== null) {
      artifacts.push({
        type: "diff",
        ref: match[2]!,
      });
    }

    return artifacts;
  }

  protected parseObservations(stdout: string): Observation[] {
    if (!stdout.trim()) return [];

    return [
      {
        summary: stdout.trim().slice(0, 1000),
      },
    ];
  }
}
