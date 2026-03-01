import { WorkerStatus, ErrorClass } from "../../types/index.js";
import { WorkerKind, WorkerCapability, OutputMode } from "../../types/index.js";
import type { WorkerTask } from "../../types/index.js";
import type { WorkerResult, Artifact, Observation } from "../../types/index.js";
import type { WorkerEvent, WorkerHandle } from "../worker-adapter.js";
import { ProcessManager } from "../process-manager.js";
import { BaseProcessAdapter } from "./base-process-adapter.js";

export interface ClaudeCodeAdapterConfig {
  claudeCommand?: string;
  defaultArgs?: string[];
  gracePeriodMs?: number;
  outputFormat?: "json" | "text" | "stream-json";
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

  if (task.model) {
    // If defaultArgs already specify a model, prefer the task-level model.
    const filtered: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--model") {
        i++; // skip value
        continue;
      }
      if (a.startsWith("--model=")) continue;
      filtered.push(a);
    }
    filtered.push("--model", task.model);
    args.length = 0;
    args.push(...filtered);
  }

  // Non-interactive print mode with instructions
  args.push("--print", task.instructions);

  // Output format
  // - For streaming tasks (TUI), prefer Claude's `stream-json` to emit events
  //   incrementally; otherwise logs can be empty until the process exits.
  // - Preserve legacy config behavior for non-streaming tasks.
  const effectiveOutputFormat =
    config.outputFormat === "json" && task.outputMode === OutputMode.STREAM
      ? "stream-json"
      : config.outputFormat;

  if (effectiveOutputFormat === "json") {
    args.push("--output-format", "json");
  } else if (effectiveOutputFormat === "stream-json") {
    args.push("--output-format", "stream-json");
    // Claude CLI requires --verbose when using --print with stream-json.
    args.push("--verbose");
    // Best-effort: include partial chunks so the TUI gets incremental updates.
    args.push("--include-partial-messages");
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

export class ClaudeCodeAdapter extends BaseProcessAdapter {
  readonly kind = WorkerKind.CLAUDE_CODE;
  private readonly config: Required<ClaudeCodeAdapterConfig>;

  constructor(
    config: ClaudeCodeAdapterConfig = {},
    processManager?: ProcessManager
  ) {
    super(processManager ?? new ProcessManager(), config.gracePeriodMs ?? 5000);
    this.config = {
      claudeCommand: config.claudeCommand ?? "claude",
      defaultArgs: config.defaultArgs ?? [],
      gracePeriodMs: config.gracePeriodMs ?? 5000,
      outputFormat: config.outputFormat ?? "json",
    };
  }

  buildCommand(task: WorkerTask): string[] {
    const args = buildArgs(task, this.config);
    return [this.config.claudeCommand, ...args];
  }

  async *streamEvents(handle: WorkerHandle): AsyncIterable<WorkerEvent> {
    const active = this.activeProcesses.get(handle.handleId);
    if (!active) return;

    active.streamConsumed = true;

    const stdoutReader = active.managed.stdout.getReader();
    const stderrReader = active.managed.stderr.getReader();
    const decoder = new TextDecoder();

    // Read stderr in background, collect events
    const stderrEvents: WorkerEvent[] = [];
    const stderrDone = (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          active.collectedStderr.push(text);
          stderrEvents.push({ type: "stderr", data: text });
        }
      } catch {
        // Stream may be closed
      } finally {
        try {
          stderrReader.releaseLock();
        } catch {
          // ignore
        }
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
            active.collectedStdout.push(trimmed);
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
          active.collectedStdout.push(chunk);
          yield { type: "stdout", data: chunk };
        }
      }

      // Flush remaining buffer
      if (stdoutBuffer.trim()) {
        active.collectedStdout.push(stdoutBuffer.trim());
        yield { type: "stdout", data: stdoutBuffer.trim() };
      }
    } catch {
      // Stream may be closed due to cancellation
    } finally {
      try {
        stdoutReader.releaseLock();
      } catch {
        // ignore
      }
    }

    await stderrDone;
    for (const event of stderrEvents) {
      yield event;
    }
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

    const exitCode = await active.managed.exitPromise;
    const wallTimeMs = Date.now() - active.startedAt;

    // Get stdout/stderr: from collected data if streamEvents consumed the stream, otherwise read directly
    let stdout = "";
    let stderr = "";
    if (active.streamConsumed) {
      stdout = active.collectedStdout.join("\n");
      stderr = active.collectedStderr.join("\n");
    } else {
      try {
        stdout = await new Response(active.managed.stdout).text();
      } catch {
        // stdout may already have been consumed
      }
      try {
        stderr = await new Response(active.managed.stderr).text();
      } catch {
        // stderr may already have been consumed
      }
    }

    // Clean up handle
    this.activeProcesses.delete(handle.handleId);

    // Determine status from exit code
    if (handle.abortSignal.aborted) {
      return {
        status: WorkerStatus.CANCELLED,
        artifacts: [],
        observations: buildStderrObservations(stderr),
        cost: { wallTimeMs },
        durationMs: wallTimeMs,
        exitCode,
        errorClass: ErrorClass.RETRYABLE_TRANSIENT,
      };
    }

    if (exitCode !== 0) {
      const errorClass = this.classifyExitCode(exitCode, stdout);
      return {
        status: WorkerStatus.FAILED,
        artifacts: [],
        observations: buildStderrObservations(stderr),
        cost: { wallTimeMs },
        durationMs: wallTimeMs,
        exitCode,
        errorClass,
      };
    }

    // Parse structured output for artifacts and observations
    const { artifacts, observations: parsedObservations, estimatedTokens } =
      this.parseOutput(stdout);

    const observations = parsedObservations;
    const stderrObs = buildStderrObservations(stderr);

    return {
      status: WorkerStatus.SUCCEEDED,
      artifacts,
      observations: [...observations, ...stderrObs],
      cost: {
        wallTimeMs,
        estimatedTokens: estimatedTokens ?? undefined,
      },
      durationMs: wallTimeMs,
      exitCode,
    };
  }

  protected parseArtifacts(stdout: string): Artifact[] {
    // Used by base class awaitResult — but ClaudeCodeAdapter overrides awaitResult
    // so this is only needed for consistency. Delegate to parseOutput.
    return this.parseOutput(stdout).artifacts;
  }

  protected parseObservations(stdout: string): Observation[] {
    return this.parseOutput(stdout).observations;
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

function buildStderrObservations(stderr: string): Observation[] {
  const trimmed = stderr.trim();
  if (!trimmed) return [];

  const max = 2000;
  if (trimmed.length <= max) {
    return [{ summary: `[stderr]\n${trimmed}` }];
  }

  const head = trimmed.slice(0, 800);
  const tail = trimmed.slice(-800);
  return [{ summary: `[stderr]\n${head}\n...\n${tail}` }];
}
