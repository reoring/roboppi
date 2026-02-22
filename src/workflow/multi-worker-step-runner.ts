/**
 * MultiWorkerStepRunner
 *
 * Executes workflow steps using the configured worker kind:
 * - CUSTOM: run as a shell script (ShellStepRunner)
 * - OPENCODE / CLAUDE_CODE / CODEX_CLI: delegate to the corresponding adapter
 *
 * This allows workflow YAML to specify real worker kinds directly.
 */
import type { StepDefinition, CompletionCheckDef } from "./types.js";
import type { StepRunner, StepRunResult, CheckResult } from "./executor.js";
import { ShellStepRunner } from "./shell-step-runner.js";
import {
  extractWorkerText,
  resolveCompletionDecision,
  COMPLETION_CHECK_ID_ENV,
} from "./completion-decision.js";
import { resolveTaskLike, buildWorkerTask } from "./resolve-worker-task.js";

import { ProcessManager } from "../worker/process-manager.js";
import type { WorkerAdapter, WorkerEvent } from "../worker/worker-adapter.js";
import { OpenCodeAdapter } from "../worker/adapters/opencode-adapter.js";
import { ClaudeCodeAdapter } from "../worker/adapters/claude-code-adapter.js";
import { CodexCliAdapter } from "../worker/adapters/codex-cli-adapter.js";

import {
  WorkerStatus,
  generateId,
  ErrorClass,
} from "../types/index.js";
import type { WorkerTask, WorkerResult } from "../types/index.js";
import type { ExecEventSink } from "../tui/exec-event.js";
import { NoopExecEventSink } from "../tui/noop-sink.js";

type LlmWorker = Exclude<NonNullable<StepDefinition["worker"]>, "CUSTOM">;

export class MultiWorkerStepRunner implements StepRunner {
  private readonly shell: ShellStepRunner;
  private readonly pm: ProcessManager;

  private readonly adapters: Record<LlmWorker, WorkerAdapter>;

  constructor(
    private readonly verbose: boolean = false,
    private readonly sink: ExecEventSink = new NoopExecEventSink(),
  ) {
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

    const adapter = step.worker ? this.adapters[step.worker as LlmWorker] : undefined;
    if (!adapter) {
      return { status: "FAILED", errorClass: ErrorClass.NON_RETRYABLE };
    }

    const resolved = resolveTaskLike(step, workspaceDir, env);
    const task = buildWorkerTask(resolved, abortSignal);
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

    const checkStartedAt = Date.now();
    const checkId = generateId();
    const checkEnv = check.decision_file
      ? {
        ...(env ?? {}),
        [COMPLETION_CHECK_ID_ENV]: checkId,
      }
      : env;
    const resolved = resolveTaskLike(check, workspaceDir, checkEnv);
    const task = buildWorkerTask(resolved, abortSignal);
    const result = await this.runWorkerTask(stepId, adapter, task);

    if (result.status !== WorkerStatus.SUCCEEDED) {
      const reason = summarizeWorkerFailure(result);
      return {
        complete: false,
        failed: true,
        errorClass: result.errorClass ?? ErrorClass.NON_RETRYABLE,
        ...(reason ? { reason } : {}),
      };
    }

    const decision = await resolveCompletionDecision(
      check,
      workspaceDir,
      checkStartedAt,
      checkId,
    );
    if (this.verbose) {
      process.stderr.write(
        `\x1b[36m[check:${stepId}]\x1b[0m completion decision: ` +
          `${decision.decision} source=${decision.source}` +
          `${decision.reason ? ` reason=${decision.reason}` : ""}` +
          `${decision.checkIdMatch !== undefined ? ` check_id_match=${decision.checkIdMatch}` : ""}` +
          `\n`,
      );
    }

    if (decision.decision === "complete") return { complete: true, failed: false };
    if (decision.decision === "incomplete") {
      return {
        complete: false,
        failed: false,
        decisionSource: decision.source,
        decisionCheckIdMatch: decision.checkIdMatch,
        ...(decision.reasons ? { reasons: decision.reasons } : {}),
        ...(decision.fingerprints ? { fingerprints: decision.fingerprints } : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
      };
    }
    return {
      complete: false,
      failed: false,
      errorClass: ErrorClass.RETRYABLE_TRANSIENT,
      reason: decision.reason ?? "could not parse completion decision (expected COMPLETE/INCOMPLETE marker)",
      decisionSource: decision.source,
      decisionCheckIdMatch: decision.checkIdMatch,
      ...(decision.reasons ? { reasons: decision.reasons } : {}),
      ...(decision.fingerprints ? { fingerprints: decision.fingerprints } : {}),
    };
  }

  private async runViaAdapter(
    stepId: string,
    adapter: WorkerAdapter,
    task: WorkerTask,
  ): Promise<StepRunResult> {
    const result = await this.runWorkerTask(stepId, adapter, task);

    this.sink.emit({
      type: "worker_result",
      stepId,
      ts: Date.now(),
      result,
    });

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

    if (this.verbose) {
      const anyAdapter = adapter as unknown as { buildCommand?: (t: WorkerTask) => string[] };
      const cmd = anyAdapter.buildCommand ? anyAdapter.buildCommand(taskForAdapter) : undefined;
      if (cmd && cmd.length > 0) {
        const rendered = renderCommandForLogs(cmd, taskForAdapter);
        process.stderr.write(
          `\x1b[36m[worker:${taskForAdapter.workerKind}]\x1b[0m ` +
            `\x1b[90m(step:${stepId})\x1b[0m ` +
            `cwd=${taskForAdapter.workspaceRef} cmd=${rendered}\n`,
        );
      }
    }

    const handle = await adapter.startTask(taskForAdapter);

    const onAbort = () => {
      adapter.cancel(handle).catch(() => {});
    };
    if (taskForAdapter.abortSignal.aborted) {
      await adapter.cancel(handle).catch(() => {});
    } else {
      taskForAdapter.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const streamDone = (async () => {
      try {
        for await (const ev of adapter.streamEvents(handle)) {
          this.sink.emit({
            type: "worker_event",
            stepId,
            ts: Date.now(),
            event: ev,
          });
          if (this.verbose) {
            this.printWorkerEvent(stepId, ev);
          }
        }
      } catch {
        // Ignore stream errors on cancellation
      }
    })();

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

function summarizeWorkerFailure(result: WorkerResult): string {
  const parts: string[] = [];
  if (result.exitCode !== undefined) parts.push(`exitCode=${result.exitCode}`);
  if (result.errorClass) parts.push(`errorClass=${result.errorClass}`);

  const text = extractWorkerText(result).trim();
  if (text) {
    const oneLine = text.replace(/\s+/g, " ").trim();
    parts.push(oneLine.slice(0, 300));
  }

  return parts.join(" ");
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

function renderCommandForLogs(cmd: string[], task: WorkerTask): string {
  const showPrompts = process.env.ROBOPPI_SHOW_WORKER_PROMPTS === "1";
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
