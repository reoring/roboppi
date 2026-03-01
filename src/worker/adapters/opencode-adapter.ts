import { WorkerKind } from "../../types/index.js";
import type { WorkerTask } from "../../types/index.js";
import type { Artifact, Observation } from "../../types/index.js";
import type { WorkerEvent, WorkerHandle } from "../worker-adapter.js";
import type { ProcessManager } from "../process-manager.js";
import { BaseProcessAdapter } from "./base-process-adapter.js";

export interface OpenCodeAdapterConfig {
  openCodeCommand?: string;
  defaultArgs?: string[];
  gracePeriodMs?: number;
}

export function buildArgs(
  task: WorkerTask,
  config: Required<OpenCodeAdapterConfig>,
): string[] {
  const args: string[] = ["run", "--format", "json", ...config.defaultArgs];

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

  if (task.variant) {
    // If defaultArgs already specify a variant, prefer the task-level variant.
    const filtered: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--variant") {
        i++; // skip value
        continue;
      }
      if (a.startsWith("--variant=")) continue;
      filtered.push(a);
    }

    const effectiveVariant = (() => {
      // Convenience: accept xhigh/xlow as aliases for providers that don't support them.
      if (task.model?.startsWith("openai/") && task.variant === "xhigh") return "high";
      if (task.model?.startsWith("openai/") && task.variant === "xlow") return "minimal";
      return task.variant;
    })();

    filtered.push("--variant", effectiveVariant);
    args.length = 0;
    args.push(...filtered);
  }

  args.push(task.instructions);

  return args;
}

export class OpenCodeAdapter extends BaseProcessAdapter {
  readonly kind = WorkerKind.OPENCODE;

  private readonly config: Required<OpenCodeAdapterConfig>;

  constructor(processManager: ProcessManager, config: OpenCodeAdapterConfig = {}) {
    super(processManager, config.gracePeriodMs ?? 5000);
    this.config = {
      openCodeCommand: config.openCodeCommand ?? "opencode",
      defaultArgs: config.defaultArgs ?? [],
      gracePeriodMs: config.gracePeriodMs ?? 5000,
    };
  }

  buildCommand(task: WorkerTask): string[] {
    const args = buildArgs(task, this.config);
    return [this.config.openCodeCommand, ...args];
  }

  async cancel(handle: WorkerHandle): Promise<void> {
    const active = this.activeProcesses.get(handle.handleId);
    if (!active) return;

    await this.processManager.gracefulShutdown(active.managed.pid, this.gracePeriodMs);
    this.activeProcesses.delete(handle.handleId);
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
            if (line) {
              stderrLines.push(line);
              active.collectedStderr.push(line);
            }
          }
        }
        if (buffer) {
          stderrLines.push(buffer);
          active.collectedStderr.push(buffer);
        }
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

  protected parseArtifacts(stdout: string): Artifact[] {
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

  protected parseObservations(stdout: string): Observation[] {
    const observations: Observation[] = [];

    // Completion checks rely on parsing explicit markers from worker output.
    // Preserve marker lines even when stdout is large or mostly structured JSON.
    const markerRe = /\b(?:INCOMPLETE|COMPLETE|FAIL(?:ED)?)\b/i;

    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Capture explicit marker lines even when they are not JSON.
      if (markerRe.test(trimmed)) {
        observations.push({ summary: trimmed });
        continue;
      }

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
        // Not JSON
      }
    }

    const trimmedStdout = stdout.trim();
    if (!trimmedStdout) return observations;

    // If markers exist in stdout but didn't end up in observations (e.g. marker printed
    // as plain text after JSON output), add a bounded tail snippet to preserve it.
    if (markerRe.test(trimmedStdout) && !observations.some((o) => o.summary && markerRe.test(o.summary))) {
      observations.push({ summary: summarizeTail(trimmedStdout, 4000) });
    }

    // If no structured observations found, include a bounded summary with head+tail.
    if (observations.length === 0) {
      observations.push({ summary: summarizeHeadTail(trimmedStdout, 4000) });
    }

    return observations;
  }
}

function summarizeHeadTail(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;

  const head = trimmed.slice(0, 1000);
  const tail = trimmed.slice(-1000);
  return `${head}\n...\n${tail}`;
}

function summarizeTail(text: string, maxChars: number): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "";

  const maxLines = 120;
  const out: string[] = [];
  let total = 0;

  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const line = lines[i]!;
    const add = out.length === 0 ? line.length : line.length + 1;
    if (total + add > maxChars) break;
    out.unshift(line);
    total += add;
  }

  return out.join("\n");
}
