import { generateId, now } from "../../types/index.js";
import { WorkerKind, WorkerCapability, WorkerStatus } from "../../types/index.js";
import type { WorkerTask } from "../../types/index.js";
import type { WorkerResult, Artifact, Observation } from "../../types/index.js";
import type { WorkerAdapter, WorkerHandle, WorkerEvent } from "../worker-adapter.js";
import { ProcessManager } from "../process-manager.js";
import type { ManagedProcess } from "../process-manager.js";

export interface CodexCliAdapterConfig {
  codexCommand?: string;
  defaultArgs?: string[];
  gracePeriodMs?: number;
}

interface ActiveProcess {
  managed: ManagedProcess;
  startedAt: number;
  collectedStdout: string[];
  streamConsumed: boolean;
}

export class CodexCliAdapter implements WorkerAdapter {
  readonly kind = WorkerKind.CODEX_CLI;
  private readonly config: Required<CodexCliAdapterConfig>;
  private readonly processManager: ProcessManager;
  private readonly activeProcesses = new Map<string, ActiveProcess>();

  constructor(
    processManager: ProcessManager,
    config: CodexCliAdapterConfig = {},
  ) {
    this.processManager = processManager;
    this.config = {
      codexCommand: config.codexCommand ?? "codex",
      defaultArgs: config.defaultArgs ?? [],
      gracePeriodMs: config.gracePeriodMs ?? 5000,
    };
  }

  async startTask(task: WorkerTask): Promise<WorkerHandle> {
    const command = this.buildCommand(task);
    const startedAt = now();

    // Convert deadline to timeout for ProcessManager
    const currentTime = Date.now();
    const timeoutMs = task.budget.deadlineAt > currentTime
      ? task.budget.deadlineAt - currentTime
      : undefined;

    const managed = this.processManager.spawn({
      command,
      cwd: task.workspaceRef,
      abortSignal: task.abortSignal,
      timeoutMs,
    });

    const handle: WorkerHandle = {
      handleId: generateId(),
      workerKind: WorkerKind.CODEX_CLI,
      abortSignal: task.abortSignal,
    };

    this.activeProcesses.set(handle.handleId, {
      managed,
      startedAt,
      collectedStdout: [],
      streamConsumed: false,
    });

    return handle;
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

  async cancel(handle: WorkerHandle): Promise<void> {
    const active = this.activeProcesses.get(handle.handleId);
    if (!active) return;

    await this.processManager.gracefulShutdown(
      active.managed.pid,
      this.config.gracePeriodMs,
    );
  }

  async awaitResult(handle: WorkerHandle): Promise<WorkerResult> {
    const active = this.activeProcesses.get(handle.handleId);
    if (!active) {
      return {
        status: WorkerStatus.FAILED,
        artifacts: [],
        observations: [],
        cost: { wallTimeMs: 0 },
        durationMs: 0,
      };
    }

    const { managed, startedAt } = active;

    // Get stdout: from collected data if streamEvents consumed the stream, otherwise read directly
    let stdout = "";
    if (active.streamConsumed) {
      stdout = active.collectedStdout.join("\n");
    } else {
      const stdoutChunks: string[] = [];
      const decoder = new TextDecoder();
      const reader = managed.stdout.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stdoutChunks.push(decoder.decode(value, { stream: true }));
        }
      } catch {
        // Stream may already be consumed by streamEvents
      } finally {
        reader.releaseLock();
      }
      stdout = stdoutChunks.join("");
    }

    const exitCode = await managed.exitPromise;
    const wallTimeMs = now() - startedAt;

    this.activeProcesses.delete(handle.handleId);

    const artifacts = this.parseArtifacts(stdout);
    const observations = this.parseObservations(stdout);

    if (handle.abortSignal.aborted) {
      return {
        status: WorkerStatus.CANCELLED,
        artifacts,
        observations,
        cost: { wallTimeMs },
        durationMs: wallTimeMs,
      };
    }

    return {
      status: exitCode === 0 ? WorkerStatus.SUCCEEDED : WorkerStatus.FAILED,
      artifacts,
      observations,
      cost: { wallTimeMs },
      durationMs: wallTimeMs,
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

  private parseArtifacts(stdout: string): Artifact[] {
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

  private parseObservations(stdout: string): Observation[] {
    if (!stdout.trim()) return [];

    return [
      {
        summary: stdout.trim().slice(0, 1000),
      },
    ];
  }
}
