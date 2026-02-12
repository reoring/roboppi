import { generateId, now, ErrorClass } from "../../types/index.js";
import { WorkerStatus } from "../../types/index.js";
import type { WorkerKind, WorkerTask } from "../../types/index.js";
import type { WorkerResult, Artifact, Observation } from "../../types/index.js";
import type { WorkerAdapter, WorkerHandle, WorkerEvent } from "../worker-adapter.js";
import type { ProcessManager, ManagedProcess } from "../process-manager.js";

export interface BaseProcessAdapterConfig {
  gracePeriodMs?: number;
}

export interface ActiveProcess {
  managed: ManagedProcess;
  startedAt: number;
  collectedStdout: string[];
  collectedStderr: string[];
  streamConsumed: boolean;
}

/**
 * Base class for process-based worker adapters. Provides common logic for:
 * - Process spawning via ProcessManager with deadline-to-timeout conversion
 * - Active process tracking with stdout collection
 * - streamConsumed tracking (for stream-then-await pattern)
 * - awaitResult: exit code handling, abort check, wall time calculation
 * - cancel via graceful shutdown
 *
 * Subclasses must implement:
 * - kind (readonly property)
 * - buildCommand(task): string[]
 * - parseArtifacts(stdout): Artifact[]
 * - parseObservations(stdout): Observation[]
 * - streamEvents(handle): AsyncIterable<WorkerEvent>
 *
 * Subclasses may optionally override:
 * - parseAdditionalCost(stdout): extra cost fields
 */
export abstract class BaseProcessAdapter implements WorkerAdapter {
  abstract readonly kind: WorkerKind;

  protected readonly processManager: ProcessManager;
  protected readonly gracePeriodMs: number;
  protected readonly activeProcesses = new Map<string, ActiveProcess>();

  constructor(processManager: ProcessManager, gracePeriodMs: number = 5000) {
    this.processManager = processManager;
    this.gracePeriodMs = gracePeriodMs;
  }

  abstract buildCommand(task: WorkerTask): string[];
  abstract streamEvents(handle: WorkerHandle): AsyncIterable<WorkerEvent>;
  protected abstract parseArtifacts(stdout: string): Artifact[];
  protected abstract parseObservations(stdout: string): Observation[];

  async startTask(task: WorkerTask): Promise<WorkerHandle> {
    const command = this.buildCommand(task);
    const startedAt = now();

    // Merge process.env with task.env so we don't accidentally drop PATH/HOME/etc.
    // (Bun.spawn replaces the environment when `env` is provided.)
    const mergedEnv: Record<string, string> | undefined = task.env
      ? (() => {
          const base: Record<string, string> = {};
          for (const [k, v] of Object.entries(process.env)) {
            if (v !== undefined) base[k] = v;
          }
          return { ...base, ...task.env };
        })()
      : undefined;

    // Convert deadline to timeout for ProcessManager
    const currentTime = Date.now();
    const timeoutMs =
      task.budget.deadlineAt > currentTime
        ? task.budget.deadlineAt - currentTime
        : undefined;

    const managed = this.processManager.spawn({
      command,
      cwd: task.workspaceRef,
      env: mergedEnv,
      abortSignal: task.abortSignal,
      timeoutMs,
      processGroup: true,
    });

    if (process.env.AGENTCORE_VERBOSE === "1" && process.env.AGENTCORE_COMPONENT === "core") {
      const rendered = renderCommandForLogs(command, task);
      process.stderr.write(
        `[core][worker:${this.kind}] spawn pid=${managed.pid} cwd=${task.workspaceRef} cmd=${rendered}\n`,
      );
    }

    const handle: WorkerHandle = {
      handleId: generateId(),
      workerKind: this.kind,
      abortSignal: task.abortSignal,
    };

    this.activeProcesses.set(handle.handleId, {
      managed,
      startedAt,
      collectedStdout: [],
      collectedStderr: [],
      streamConsumed: false,
    });

    return handle;
  }

  async cancel(handle: WorkerHandle): Promise<void> {
    const active = this.activeProcesses.get(handle.handleId);
    if (!active) return;

    await this.processManager.gracefulShutdown(
      active.managed.pid,
      this.gracePeriodMs,
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

    const stdoutPromise = active.streamConsumed
      ? Promise.resolve(active.collectedStdout.join("\n"))
      : this.readStream(managed.stdout);

    const stderrPromise = active.streamConsumed
      ? Promise.resolve(active.collectedStderr.join("\n"))
      : this.readStream(managed.stderr);

    const [stdout, stderr, exitCode] = await Promise.all([
      stdoutPromise,
      stderrPromise,
      managed.exitPromise,
    ]);
    const wallTimeMs = now() - startedAt;

    this.activeProcesses.delete(handle.handleId);

    const artifacts = this.parseArtifacts(stdout);
    const observations = this.parseObservations(stdout);

    const stderrObs = toStderrObservation(stderr);
    if (stderrObs) observations.push(stderrObs);

    if (handle.abortSignal.aborted) {
      return {
        status: WorkerStatus.CANCELLED,
        artifacts,
        observations,
        cost: { wallTimeMs },
        durationMs: wallTimeMs,
        exitCode,
        errorClass: ErrorClass.RETRYABLE_TRANSIENT,
      };
    }

    if (exitCode === 0) {
      return {
        status: WorkerStatus.SUCCEEDED,
        artifacts,
        observations,
        cost: { wallTimeMs },
        durationMs: wallTimeMs,
        exitCode,
      };
    }

    const errorClass = this.classifyExitCode(exitCode, stdout);
    return {
      status: WorkerStatus.FAILED,
      artifacts,
      observations,
      cost: { wallTimeMs },
      durationMs: wallTimeMs,
      exitCode,
      errorClass,
    };
  }

  /**
   * Classify exit code into an ErrorClass. Subclasses can override for
   * worker-specific error classification.
   *
   * Default logic:
   * - 137 (SIGKILL) / 143 (SIGTERM) → CANCELLED-style, treated as RETRYABLE_TRANSIENT
   * - Rate limit patterns in stdout → RETRYABLE_RATE_LIMIT
   * - Network/connection patterns → RETRYABLE_NETWORK
   * - Other non-zero → NON_RETRYABLE
   */
  protected classifyExitCode(exitCode: number, stdout: string): ErrorClass {
    // Signal-based exits: 128 + signal number
    if (exitCode === 137 || exitCode === 143) {
      return ErrorClass.RETRYABLE_TRANSIENT;
    }

    // Check stdout for known transient patterns
    const lowerStdout = stdout.toLowerCase();

    if (
      lowerStdout.includes("rate limit") ||
      lowerStdout.includes("429") ||
      lowerStdout.includes("too many requests")
    ) {
      return ErrorClass.RETRYABLE_RATE_LIMIT;
    }

    if (
      lowerStdout.includes("econnrefused") ||
      lowerStdout.includes("econnreset") ||
      lowerStdout.includes("etimedout") ||
      lowerStdout.includes("network error") ||
      lowerStdout.includes("socket hang up")
    ) {
      return ErrorClass.RETRYABLE_NETWORK;
    }

    return ErrorClass.NON_RETRYABLE;
  }

  protected async readStdout(managed: ManagedProcess): Promise<string> {
    return this.readStream(managed.stdout);
  }

  protected async readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Stream may already be consumed by streamEvents
    } finally {
      reader.releaseLock();
    }
    return chunks.join("");
  }
}

function toStderrObservation(stderr: string): Observation | null {
  const trimmed = stderr.trim();
  if (!trimmed) return null;

  const max = 2000;
  if (trimmed.length <= max) {
    return { summary: `[stderr]\n${trimmed}` };
  }

  const head = trimmed.slice(0, 800);
  const tail = trimmed.slice(-800);
  return { summary: `[stderr]\n${head}\n...\n${tail}` };
}

function renderCommandForLogs(cmd: string[], task: WorkerTask): string {
  const showPrompts = process.env.AGENTCORE_SHOW_WORKER_PROMPTS === "1";
  const instr = task.instructions;

  const renderedArgs = cmd.map((arg, i) => {
    if (!showPrompts) {
      const prev = i > 0 ? cmd[i - 1] : "";
      if (prev === "--prompt" || prev === "--print") {
        return `<instructions ${arg.length} chars>`;
      }
      if (arg === instr) {
        return `<instructions ${instr.length} chars>`;
      }
      if (arg.includes("\n")) {
        return `<multiline ${arg.length} chars>`;
      }
    }

    if (arg.length > 300) {
      return arg.slice(0, 180) + `...<truncated ${arg.length} chars>`;
    }

    return arg;
  });

  return renderedArgs.map(shQuote).join(" ");
}

function shQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=,@+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'"'"'`)}'`;
}
