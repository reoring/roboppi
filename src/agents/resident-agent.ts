/**
 * ResidentAgent — persistent agent loop that stays alive for the workflow
 * duration, polls its inbox/task queue, and dispatches CLI agents as needed.
 *
 * Unlike the previous one-shot model where `claude --print` ran once and died,
 * the ResidentAgent acts as a supervisor that re-invokes CLI agents whenever
 * new messages or tasks arrive.
 *
 * Architecture:
 *   ResidentAgent (always running)
 *     ├── poll loop: checks inbox + task queue every N seconds
 *     ├── dispatch: invokes CLI agent (claude --print / opencode run) for work
 *     ├── context: accumulates session history across dispatches
 *     └── events: streams worker events to ExecEventSink for TUI visibility
 */
import { mkdir } from "node:fs/promises";

import { recvMessages } from "./store.js";
import { listTasks } from "./task-store.js";
import { allDirs } from "./paths.js";
import {
  DEFAULT_RESIDENT_POLL_INTERVAL_MS,
  DEFAULT_RESIDENT_DISPATCH_TIMEOUT_MS,
  DEFAULT_RESIDENT_MAX_HISTORY,
} from "./constants.js";
import { ClaudeCodeAdapter } from "../worker/adapters/claude-code-adapter.js";
import { OpenCodeAdapter } from "../worker/adapters/opencode-adapter.js";
import { CodexCliAdapter } from "../worker/adapters/codex-cli-adapter.js";
import { ProcessManager } from "../worker/process-manager.js";
import {
  WorkerKind,
  WorkerCapability,
  OutputMode,
  generateId,
  WorkerStatus,
} from "../types/index.js";
import type { WorkerTask, WorkerResult } from "../types/index.js";
import type { WorkerAdapter } from "../worker/worker-adapter.js";
import type { ExecEventSink } from "../tui/exec-event.js";
import type { AgentProfile } from "../workflow/agent-catalog.js";
import type { ReceivedMessage } from "./store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResidentAgentOptions {
  contextDir: string;
  memberId: string;
  teamId: string;
  profile: AgentProfile;
  workspaceDir: string;
  sink: ExecEventSink;
  env: Record<string, string>;
  pollIntervalMs?: number;
  dispatchTimeoutMs?: number;
  signal?: AbortSignal;
}

interface SessionEntry {
  ts: number;
  type: "message_received" | "task_completed" | "dispatch_result";
  summary: string;
}

// ---------------------------------------------------------------------------
// ResidentAgent
// ---------------------------------------------------------------------------

export class ResidentAgent {
  readonly memberId: string;

  private readonly stepId: string;
  private readonly contextDir: string;
  private readonly profile: AgentProfile;
  private readonly workspaceDir: string;
  private readonly sink: ExecEventSink;
  private readonly env: Record<string, string>;
  private readonly pollIntervalMs: number;
  private readonly dispatchTimeoutMs: number;
  private readonly signal?: AbortSignal;

  private readonly adapter: WorkerAdapter;
  private readonly processManager: ProcessManager;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running = false;
  private dispatching = false;
  private dispatchAbortController: AbortController | null = null;
  private abortHandler: (() => void) | null = null;

  // Context accumulation across dispatches
  private sessionHistory: SessionEntry[] = [];

  // Settlement tracking
  private resolveSettled: (() => void) | null = null;
  readonly settled: Promise<void>;

  constructor(opts: ResidentAgentOptions) {
    this.stepId = `_agent:${opts.memberId}`;
    this.memberId = opts.memberId;
    this.contextDir = opts.contextDir;
    this.profile = opts.profile;
    this.workspaceDir = opts.workspaceDir;
    this.sink = opts.sink;
    this.env = opts.env;
    this.pollIntervalMs =
      opts.pollIntervalMs ?? DEFAULT_RESIDENT_POLL_INTERVAL_MS;
    this.dispatchTimeoutMs =
      opts.dispatchTimeoutMs ?? DEFAULT_RESIDENT_DISPATCH_TIMEOUT_MS;
    this.signal = opts.signal;

    // Create adapter based on worker kind
    this.processManager = new ProcessManager();
    this.adapter = this.createAdapter(opts.profile.worker ?? "CLAUDE_CODE");

    this.settled = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;

    // Ensure inbox directories exist
    this.ensureDirs().catch(() => {});

    // Emit step_state RUNNING so TUI shows this agent as active
    this.sink.emit({
      type: "step_state",
      stepId: this.stepId,
      status: "RUNNING" as never,
      iteration: 0,
      maxIterations: 1,
      startedAt: Date.now(),
    });

    // Wire up AbortSignal for emergency stop
    if (this.signal) {
      if (this.signal.aborted) {
        this.stop();
        return;
      }
      this.abortHandler = () => this.stop();
      this.signal.addEventListener("abort", this.abortHandler, { once: true });
    }

    this.scheduleNext(0); // Poll immediately
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;

    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Cancel any running CLI agent dispatch
    if (this.dispatchAbortController) {
      this.dispatchAbortController.abort("resident_agent_stop");
    }

    // Remove abort listener
    if (this.abortHandler && this.signal) {
      this.signal.removeEventListener("abort", this.abortHandler);
      this.abortHandler = null;
    }

    // Kill any processes still running
    this.processManager.killAll().catch(() => {});

    // Emit step_state COMPLETED
    this.sink.emit({
      type: "step_state",
      stepId: this.stepId,
      status: "SUCCEEDED" as never,
      iteration: 0,
      maxIterations: 1,
      completedAt: Date.now(),
    });

    this.resolveSettled?.();
  }

  get isRunning(): boolean {
    return this.running && !this.stopped;
  }

  get isDispatching(): boolean {
    return this.dispatching;
  }

  // -----------------------------------------------------------------------
  // Poll loop (modeled after LeadInboxBroker)
  // -----------------------------------------------------------------------

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      this.poll()
        .catch(() => {})
        .finally(() => {
          if (!this.stopped) {
            this.scheduleNext(this.pollIntervalMs);
          }
        });
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.dispatching) return;

    // 1. Peek at inbox (don't claim — let the CLI agent claim them)
    const msgs = await this.peekMessages();

    // 2. Check for claimable tasks assigned to this member
    const hasTasks = await this.hasClaimableTasks();

    // 3. If there's work, dispatch a CLI agent
    if (msgs.length > 0 || hasTasks) {
      await this.dispatchCliAgent(msgs, hasTasks);
    }
  }

  private async peekMessages(): Promise<ReceivedMessage[]> {
    try {
      return await recvMessages({
        contextDir: this.contextDir,
        memberId: this.memberId,
        claim: false, // Peek only — CLI agent will claim
        max: 10,
      });
    } catch {
      return [];
    }
  }

  private async hasClaimableTasks(): Promise<boolean> {
    try {
      const tasks = await listTasks(this.contextDir, "pending");
      return tasks.some(
        (t) =>
          t.assigned_to === this.memberId ||
          (!t.assigned_to && !t.claimed_by),
      );
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // CLI agent dispatch
  // -----------------------------------------------------------------------

  private async dispatchCliAgent(
    pendingMessages: ReceivedMessage[],
    hasTasks: boolean,
  ): Promise<void> {
    this.dispatching = true;
    this.dispatchAbortController = new AbortController();

    // Emit phase: executing
    this.sink.emit({
      type: "step_phase",
      stepId: this.stepId,
      phase: "executing",
      at: Date.now(),
    });

    try {
      const instructions = this.buildInstructions(pendingMessages, hasTasks);
      const result = await this.runCliAgent(instructions);

      // Record dispatch result in session history
      this.addToHistory({
        ts: Date.now(),
        type: "dispatch_result",
        summary:
          result.status === WorkerStatus.SUCCEEDED
            ? "Completed work successfully"
            : `Dispatch ended: ${result.status}`,
      });

      // Record message context
      for (const msg of pendingMessages) {
        this.addToHistory({
          ts: msg.message.ts,
          type: "message_received",
          summary: `From ${msg.message.from.member_id}: ${msg.message.body.slice(0, 100)}`,
        });
      }
    } catch {
      // Dispatch failed — will retry on next poll
    } finally {
      this.dispatching = false;
      this.dispatchAbortController = null;

      // Emit phase: ready (idle, waiting for next work)
      if (!this.stopped) {
        this.sink.emit({
          type: "step_phase",
          stepId: this.stepId,
          phase: "ready",
          at: Date.now(),
        });
      }
    }
  }

  private async runCliAgent(instructions: string): Promise<WorkerResult> {
    const task: WorkerTask = {
      workerTaskId: generateId(),
      workerKind: this.resolveWorkerKind(),
      workspaceRef: this.workspaceDir,
      instructions,
      model: this.profile.model,
      variant: this.profile.variant,
      capabilities: this.resolveCapabilities(),
      outputMode: OutputMode.STREAM,
      budget: {
        deadlineAt: Date.now() + this.dispatchTimeoutMs,
        ...(this.profile.max_steps !== undefined
          ? { maxSteps: this.profile.max_steps }
          : {}),
      },
      env: this.env,
      abortSignal: this.dispatchAbortController!.signal,
    };

    const handle = await this.adapter.startTask(task);

    // Stream events to sink for TUI visibility
    const streamDone = (async () => {
      try {
        for await (const ev of this.adapter.streamEvents(handle)) {
          this.sink.emit({
            type: "worker_event",
            stepId: this.stepId,
            ts: Date.now(),
            event: ev,
          });
        }
      } catch {
        // Stream may close early on abort
      }
    })();

    const result = await this.adapter.awaitResult(handle);
    await streamDone;

    // Emit final result
    this.sink.emit({
      type: "worker_result",
      stepId: this.stepId,
      ts: Date.now(),
      result,
    });

    return result;
  }

  // -----------------------------------------------------------------------
  // Instruction building (with accumulated context)
  // -----------------------------------------------------------------------

  private buildInstructions(
    pendingMessages: ReceivedMessage[],
    hasTasks: boolean,
  ): string {
    const parts: string[] = [];

    // Base instructions from agent profile
    if (this.profile.base_instructions) {
      parts.push(this.profile.base_instructions);
    }

    // Role identity
    parts.push(`You are team member "${this.memberId}".`);
    parts.push(
      "Use `roboppi agents` commands to communicate with your team and manage tasks.",
    );
    parts.push("");

    // Mailbox instructions
    parts.push("## Mailbox");
    if (pendingMessages.length > 0) {
      parts.push(
        `You have ${pendingMessages.length} NEW MESSAGE(S) in your inbox. Check them FIRST:`,
      );
      parts.push("  roboppi agents message recv --claim --max 10");
      parts.push("");
      parts.push(
        "After you claim a message and act on it, you MUST ack it (otherwise it will be requeued and you'll see duplicates):",
      );
      parts.push('  roboppi agents message ack --claim-token "<opaque>"');
      parts.push("");
      parts.push(
        "When you receive a message, you MUST reply to the sender IMMEDIATELY, then ack the claimed message:",
      );
      parts.push(
        "Preferred (reply + ack in one command):",
      );
      parts.push(
        '  roboppi agents message reply --claim-token "<opaque>" --topic chat --body "<your reply>"',
      );
      parts.push(
        "Fallback (send + ack):",
      );
      parts.push(
        '  roboppi agents message send --to <sender_member_id> --topic chat --body "<your reply>"',
      );
      parts.push('  roboppi agents message ack --claim-token "<opaque>"');
    } else {
      parts.push("Check your inbox for messages:");
      parts.push("  roboppi agents message recv --claim --max 10");
      parts.push("");
      parts.push(
        "If you claim any messages, ack them using the claim token returned by recv --claim:",
      );
      parts.push('  roboppi agents message ack --claim-token "<opaque>"');
    }
    parts.push("");

    // Task instructions
    parts.push("## Tasks");
    if (hasTasks) {
      parts.push(
        "There are PENDING TASKS assigned to you. Check and claim them:",
      );
    } else {
      parts.push("Check for any pending tasks:");
    }
    parts.push("  roboppi agents tasks list --status pending");
    parts.push("  roboppi agents tasks claim --task-id <id>");
    parts.push(
      "  roboppi agents tasks complete --task-id <id>   # when done",
    );
    parts.push("");

    // Session context from previous dispatches
    if (this.sessionHistory.length > 0) {
      parts.push("## Session Context (your previous interactions)");
      const recentHistory = this.sessionHistory.slice(
        -DEFAULT_RESIDENT_MAX_HISTORY,
      );
      for (const entry of recentHistory) {
        const time = new Date(entry.ts).toISOString().slice(11, 19);
        parts.push(`- [${time}] ${entry.summary}`);
      }
      parts.push("");
    }

    // Lifecycle: tell the agent to finish when done
    parts.push("## Lifecycle");
    parts.push(
      "Complete your current work (respond to messages, work on tasks), then exit.",
    );
    parts.push(
      "Do NOT loop or wait — the system will re-invoke you when new work arrives.",
    );

    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private createAdapter(workerKind: string): WorkerAdapter {
    switch (workerKind) {
      case "OPENCODE":
        return new OpenCodeAdapter(this.processManager);
      case "CODEX_CLI":
        return new CodexCliAdapter(this.processManager);
      case "CLAUDE_CODE":
      default:
        return new ClaudeCodeAdapter(
          { outputFormat: "json" },
          this.processManager,
        );
    }
  }

  private resolveWorkerKind(): WorkerKind {
    switch (this.profile.worker) {
      case "OPENCODE":
        return WorkerKind.OPENCODE;
      case "CODEX_CLI":
        return WorkerKind.CODEX_CLI;
      case "CLAUDE_CODE":
      default:
        return WorkerKind.CLAUDE_CODE;
    }
  }

  private resolveCapabilities(): WorkerCapability[] {
    const caps = this.profile.capabilities ?? [
      "READ",
      "EDIT",
      "MAILBOX",
      "TASKS",
    ];
    const capMap: Record<string, WorkerCapability> = {
      READ: WorkerCapability.READ,
      EDIT: WorkerCapability.EDIT,
      RUN_TESTS: WorkerCapability.RUN_TESTS,
      RUN_COMMANDS: WorkerCapability.RUN_COMMANDS,
      MAILBOX: WorkerCapability.MAILBOX,
      TASKS: WorkerCapability.TASKS,
    };
    return caps
      .map((c) => capMap[c])
      .filter((c): c is WorkerCapability => c !== undefined);
  }

  private async ensureDirs(): Promise<void> {
    const dirs = allDirs(this.contextDir, [this.memberId]);
    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
    }
  }

  private addToHistory(entry: SessionEntry): void {
    this.sessionHistory.push(entry);
    if (this.sessionHistory.length > DEFAULT_RESIDENT_MAX_HISTORY) {
      this.sessionHistory = this.sessionHistory.slice(
        -DEFAULT_RESIDENT_MAX_HISTORY,
      );
    }
  }
}
