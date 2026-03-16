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
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { recvMessages } from "./store.js";
import { hasActionableTaskForMember, listTasks } from "./task-store.js";
import { agentDebugLogPath, allDirs } from "./paths.js";
import { readWorkflowStatus, type WorkflowStatusSummary } from "./status-store.js";
import {
  INITIALIZING_STARTUP_STUB_BLOCKER,
  INITIALIZING_STARTUP_STUB_SUMMARY,
} from "./current-state-phase.js";
import type { AgentTask } from "./types.js";
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
import type { McpServerConfig } from "../types/mcp-server.js";
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

interface DispatchContextSnapshot {
  workflowStatus: WorkflowStatusSummary | null;
  ownedTasks: AgentTask[];
}

function isDeveloperStartupStubStatus(status: WorkflowStatusSummary | null): boolean {
  return status?.summary === INITIALIZING_STARTUP_STUB_SUMMARY
    && status.blockers.includes(INITIALIZING_STARTUP_STUB_BLOCKER);
}

function formatTaskForInstructions(task: AgentTask): string[] {
  const lines = [`- ${task.task_id}: ${task.title}`];
  const description = task.description.trim();
  if (!description) return lines;
  for (const line of description.split("\n")) {
    lines.push(`  ${line}`);
  }
  return lines;
}

function cloneAgentProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    ...(profile.defaultArgs ? { defaultArgs: [...profile.defaultArgs] } : {}),
    ...(profile.mcp_configs ? { mcp_configs: [...profile.mcp_configs] } : {}),
    ...(profile.mcp_servers
      ? {
          mcp_servers: profile.mcp_servers.map((server) => ({
            ...server,
            ...(server.args ? { args: [...server.args] } : {}),
            ...(server.env ? { env: { ...server.env } } : {}),
          })),
        }
      : {}),
    ...(profile.capabilities ? { capabilities: [...profile.capabilities] } : {}),
  };
}

function cloneProfileDefaultArgs(profile: AgentProfile): string[] {
  const args = Array.isArray(profile.defaultArgs) ? [...profile.defaultArgs] : [];
  if (profile.worker === "CLAUDE_CODE" && Array.isArray(profile.mcp_configs)) {
    for (const config of profile.mcp_configs) {
      args.push("--mcp-config", config);
    }
    if (profile.strict_mcp_config) {
      args.push("--strict-mcp-config");
    }
  }
  return args;
}

function cloneProfileMcpServers(profile: AgentProfile): McpServerConfig[] {
  return Array.isArray(profile.mcp_servers)
    ? profile.mcp_servers.map((server) => ({
        ...server,
        ...(server.args ? { args: [...server.args] } : {}),
        ...(server.env ? { env: { ...server.env } } : {}),
      }))
    : [];
}

export function createAdapterForAgentProfile(
  processManager: ProcessManager,
  profile: AgentProfile,
): WorkerAdapter {
  const defaultArgs = cloneProfileDefaultArgs(profile);
  const mcpServers = cloneProfileMcpServers(profile);

  switch (profile.worker) {
    case "OPENCODE":
      return new OpenCodeAdapter(processManager, { defaultArgs, mcpServers });
    case "CODEX_CLI":
      return new CodexCliAdapter(processManager, { defaultArgs, mcpServers });
    case "CLAUDE_CODE":
    default:
      return new ClaudeCodeAdapter(
        { outputFormat: "json", defaultArgs },
        processManager,
      );
  }
}

// ---------------------------------------------------------------------------
// ResidentAgent
// ---------------------------------------------------------------------------

export class ResidentAgent {
  readonly memberId: string;

  private readonly stepId: string;
  private readonly contextDir: string;
  private profile: AgentProfile;
  private readonly workspaceDir: string;
  private readonly sink: ExecEventSink;
  private readonly env: Record<string, string>;
  private readonly pollIntervalMs: number;
  private readonly dispatchTimeoutMs: number;
  private readonly signal?: AbortSignal;

  private adapter: WorkerAdapter;
  private readonly processManager: ProcessManager;
  private pendingProfile: AgentProfile | null = null;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running = false;
  private dispatching = false;
  private dispatchAbortController: AbortController | null = null;
  private abortHandler: (() => void) | null = null;
  private debugWriteChain: Promise<void> = Promise.resolve();

  // Context accumulation across dispatches
  private sessionHistory: SessionEntry[] = [];

  // Settlement tracking
  private resolveSettled: (() => void) | null = null;
  readonly settled: Promise<void>;

  constructor(opts: ResidentAgentOptions) {
    this.stepId = `_agent:${opts.memberId}`;
    this.memberId = opts.memberId;
    this.contextDir = opts.contextDir;
    this.profile = cloneAgentProfile(opts.profile);
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
    this.adapter = createAdapterForAgentProfile(this.processManager, this.profile);

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

  updateProfile(nextProfile: AgentProfile): void {
    const cloned = cloneAgentProfile(nextProfile);
    if (this.dispatching) {
      this.pendingProfile = cloned;
      return;
    }
    this.applyProfile(cloned);
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
      return await hasActionableTaskForMember(this.contextDir, this.memberId);
    } catch {
      return false;
    }
  }

  private async readDispatchContextSnapshot(): Promise<DispatchContextSnapshot> {
    let workflowStatus: WorkflowStatusSummary | null = null;
    try {
      workflowStatus = await readWorkflowStatus(this.contextDir);
    } catch {
      workflowStatus = null;
    }

    let ownedTasks: AgentTask[] = [];
    try {
      const inProgress = await listTasks(this.contextDir, "in_progress");
      ownedTasks = inProgress
        .filter((task) => task.claimed_by === this.memberId)
        .sort((left, right) => right.updated_at - left.updated_at || left.task_id.localeCompare(right.task_id));
    } catch {
      ownedTasks = [];
    }

    return { workflowStatus, ownedTasks };
  }

  private isDebugLoggingEnabled(): boolean {
    return this.env.ROBOPPI_AGENT_DEBUG_LOG === "1" || process.env.ROBOPPI_AGENT_DEBUG_LOG === "1";
  }

  private appendDebugEvent(event: Record<string, unknown>): void {
    if (!this.isDebugLoggingEnabled()) {
      return;
    }

    const logPath = agentDebugLogPath(this.contextDir, this.memberId);
    this.debugWriteChain = this.debugWriteChain
      .then(async () => {
        await mkdir(dirname(logPath), { recursive: true });
        await appendFile(logPath, JSON.stringify(event) + "\n");
      })
      .catch(() => {});
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
    const dispatchId = generateId();
    const dispatchContext = await this.readDispatchContextSnapshot();
    const instructions = this.buildInstructions(pendingMessages, hasTasks, dispatchContext);
    this.appendDebugEvent({
      ts: Date.now(),
      type: "dispatch_started",
      dispatch_id: dispatchId,
      member_id: this.memberId,
      has_tasks: hasTasks,
      pending_message_count: pendingMessages.length,
      workflow_status_summary: dispatchContext.workflowStatus?.summary ?? null,
      owned_task_ids: dispatchContext.ownedTasks.map((task) => task.task_id),
      instructions,
    });

    // Emit phase: executing
    this.sink.emit({
      type: "step_phase",
      stepId: this.stepId,
      phase: "executing",
      at: Date.now(),
      detail: {
        instructions,
      },
    });

    try {
      const result = await this.runCliAgent(instructions, dispatchId);

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
    } catch (err) {
      this.appendDebugEvent({
        ts: Date.now(),
        type: "dispatch_error",
        dispatch_id: dispatchId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Dispatch failed — will retry on next poll
    } finally {
      this.dispatching = false;
      this.dispatchAbortController = null;

      if (this.pendingProfile) {
        const nextProfile = this.pendingProfile;
        this.pendingProfile = null;
        this.applyProfile(nextProfile);
      }

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

  private async runCliAgent(
    instructions: string,
    dispatchId: string,
  ): Promise<WorkerResult> {
    const instructionBytes = new TextEncoder().encode(instructions).length;
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
          const ts = Date.now();
          this.sink.emit({
            type: "worker_event",
            stepId: this.stepId,
            ts,
            event: ev,
          });
          this.appendDebugEvent({
            ts,
            type: "worker_event",
            dispatch_id: dispatchId,
            event: ev,
          });
        }
      } catch {
        // Stream may close early on abort
      }
    })();

    const result = await this.adapter.awaitResult(handle);
    await streamDone;

    result.cost = {
      ...result.cost,
      instructionBytes,
    };

    // Emit final result
    const resultTs = Date.now();
    this.sink.emit({
      type: "worker_result",
      stepId: this.stepId,
      ts: resultTs,
      result,
    });
    this.appendDebugEvent({
      ts: resultTs,
      type: "worker_result",
      dispatch_id: dispatchId,
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
    dispatchContext: DispatchContextSnapshot = { workflowStatus: null, ownedTasks: [] },
  ): string {
    const parts: string[] = [];
    const capabilities = this.resolveCapabilities();
    const canEdit = capabilities.includes(WorkerCapability.EDIT);
    const canRunCommands = capabilities.includes(WorkerCapability.RUN_COMMANDS);
    const canRunTests = capabilities.includes(WorkerCapability.RUN_TESTS);

    const isDeveloperStartupSync =
      this.memberId === "developer"
      && isDeveloperStartupStubStatus(dispatchContext.workflowStatus);

    // Base instructions from agent profile. For the developer startup stub, keep
    // the first dispatch compact so the worker gets to the bounded canonical-sync
    // write set before spending time on the full repo-wide rulebook.
    if (this.profile.base_instructions) {
      if (isDeveloperStartupSync) {
        parts.push("You are the developer.");
        parts.push(
          "This dispatch is limited to the initial canonical-state sync that replaces startup stubs.",
        );
        parts.push(
          "Own and update current-state.json, todo.md, memory.md, issues/index.md, current-rerun-contract.json, and workflow status before broader planning.",
        );
        parts.push(
          "Defer broad repo planning, implementation, verification, and git sync until after that bounded startup write lands.",
        );
      } else {
        parts.push(this.profile.base_instructions);
      }
    }

    // Role identity
    parts.push(`You are team member "${this.memberId}".`);
    parts.push(
      "Use `roboppi agents` commands to communicate with your team and manage tasks.",
    );
    parts.push("");

    parts.push("## Permissions");
    parts.push("You already have the permissions implied by your capabilities for this dispatch.");
    if (canEdit) {
      parts.push(
        "- You may edit workspace files and workflow state files that belong to your role without asking the lead first.",
      );
    }
    if (canRunCommands || canRunTests) {
      parts.push(
        "- You may run repo-local commands and test scripts needed for your task without asking the lead first.",
      );
    }
    parts.push(
      "- Do not ask the lead for approval for routine repo-local work. Only message the lead when you are blocked by missing external, network, destructive, or policy-sensitive permissions.",
    );
    parts.push("");

    if (dispatchContext.workflowStatus) {
      parts.push("## Canonical Workflow Status");
      parts.push(dispatchContext.workflowStatus.summary);
      if (dispatchContext.workflowStatus.blockers.length > 0) {
        parts.push("Blockers:");
        for (const blocker of dispatchContext.workflowStatus.blockers) {
          parts.push(`- ${blocker}`);
        }
      }
      if (dispatchContext.workflowStatus.next_actions.length > 0) {
        parts.push("Next actions:");
        for (const action of dispatchContext.workflowStatus.next_actions) {
          parts.push(`- ${action}`);
        }
      }
      parts.push("");
    }

    if (
      this.memberId === "developer"
      && isDeveloperStartupStubStatus(dispatchContext.workflowStatus)
    ) {
      parts.push("## Startup Sync First");
      parts.push(
        "You are still on the startup stub. Before broader planning, repo changes, or more task triage, perform the bounded canonical-state sync now.",
      );
      parts.push(
        "Treat that startup sync as your current implementation slice, not as optional background hygiene.",
      );
      parts.push(
        "For this dispatch, defer broad repo scans and repo-wide planning until after the startup-sync write lands.",
      );
      parts.push("Limit the first pass to the startup-sync write set and the minimum reads needed to fill it:");
      parts.push("- `.roboppi-loop/apthctl/current-state.json`");
      parts.push("- `.roboppi-loop/apthctl/todo.md`");
      parts.push("- `.roboppi-loop/apthctl/memory.md`");
      parts.push("- `.roboppi-loop/apthctl/issues/index.md`");
      parts.push("- the owned implement-main task body shown below");
      parts.push(
        "If the MCP tool `developer_sync_bundle` is available, call it before any broader repo scan.",
      );
      parts.push(
        "Success for this dispatch is to replace the null startup stub and publish actionable workflow status, not to finish the entire repo-side plan.",
      );
      parts.push("");
    }

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
    if (dispatchContext.ownedTasks.length > 0) {
      parts.push("Currently owned IN-PROGRESS tasks (treat these descriptions as your immediate source of truth):");
      for (const task of dispatchContext.ownedTasks.slice(0, 3)) {
        parts.push(...formatTaskForInstructions(task));
      }
      parts.push("");
    }
    if (hasTasks) {
      parts.push(
        "You may already own IN-PROGRESS tasks or have new PENDING tasks. Continue owned work before claiming more:",
      );
    } else {
      parts.push("Check for any pending tasks:");
    }
    parts.push("  roboppi agents tasks list --status in_progress");
    parts.push("  roboppi agents tasks list --status pending");
    parts.push("  roboppi agents tasks show --task-id <id>   # read the full task title/description before acting");
    parts.push("  roboppi agents tasks claim --task-id <id>   # claim output includes the full task body");
    parts.push(
      "  roboppi agents tasks complete --task-id <id>   # when done",
    );
    parts.push(
      "  roboppi agents tasks supersede --task-id <id> --member <your_member_id> --reason <why> [--replacement-task-id <newer_id>]   # when your task/input is stale",
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

  private applyProfile(nextProfile: AgentProfile): void {
    this.profile = nextProfile;
    this.adapter = createAdapterForAgentProfile(this.processManager, this.profile);
  }
}
