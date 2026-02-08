import { generateId, WorkerStatus } from "../../types/index.js";
import type { WorkerTask, WorkerResult } from "../../types/index.js";
import { WorkerKind, WorkerCapability } from "../../types/index.js";
import type {
  WorkerAdapter,
  WorkerHandle,
  WorkerEvent,
} from "../worker-adapter.js";
import { ProcessManager } from "../process-manager.js";
import type { ManagedProcess } from "../process-manager.js";

export interface ClaudeCodeAdapterConfig {
  claudeCommand?: string;
  defaultArgs?: string[];
  gracePeriodMs?: number;
  outputFormat?: "json" | "text";
}

interface InternalHandle extends WorkerHandle {
  process: ManagedProcess;
  startTime: number;
  collectedStdout: string[];
  collectedEvents: WorkerEvent[];
  streamConsumed: boolean;
}

export function mapCapabilitiesToAllowedTools(
  capabilities: WorkerCapability[]
): string[] {
  const tools: string[] = [];
  for (const cap of capabilities) {
    switch (cap) {
      case WorkerCapability.READ:
        tools.push("View", "Read", "Glob", "Grep");
        break;
      case WorkerCapability.EDIT:
        tools.push("Edit", "Write", "NotebookEdit");
        break;
      case WorkerCapability.RUN_TESTS:
        tools.push("Bash(npm test:*)", "Bash(bun test:*)", "Bash(jest:*)", "Bash(pytest:*)");
        break;
      case WorkerCapability.RUN_COMMANDS:
        tools.push("Bash");
        break;
    }
  }
  return [...new Set(tools)];
}

export function buildArgs(
  task: WorkerTask,
  config: Required<ClaudeCodeAdapterConfig>
): string[] {
  const args: string[] = [...config.defaultArgs];

  // Non-interactive print mode with instructions
  args.push("--print", task.instructions);

  // Output format
  if (config.outputFormat === "json") {
    args.push("--output-format", "json");
  }

  // Allowed tools from capabilities
  const allowedTools = mapCapabilitiesToAllowedTools(task.capabilities);
  if (allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }

  // Max turns from budget
  if (task.budget.maxSteps !== undefined) {
    args.push("--max-turns", String(task.budget.maxSteps));
  }

  return args;
}

export class ClaudeCodeAdapter implements WorkerAdapter {
  readonly kind = WorkerKind.CLAUDE_CODE;
  private readonly config: Required<ClaudeCodeAdapterConfig>;
  private readonly processManager: ProcessManager;
  private readonly handles = new Map<string, InternalHandle>();

  constructor(
    config: ClaudeCodeAdapterConfig = {},
    processManager?: ProcessManager
  ) {
    this.config = {
      claudeCommand: config.claudeCommand ?? "claude",
      defaultArgs: config.defaultArgs ?? [],
      gracePeriodMs: config.gracePeriodMs ?? 5000,
      outputFormat: config.outputFormat ?? "json",
    };
    this.processManager = processManager ?? new ProcessManager();
  }

  async startTask(task: WorkerTask): Promise<WorkerHandle> {
    const args = buildArgs(task, this.config);
    const command = [this.config.claudeCommand, ...args];

    // Convert deadline to timeout for ProcessManager
    const now = Date.now();
    const timeoutMs = task.budget.deadlineAt > now
      ? task.budget.deadlineAt - now
      : undefined;

    const managed = this.processManager.spawn({
      command,
      cwd: task.workspaceRef,
      abortSignal: task.abortSignal,
      timeoutMs,
    });

    const handle: InternalHandle = {
      handleId: generateId(),
      workerKind: task.workerKind,
      abortSignal: task.abortSignal,
      process: managed,
      startTime: Date.now(),
      collectedStdout: [],
      collectedEvents: [],
      streamConsumed: false,
    };

    this.handles.set(handle.handleId, handle);
    return handle;
  }

  async *streamEvents(handle: WorkerHandle): AsyncIterable<WorkerEvent> {
    const internal = this.handles.get(handle.handleId);
    if (!internal) return;

    internal.streamConsumed = true;

    const stdoutReader = internal.process.stdout.getReader();
    const stderrReader = internal.process.stderr.getReader();
    const decoder = new TextDecoder();

    // Read stderr in background, collect events
    const stderrEvents: WorkerEvent[] = [];
    const stderrDone = (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          stderrEvents.push({ type: "stderr", data: text });
        }
      } catch {
        // Stream may be closed
      }
    })();

    // Yield stdout events and collect raw stdout for awaitResult
    let stdoutBuffer = "";
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });

        if (this.config.outputFormat === "json") {
          stdoutBuffer += chunk;
          const lines = stdoutBuffer.split("\n");
          // Keep the last incomplete line in the buffer
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            internal.collectedStdout.push(trimmed);
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed.type === "result" && parsed.result) {
                yield { type: "stdout", data: JSON.stringify(parsed) };
              } else if (parsed.type === "assistant" && parsed.message) {
                yield {
                  type: "progress",
                  message:
                    typeof parsed.message === "string"
                      ? parsed.message
                      : JSON.stringify(parsed.message),
                };
              } else {
                yield { type: "stdout", data: trimmed };
              }
            } catch {
              yield { type: "stdout", data: trimmed };
            }
          }
        } else {
          internal.collectedStdout.push(chunk);
          yield { type: "stdout", data: chunk };
        }
      }

      // Flush remaining buffer
      if (stdoutBuffer.trim()) {
        internal.collectedStdout.push(stdoutBuffer.trim());
        yield { type: "stdout", data: stdoutBuffer.trim() };
      }
    } catch {
      // Stream may be closed due to cancellation
    }

    await stderrDone;
    for (const event of stderrEvents) {
      internal.collectedEvents.push(event);
      yield event;
    }
  }

  async cancel(handle: WorkerHandle): Promise<void> {
    const internal = this.handles.get(handle.handleId);
    if (!internal) return;

    await this.processManager.gracefulShutdown(
      internal.process.pid,
      this.config.gracePeriodMs
    );
  }

  async awaitResult(handle: WorkerHandle): Promise<WorkerResult> {
    const internal = this.handles.get(handle.handleId);
    if (!internal) {
      return {
        status: WorkerStatus.FAILED,
        artifacts: [],
        observations: [],
        cost: { wallTimeMs: 0 },
        durationMs: 0,
      };
    }

    const exitCode = await internal.process.exitPromise;
    const wallTimeMs = Date.now() - internal.startTime;

    // Get stdout: from collected data if streamEvents consumed the stream, otherwise read directly
    let stdout = "";
    if (internal.streamConsumed) {
      stdout = internal.collectedStdout.join("\n");
    } else {
      try {
        stdout = await new Response(internal.process.stdout).text();
      } catch {
        // stdout may already have been consumed
      }
    }

    // Clean up handle
    this.handles.delete(handle.handleId);

    // Determine status from exit code
    if (handle.abortSignal.aborted) {
      return {
        status: WorkerStatus.CANCELLED,
        artifacts: [],
        observations: [],
        cost: { wallTimeMs },
        durationMs: wallTimeMs,
      };
    }

    if (exitCode !== 0) {
      return {
        status: WorkerStatus.FAILED,
        artifacts: [],
        observations: [],
        cost: { wallTimeMs },
        durationMs: wallTimeMs,
      };
    }

    // Parse structured output for artifacts and observations
    const { artifacts, observations, estimatedTokens } =
      this.parseOutput(stdout);

    return {
      status: WorkerStatus.SUCCEEDED,
      artifacts,
      observations,
      cost: {
        wallTimeMs,
        estimatedTokens: estimatedTokens ?? undefined,
      },
      durationMs: wallTimeMs,
    };
  }

  private parseOutput(stdout: string): {
    artifacts: WorkerResult["artifacts"];
    observations: WorkerResult["observations"];
    estimatedTokens: number | undefined;
  } {
    const artifacts: WorkerResult["artifacts"] = [];
    const observations: WorkerResult["observations"] = [];
    let estimatedTokens: number | undefined;

    if (this.config.outputFormat !== "json" || !stdout.trim()) {
      if (stdout.trim()) {
        observations.push({ summary: stdout.trim() });
      }
      return { artifacts, observations, estimatedTokens };
    }

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);

        if (parsed.type === "result" && parsed.result) {
          // Extract cost info
          if (parsed.usage) {
            estimatedTokens =
              (parsed.usage.input_tokens ?? 0) +
              (parsed.usage.output_tokens ?? 0);
          }
          if (parsed.result) {
            observations.push({
              summary:
                typeof parsed.result === "string"
                  ? parsed.result
                  : JSON.stringify(parsed.result),
            });
          }
        }

        // Track file changes as artifacts
        if (parsed.type === "tool_use" || parsed.tool === "Edit" || parsed.tool === "Write") {
          const filePath = parsed.file_path ?? parsed.filePath ?? parsed.path;
          if (filePath) {
            artifacts.push({
              type: "file_change",
              ref: filePath,
            });
          }
        }
      } catch {
        // Not JSON, treat as plain observation
        if (trimmed) {
          observations.push({ summary: trimmed });
        }
      }
    }

    return { artifacts, observations, estimatedTokens };
  }
}
