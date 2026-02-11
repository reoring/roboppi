/**
 * MultiWorkerStepRunner
 *
 * Executes workflow steps using the configured worker kind:
 * - CUSTOM: run as a shell script (ShellStepRunner)
 * - OPENCODE / CLAUDE_CODE / CODEX_CLI: delegate to the corresponding adapter
 *
 * This allows workflow YAML to specify real worker kinds directly.
 */
import path from "node:path";
import type { StepDefinition, CompletionCheckDef } from "./types.js";
import type { StepRunner, StepRunResult, CheckResult } from "./executor.js";
import { ShellStepRunner } from "./shell-step-runner.js";
import { parseDuration } from "./duration.js";

import { ProcessManager } from "../worker/process-manager.js";
import type { WorkerAdapter, WorkerEvent } from "../worker/worker-adapter.js";
import { OpenCodeAdapter } from "../worker/adapters/opencode-adapter.js";
import { ClaudeCodeAdapter } from "../worker/adapters/claude-code-adapter.js";
import { CodexCliAdapter } from "../worker/adapters/codex-cli-adapter.js";

import {
  WorkerKind,
  WorkerCapability,
  OutputMode,
  WorkerStatus,
  generateId,
  ErrorClass,
} from "../types/index.js";
import type { WorkerTask, WorkerResult } from "../types/index.js";

type LlmWorker = Exclude<StepDefinition["worker"], "CUSTOM">;

function toWorkerKind(worker: LlmWorker): WorkerKind {
  switch (worker) {
    case "OPENCODE":
      return WorkerKind.OPENCODE;
    case "CLAUDE_CODE":
      return WorkerKind.CLAUDE_CODE;
    case "CODEX_CLI":
      return WorkerKind.CODEX_CLI;
  }
}

export class MultiWorkerStepRunner implements StepRunner {
  private readonly shell: ShellStepRunner;
  private readonly pm: ProcessManager;

  private readonly adapters: Record<LlmWorker, WorkerAdapter>;

  constructor(private readonly verbose: boolean = false) {
    this.shell = new ShellStepRunner(verbose);
    this.pm = new ProcessManager();

    // Share a single ProcessManager across all adapters.
    this.adapters = {
      OPENCODE: new OpenCodeAdapter(this.pm),
      CLAUDE_CODE: new ClaudeCodeAdapter({}, this.pm),
      CODEX_CLI: new CodexCliAdapter(this.pm),
    };
  }

  async runStep(
    stepId: string,
    step: StepDefinition,
    workspaceDir: string,
    abortSignal: AbortSignal,
    env?: Record<string, string>,
  ): Promise<StepRunResult> {
    if (step.worker === "CUSTOM") {
      return this.shell.runStep(stepId, step, workspaceDir, abortSignal, env);
    }

    const adapter = this.adapters[step.worker];
    if (!adapter) {
      return { status: "FAILED", errorClass: ErrorClass.NON_RETRYABLE };
    }

    const task = this.buildWorkerTask(step, workspaceDir, abortSignal, env, toWorkerKind(step.worker));
    return this.runViaAdapter(stepId, adapter, task);
  }

  async runCheck(
    stepId: string,
    check: CompletionCheckDef,
    workspaceDir: string,
    abortSignal: AbortSignal,
    env?: Record<string, string>,
  ): Promise<CheckResult> {
    if (check.worker === "CUSTOM") {
      return this.shell.runCheck(stepId, check, workspaceDir, abortSignal, env);
    }

    const adapter = this.adapters[check.worker];
    if (!adapter) {
      return { complete: false, failed: true, errorClass: ErrorClass.NON_RETRYABLE };
    }

    const task = this.buildWorkerTask(check, workspaceDir, abortSignal, env, toWorkerKind(check.worker));
    const result = await this.runWorkerTask(stepId, adapter, task);

    if (result.status !== WorkerStatus.SUCCEEDED) {
      return {
        complete: false,
        failed: true,
        errorClass: result.errorClass ?? ErrorClass.NON_RETRYABLE,
      };
    }

    const text = extractWorkerText(result);
    const decision = parseCompletionDecision(text);
    if (decision === "complete") return { complete: true, failed: false };
    if (decision === "incomplete") return { complete: false, failed: false };
    return { complete: false, failed: true, errorClass: ErrorClass.NON_RETRYABLE };
  }

  private buildWorkerTask(
    def: Pick<StepDefinition, "instructions" | "capabilities" | "timeout" | "max_steps" | "max_command_time" | "workspace" | "model">,
    workspaceDir: string,
    abortSignal: AbortSignal,
    env?: Record<string, string>,
    workerKind: WorkerKind = WorkerKind.CUSTOM,
  ): WorkerTask {
    const workspaceRef = def.workspace
      ? path.resolve(workspaceDir, def.workspace)
      : workspaceDir;

    // If a step-level timeout is provided, also set a deadline.
    const deadlineAt = def.timeout
      ? Date.now() + parseDuration(def.timeout)
      : Date.now() + 24 * 60 * 60 * 1000;

    const maxCommandTimeMs = def.max_command_time
      ? parseDuration(def.max_command_time)
      : undefined;

    return {
      workerTaskId: generateId(),
      workerKind,
      workspaceRef,
      instructions: def.instructions,
      capabilities: def.capabilities.map((c) => WorkerCapability[c]),
      outputMode: OutputMode.BATCH,
      ...(def.model ? { model: def.model } : {}),
      budget: {
        deadlineAt,
        ...(def.max_steps !== undefined ? { maxSteps: def.max_steps } : {}),
        ...(maxCommandTimeMs !== undefined ? { maxCommandTimeMs } : {}),
      },
      env,
      abortSignal,
    };
  }

  private async runViaAdapter(
    stepId: string,
    adapter: WorkerAdapter,
    task: WorkerTask,
  ): Promise<StepRunResult> {
    const result = await this.runWorkerTask(stepId, adapter, task);

    if (result.status === WorkerStatus.SUCCEEDED) {
      return {
        status: "SUCCEEDED",
        artifacts: result.artifacts,
        observations: result.observations,
        cost: result.cost,
      };
    }

    if (result.status === WorkerStatus.CANCELLED) {
      return { status: "FAILED", errorClass: ErrorClass.NON_RETRYABLE };
    }

    return {
      status: "FAILED",
      errorClass: result.errorClass ?? ErrorClass.RETRYABLE_TRANSIENT,
      artifacts: result.artifacts,
      observations: result.observations,
      cost: result.cost,
    };
  }

  private async runWorkerTask(
    stepId: string,
    adapter: WorkerAdapter,
    task: WorkerTask,
  ): Promise<WorkerResult> {
    const scoped = createScopedAbort(task.abortSignal, task.budget.deadlineAt);

    const taskForAdapter: WorkerTask = {
      ...task,
      abortSignal: scoped.signal,
    };

    const handle = await adapter.startTask(taskForAdapter);

    const onAbort = () => {
      adapter.cancel(handle).catch(() => {});
    };
    if (taskForAdapter.abortSignal.aborted) {
      await adapter.cancel(handle).catch(() => {});
    } else {
      taskForAdapter.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const streamDone = this.verbose
      ? (async () => {
          try {
            for await (const ev of adapter.streamEvents(handle)) {
              this.printWorkerEvent(stepId, ev);
            }
          } catch {
            // Ignore stream errors on cancellation
          }
        })()
      : Promise.resolve();

    try {
      const result = await adapter.awaitResult(handle);
      await streamDone;
      return result;
    } finally {
      scoped.cleanup();
      taskForAdapter.abortSignal.removeEventListener("abort", onAbort);
    }
  }

  private printWorkerEvent(stepId: string, ev: WorkerEvent): void {
    const prefix = `\x1b[36m[step:${stepId}]\x1b[0m `;
    if (ev.type === "progress") {
      process.stderr.write(prefix + (ev.message ?? "") + "\n");
      return;
    }
    if (ev.type === "stderr") {
      process.stderr.write(prefix + String(ev.data).trimEnd() + "\n");
      return;
    }
    if (ev.type === "patch") {
      process.stderr.write(prefix + `patch: ${ev.filePath}` + "\n");
      return;
    }
    if (ev.type === "stdout") {
      const line = String(ev.data).trimEnd();
      if (line) process.stderr.write(prefix + line + "\n");
    }
  }
}

function createScopedAbort(parent: AbortSignal, deadlineAt: number): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onAbort = () => {
    ctrl.abort();
  };

  if (parent.aborted) {
    ctrl.abort();
  } else {
    parent.addEventListener("abort", onAbort, { once: true });
  }

  const remaining = deadlineAt - Date.now();
  if (Number.isFinite(remaining) && remaining > 0) {
    timer = setTimeout(() => ctrl.abort(), remaining);
  } else if (!ctrl.signal.aborted) {
    ctrl.abort();
  }

  const cleanup = () => {
    parent.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
  };

  return { signal: ctrl.signal, cleanup };
}

function extractWorkerText(result: WorkerResult): string {
  const parts: string[] = [];
  for (const o of result.observations ?? []) {
    if (o.summary) parts.push(o.summary);
  }
  return parts.join("\n");
}

type CompletionDecision = "complete" | "incomplete" | "fail";

function parseCompletionDecision(text: string): CompletionDecision {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "fail";
  const last = lines[lines.length - 1]!.toLowerCase();
  if (last.includes("incomplete")) return "incomplete";
  if (last.includes("complete")) return "complete";
  if (last.includes("fail") || last.includes("failed")) return "fail";
  return "fail";
}
