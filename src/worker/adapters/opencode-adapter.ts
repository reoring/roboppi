import { generateId, now } from "../../types/index.js";
import { WorkerKind, WorkerStatus } from "../../types/index.js";
import type { WorkerTask } from "../../types/index.js";
import type { WorkerResult, Artifact, Observation } from "../../types/index.js";
import type {
  WorkerAdapter,
  WorkerHandle,
  WorkerEvent,
} from "../worker-adapter.js";
import type { ProcessManager, ManagedProcess } from "../process-manager.js";

export interface OpenCodeAdapterConfig {
  openCodeCommand?: string;
  defaultArgs?: string[];
  gracePeriodMs?: number;
}

interface ActiveProcess {
  managed: ManagedProcess;
  startedAt: number;
  collectedStdout: string[];
  streamConsumed: boolean;
}

export function buildArgs(
  task: WorkerTask,
  config: Required<OpenCodeAdapterConfig>,
): string[] {
  const args: string[] = ["run", "--format", "json", ...config.defaultArgs];

  args.push(task.instructions);

  return args;
}

export class OpenCodeAdapter implements WorkerAdapter {
  readonly kind = WorkerKind.OPENCODE;

  private readonly config: Required<OpenCodeAdapterConfig>;
  private readonly processManager: ProcessManager;
  private readonly activeProcesses = new Map<string, ActiveProcess>();

  constructor(processManager: ProcessManager, config: OpenCodeAdapterConfig = {}) {
    this.processManager = processManager;
    this.config = {
      openCodeCommand: config.openCodeCommand ?? "opencode",
      defaultArgs: config.defaultArgs ?? [],
      gracePeriodMs: config.gracePeriodMs ?? 5000,
    };
  }

  async startTask(task: WorkerTask): Promise<WorkerHandle> {
    const args = buildArgs(task, this.config);
    const command = [this.config.openCodeCommand, ...args];

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
      workerKind: WorkerKind.OPENCODE,
      abortSignal: task.abortSignal,
    };

    this.activeProcesses.set(handle.handleId, {
      managed,
      startedAt: now(),
      collectedStdout: [],
      streamConsumed: false,
    });

    return handle;
  }

  async *streamEvents(handle: WorkerHandle): AsyncIterable<WorkerEvent> {
    const active = this.activeProcesses.get(handle.handleId);
    if (!active) {
      return;
    }

    active.streamConsumed = true;
    const { managed } = active;

    const stdoutReader = managed.stdout.getReader();
    const stderrReader = managed.stderr.getReader();
    const decoder = new TextDecoder();

    // Read stderr in background, collect lines
    const stderrLines: string[] = [];
    const stderrDone = (async () => {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.length > 0 ? (lines.pop() ?? "") : "";
          for (const line of lines) {
            if (line) stderrLines.push(line);
          }
        }
        if (buffer) stderrLines.push(buffer);
      } catch {
        // Stream may close on abort
      } finally {
        stderrReader.releaseLock();
      }
    })();

    // Stream stdout line-by-line
    let stdoutBuffer = "";
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        stdoutBuffer += decoder.decode(value, { stream: true });
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.length > 0 ? (lines.pop() ?? "") : "";
        for (const line of lines) {
          if (!line) continue;
          active.collectedStdout.push(line);
          // Try to parse as structured JSON output
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "progress" && typeof parsed.message === "string") {
              yield { type: "progress", message: parsed.message, percent: parsed.percent };
              continue;
            }
            if (parsed.type === "patch" && parsed.filePath && parsed.diff) {
              yield { type: "patch", filePath: parsed.filePath, diff: parsed.diff };
              continue;
            }
          } catch {
            // Not JSON, treat as plain stdout
          }
          yield { type: "stdout", data: line };
        }
      }
      if (stdoutBuffer) {
        active.collectedStdout.push(stdoutBuffer);
        yield { type: "stdout", data: stdoutBuffer };
      }
    } catch {
      // Stream may close on abort
    } finally {
      stdoutReader.releaseLock();
    }

    // Wait for stderr collection to finish, then yield stderr events
    await stderrDone;
    for (const line of stderrLines) {
      yield { type: "stderr", data: line };
    }
  }

  async cancel(handle: WorkerHandle): Promise<void> {
    const active = this.activeProcesses.get(handle.handleId);
    if (!active) return;

    await this.processManager.gracefulShutdown(active.managed.pid, this.config.gracePeriodMs);
    this.activeProcesses.delete(handle.handleId);
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

    // Get stdout: from collected data if streamEvents consumed the stream, otherwise read directly
    let stdout = "";
    if (active.streamConsumed) {
      stdout = active.collectedStdout.join("\n");
    } else {
      const decoder = new TextDecoder();
      const reader = active.managed.stdout.getReader();
      const chunks: string[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(decoder.decode(value, { stream: true }));
        }
      } catch {
        // Stream may be closed
      } finally {
        reader.releaseLock();
      }
      stdout = chunks.join("");
    }

    const exitCode = await active.managed.exitPromise;
    const startTime = active.startedAt;
    const wallTimeMs = now() - startTime;

    this.activeProcesses.delete(handle.handleId);

    if (handle.abortSignal.aborted) {
      return {
        status: WorkerStatus.CANCELLED,
        artifacts: [],
        observations: [],
        cost: { wallTimeMs },
        durationMs: wallTimeMs,
      };
    }

    const status = exitCode === 0 ? WorkerStatus.SUCCEEDED : WorkerStatus.FAILED;
    const artifacts = this.parseArtifacts(stdout);
    const observations = this.parseObservations(stdout);

    return {
      status,
      artifacts,
      observations,
      cost: { wallTimeMs },
      durationMs: wallTimeMs,
    };
  }

  private parseArtifacts(stdout: string): Artifact[] {
    const artifacts: Artifact[] = [];

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type === "patch" && parsed.filePath) {
          artifacts.push({
            type: "patch",
            ref: parsed.filePath,
            content: parsed.diff,
          });
        }
        if (parsed?.type === "file_change" && parsed.path) {
          artifacts.push({
            type: "patch",
            ref: parsed.path,
          });
        }
      } catch {
        // Not JSON
      }
    }

    return artifacts;
  }

  private parseObservations(stdout: string): Observation[] {
    const observations: Observation[] = [];

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type === "result" && parsed.result) {
          observations.push({
            summary: typeof parsed.result === "string"
              ? parsed.result
              : JSON.stringify(parsed.result),
          });
          continue;
        }
        if (parsed?.type === "observation" && parsed.summary) {
          observations.push({
            summary: parsed.summary,
            command: parsed.command,
            filesChanged: parsed.filesChanged,
          });
          continue;
        }
      } catch {
        // Not JSON — treat as plain observation
      }
    }

    // If no structured observations found, use raw stdout summary
    if (observations.length === 0 && stdout.trim()) {
      observations.push({ summary: stdout.trim().slice(0, 1000) });
    }

    return observations;
  }
}
