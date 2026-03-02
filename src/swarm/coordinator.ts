/**
 * Swarm Coordinator — runner-owned lifecycle manager for swarm teams.
 *
 * Responsibilities:
 * - Spawn teammate worker tasks from swarm.members (agent refs)
 * - Set per-teammate env (ROBOPPI_SWARM_CONTEXT_DIR, etc.)
 * - Run periodic housekeeping while the swarm is active
 * - Bridge mailbox/task events into ExecEventSink (swarm_* variants)
 * - Deterministic shutdown/cleanup at workflow end
 *
 * See `docs/features/swarm.md` §3, §7.
 */
import { readFile, rm, rename as fsRename, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { housekeepMailbox, housekeepTasksInProgress } from "./housekeeping.js";
import { readTeam, deliverMessage } from "./store.js";
import { appendSwarmEvent } from "./swarm-events.js";
import { mailboxEventsPath, tasksEventsPath, membersJsonPath, mailboxRoot, tasksRoot, swarmRoot } from "./paths.js";
import type { ExecEventSink } from "../tui/exec-event.js";
import type { MailboxEvent, TaskEvent, CleanupPolicy } from "./types.js";
import type { StepRunner, StepRunResult } from "../workflow/executor.js";
import type { SwarmMemberConfig } from "../workflow/types.js";
import type { AgentCatalog, AgentProfile } from "../workflow/agent-catalog.js";
import type { StepDefinition } from "../workflow/types.js";

const DEFAULT_HOUSEKEEP_INTERVAL_MS = 60_000; // 1 minute
const DEFAULT_TAIL_INTERVAL_MS = 2_000; // 2 seconds
const DEFAULT_TEAMMATE_SHUTDOWN_WAIT_MS = 30_000; // 30 seconds

export interface SwarmCoordinatorOptions {
  contextDir: string;
  sink: ExecEventSink;
  housekeepIntervalMs?: number;
  tailIntervalMs?: number;

  // Teammate spawning options (optional — when omitted, no teammates are spawned)
  stepRunner?: StepRunner;
  workspaceDir?: string;
  agentCatalog?: AgentCatalog;
  members?: Record<string, SwarmMemberConfig>;
  leadMemberId?: string;
  teamId?: string;
  baseEnv?: Record<string, string>;
  teammateShutdownWaitMs?: number;
}

interface TeammateHandle {
  memberId: string;
  abortController: AbortController;
  promise: Promise<StepRunResult>;
  settled: boolean;
}

export class SwarmCoordinator {
  private readonly contextDir: string;
  private readonly sink: ExecEventSink;
  private readonly housekeepIntervalMs: number;
  private readonly tailIntervalMs: number;

  // Teammate spawning
  private readonly stepRunner?: StepRunner;
  private readonly workspaceDir?: string;
  private readonly agentCatalog?: AgentCatalog;
  private readonly members?: Record<string, SwarmMemberConfig>;
  private readonly leadMemberId?: string;
  private readonly baseEnv?: Record<string, string>;
  private readonly teammateShutdownWaitMs: number;
  private readonly teammates: TeammateHandle[] = [];

  private housekeepTimer: ReturnType<typeof setInterval> | null = null;
  private tailTimer: ReturnType<typeof setInterval> | null = null;
  private mailboxTailOffset = 0;
  private tasksTailOffset = 0;
  private teamId: string | undefined;
  private stopped = false;

  constructor(opts: SwarmCoordinatorOptions) {
    this.contextDir = opts.contextDir;
    this.sink = opts.sink;
    this.housekeepIntervalMs = opts.housekeepIntervalMs ?? DEFAULT_HOUSEKEEP_INTERVAL_MS;
    this.tailIntervalMs = opts.tailIntervalMs ?? DEFAULT_TAIL_INTERVAL_MS;

    this.stepRunner = opts.stepRunner;
    this.workspaceDir = opts.workspaceDir;
    this.agentCatalog = opts.agentCatalog;
    this.members = opts.members;
    this.leadMemberId = opts.leadMemberId;
    this.teamId = opts.teamId;
    this.baseEnv = opts.baseEnv;
    this.teammateShutdownWaitMs = opts.teammateShutdownWaitMs ?? DEFAULT_TEAMMATE_SHUTDOWN_WAIT_MS;
  }

  /**
   * Start the coordinator: spawn teammates, begin housekeeping and event tailing.
   */
  async start(): Promise<void> {
    // Read team ID for event emission (may already be set via opts)
    if (!this.teamId) {
      try {
        const team = await readTeam(this.contextDir);
        this.teamId = team.team_id;
      } catch {
        // If team.json doesn't exist yet, teamId stays undefined
      }
    }

    // Spawn teammate worker tasks for non-lead members
    await this.spawnTeammates();

    // Start periodic housekeeping (mailbox + tasks)
    this.housekeepTimer = setInterval(async () => {
      if (this.stopped) return;
      try {
        const mailboxResult = await housekeepMailbox({ contextDir: this.contextDir });
        const taskResult = await housekeepTasksInProgress({ contextDir: this.contextDir });
        // Emit warnings for dead-lettered messages and requeued tasks
        for (const warning of [...mailboxResult.warnings, ...taskResult.warnings]) {
          this.sink.emit({
            type: "warning",
            ts: Date.now(),
            message: `[swarm] ${warning}`,
          });
        }
      } catch {
        // Housekeeping is best-effort
      }
    }, this.housekeepIntervalMs);

    // Start tailing event logs
    this.tailTimer = setInterval(() => {
      if (this.stopped) return;
      this.tailEvents().catch(() => {});
    }, this.tailIntervalMs);

    // Initial tail
    await this.tailEvents().catch(() => {});
  }

  /**
   * Stop the coordinator: shutdown teammates, clear timers, apply cleanup policy,
   * and emit final metadata-only cleanup event.
   *
   * Spec 3.2: coordinator shutdown MUST verify completion, apply cleanup policy,
   * and emit a final metadata-only event.
   */
  async stop(): Promise<void> {
    this.stopped = true;

    // 1. Request deterministic teammate shutdown
    await this.shutdownTeammates();

    // 2. Clear timers
    if (this.housekeepTimer) {
      clearInterval(this.housekeepTimer);
      this.housekeepTimer = null;
    }
    if (this.tailTimer) {
      clearInterval(this.tailTimer);
      this.tailTimer = null;
    }

    // 3. Final tail to capture any remaining events
    await this.tailEvents().catch(() => {});

    // 4. Final housekeeping
    try {
      await housekeepMailbox({ contextDir: this.contextDir });
      await housekeepTasksInProgress({ contextDir: this.contextDir });
    } catch {
      // best-effort
    }

    // 5. Apply cleanup policy from team.json (Spec 3.2)
    const cleanupResult = await this.applyCleanupPolicy();

    // 6. Emit final metadata-only cleanup event (survives mailbox/tasks deletion)
    try {
      await appendSwarmEvent(this.contextDir, {
        ts: Date.now(),
        type: "swarm_cleanup",
        team_id: this.teamId ?? "unknown",
        teammates_settled: this.teammates.filter((t) => t.settled).length,
        teammates_aborted: this.teammates.filter((t) => !t.settled).length,
        mailbox_retained: cleanupResult.mailboxRetained,
        tasks_retained: cleanupResult.tasksRetained,
      });
    } catch {
      // best-effort
    }
  }

  // -----------------------------------------------------------------------
  // Teammate spawning
  // -----------------------------------------------------------------------

  private async spawnTeammates(): Promise<void> {
    if (!this.stepRunner || !this.workspaceDir || !this.members || !this.leadMemberId) {
      return; // No teammate spawning configured
    }

    const memberEntries = Object.entries(this.members);
    for (const [memberId, memberCfg] of memberEntries) {
      if (memberId === this.leadMemberId) continue; // Lead is the workflow itself

      const agentProfile = this.agentCatalog?.[memberCfg.agent];

      // Build a synthetic StepDefinition from the agent profile
      const stepDef: StepDefinition = {
        worker: agentProfile?.worker ?? "CLAUDE_CODE",
        ...(agentProfile?.model ? { model: agentProfile.model } : {}),
        instructions: this.buildTeammateInstructions(memberId, agentProfile),
        capabilities: (agentProfile?.capabilities ?? ["READ", "EDIT", "MAILBOX", "TASKS"]) as StepDefinition["capabilities"],
        ...(agentProfile?.workspace ? { workspace: agentProfile.workspace } : {}),
        ...(agentProfile?.timeout ? { timeout: agentProfile.timeout } : {}),
        ...(agentProfile?.max_steps !== undefined ? { max_steps: agentProfile.max_steps } : {}),
        ...(agentProfile?.max_command_time ? { max_command_time: agentProfile.max_command_time } : {}),
      };

      // Per-teammate env
      const teammateEnv: Record<string, string> = {
        ...(this.baseEnv ?? {}),
        ROBOPPI_SWARM_CONTEXT_DIR: this.contextDir,
        ROBOPPI_SWARM_TEAM_ID: this.teamId ?? "",
        ROBOPPI_SWARM_MEMBER_ID: memberId,
        ROBOPPI_SWARM_MEMBERS_FILE: membersJsonPath(this.contextDir),
      };

      const ac = new AbortController();
      const stepId = `_swarm:${memberId}`;

      // Fire-and-forget: the teammate runs as a long-lived worker task
      const promise = this.stepRunner.runStep(
        stepId,
        stepDef,
        this.workspaceDir,
        ac.signal,
        teammateEnv,
        this.sink,
      );

      const handle: TeammateHandle = {
        memberId,
        abortController: ac,
        promise,
        settled: false,
      };

      // Mark as settled when done
      promise.then(
        () => { handle.settled = true; },
        () => { handle.settled = true; },
      );

      this.teammates.push(handle);
    }
  }

  private buildTeammateInstructions(memberId: string, profile?: AgentProfile): string {
    const workerKind = profile?.worker ?? "CLAUDE_CODE";

    if (workerKind === "CUSTOM") {
      // CUSTOM workers execute instructions as a shell script.
      // base_instructions must be a valid script; append guidance as comments only.
      const parts: string[] = [];
      if (profile?.base_instructions) {
        parts.push(profile.base_instructions);
      }
      parts.push(
        `# swarm teammate: ${memberId}`,
        `# Use roboppi swarm commands to communicate with the team.`,
      );
      return parts.join("\n");
    }

    // LLM-backed workers (CLAUDE_CODE, OPENCODE, CODEX_CLI): natural-language instructions.
    const parts: string[] = [];
    if (profile?.base_instructions) {
      parts.push(profile.base_instructions);
    }
    parts.push(
      `You are team member "${memberId}".`,
      `Use \`roboppi swarm\` commands to communicate with your team and manage tasks.`,
      `Check for messages: roboppi swarm message recv --claim`,
      `Check for tasks: roboppi swarm tasks list --status pending`,
      `When you have no work to do, send an idle message to the lead.`,
      `When you receive a shutdown_request, acknowledge and stop.`,
    );
    return parts.join("\n");
  }

  // -----------------------------------------------------------------------
  // Teammate shutdown
  // -----------------------------------------------------------------------

  private async shutdownTeammates(): Promise<void> {
    if (this.teammates.length === 0) return;

    // 1. Send shutdown_request messages to each running teammate, track message IDs
    const shutdownMessageIds: Map<string, string> = new Map(); // memberId -> messageId
    for (const t of this.teammates) {
      if (t.settled) continue;
      try {
        const result = await deliverMessage({
          contextDir: this.contextDir,
          teamId: this.teamId ?? "",
          fromMemberId: this.leadMemberId ?? "lead",
          fromName: "Coordinator",
          toMemberId: t.memberId,
          kind: "shutdown_request",
          topic: "shutdown",
          body: "Workflow ending, please shut down.",
        });
        shutdownMessageIds.set(t.memberId, result.messageId);
      } catch {
        // best-effort
      }
    }

    // 2. Bounded wait: poll for teammate settlement or ack evidence
    const deadline = Date.now() + this.teammateShutdownWaitMs;
    const ackedMembers = new Set<string>();

    while (Date.now() < deadline) {
      // Check which teammates are still running and not acked
      const unsettled = this.teammates.filter(
        (t) => !t.settled && !ackedMembers.has(t.memberId),
      );
      if (unsettled.length === 0) break;

      // Check for ack evidence in mailbox events
      if (shutdownMessageIds.size > 0) {
        try {
          const eventsContent = await readFile(
            mailboxEventsPath(this.contextDir),
            "utf-8",
          );
          for (const line of eventsContent.split("\n")) {
            if (!line) continue;
            try {
              const evt = JSON.parse(line) as { type: string; message_id?: string; by?: string };
              if (evt.type === "message_acked" && evt.message_id) {
                for (const [memberId, msgId] of shutdownMessageIds) {
                  if (evt.message_id === msgId) {
                    ackedMembers.add(memberId);
                  }
                }
              }
            } catch {
              // skip malformed lines
            }
          }
        } catch {
          // events file may not exist
        }
      }

      // Re-check after ack scan
      const stillPending = this.teammates.filter(
        (t) => !t.settled && !ackedMembers.has(t.memberId),
      );
      if (stillPending.length === 0) break;

      // Wait a short interval before re-checking
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([
        Promise.allSettled(stillPending.map((t) => t.promise)),
        new Promise<void>((r) => setTimeout(r, Math.min(1000, remaining))),
      ]);
    }

    // 3. Force-abort ALL teammates still running after timeout (Spec 3.2)
    // Even teammates with ack evidence get aborted if they haven't settled yet.
    for (const t of this.teammates) {
      if (!t.settled) {
        t.abortController.abort("swarm_shutdown");
      }
    }

    // 4. Bounded wait for aborted teammates to settle (5s hard cap)
    const settleDeadlineMs = 5_000;
    await Promise.race([
      Promise.allSettled(this.teammates.map((t) => t.promise)),
      new Promise<void>((r) => setTimeout(r, settleDeadlineMs)),
    ]).catch(() => {});
  }

  // -----------------------------------------------------------------------
  // Cleanup policy (Spec 3.2)
  // -----------------------------------------------------------------------

  private async applyCleanupPolicy(): Promise<{
    mailboxRetained: boolean;
    tasksRetained: boolean;
  }> {
    let cleanupPolicy: CleanupPolicy | undefined;
    try {
      const team = await readTeam(this.contextDir);
      cleanupPolicy = team.cleanup_policy;
    } catch {
      return { mailboxRetained: true, tasksRetained: true };
    }

    const retainMailbox = cleanupPolicy?.retain_mailbox ?? false;
    const retainTasks = cleanupPolicy?.retain_tasks ?? true;

    // Atomic cleanup: rename-to-trash under _swarm/.trash/ then rm
    // (never moves artifacts outside context_dir/_swarm, never shows partial deletions)
    const trashBase = resolve(swarmRoot(this.contextDir), ".trash", randomUUID());

    if (!retainMailbox) {
      try {
        const src = mailboxRoot(this.contextDir);
        const trashDest = resolve(trashBase, "mailbox");
        await mkdir(trashBase, { recursive: true });
        await fsRename(src, trashDest);
        await rm(trashBase, { recursive: true, force: true });
      } catch {
        // best-effort: directory may not exist
      }
    }

    if (!retainTasks) {
      try {
        const src = tasksRoot(this.contextDir);
        const trashDest = resolve(trashBase, "tasks");
        await mkdir(trashBase, { recursive: true });
        await fsRename(src, trashDest);
        await rm(trashBase, { recursive: true, force: true });
      } catch {
        // best-effort: directory may not exist
      }
    }

    return { mailboxRetained: retainMailbox, tasksRetained: retainTasks };
  }

  // -----------------------------------------------------------------------
  // Event tailing
  // -----------------------------------------------------------------------

  private async tailEvents(): Promise<void> {
    await this.tailMailboxEvents();
    await this.tailTaskEvents();
  }

  private async tailMailboxEvents(): Promise<void> {
    const eventsPath = mailboxEventsPath(this.contextDir);
    let content: string;
    try {
      content = await readFile(eventsPath, "utf-8");
    } catch {
      return; // file doesn't exist yet
    }

    const lines = content.split("\n").filter(Boolean);
    const newLines = lines.slice(this.mailboxTailOffset);
    this.mailboxTailOffset = lines.length;

    for (const line of newLines) {
      try {
        const event = JSON.parse(line) as MailboxEvent;
        this.emitMailboxEvent(event);
      } catch {
        // skip malformed lines
      }
    }
  }

  private async tailTaskEvents(): Promise<void> {
    const eventsPath = tasksEventsPath(this.contextDir);
    let content: string;
    try {
      content = await readFile(eventsPath, "utf-8");
    } catch {
      return;
    }

    const lines = content.split("\n").filter(Boolean);
    const newLines = lines.slice(this.tasksTailOffset);
    this.tasksTailOffset = lines.length;

    for (const line of newLines) {
      try {
        const event = JSON.parse(line) as TaskEvent;
        this.emitTaskEvent(event);
      } catch {
        // skip malformed lines
      }
    }
  }

  private emitMailboxEvent(event: MailboxEvent): void {
    const teamId = this.teamId ?? "unknown";

    switch (event.type) {
      case "message_delivered":
        this.sink.emit({
          type: "swarm_message_sent",
          ts: event.ts,
          teamId,
          messageId: event.message_id,
          fromMemberId: event.from ?? "unknown",
          toMemberId: event.to,
          topic: event.topic ?? "",
        });
        break;

      case "message_claimed":
        this.sink.emit({
          type: "swarm_message_received",
          ts: event.ts,
          teamId,
          messageId: event.message_id,
          fromMemberId: event.from ?? "unknown",
          toMemberId: event.by ?? event.to ?? "unknown",
          topic: event.topic ?? "",
        });
        break;

      // message_acked, message_requeued, message_dead: emit as warnings
      case "message_requeued":
      case "message_dead":
        this.sink.emit({
          type: "warning",
          ts: event.ts,
          message: `[swarm] ${event.type}: message ${event.message_id} (attempt ${event.delivery_attempt ?? "?"})`,
        });
        break;
    }
  }

  private emitTaskEvent(event: TaskEvent): void {
    const teamId = this.teamId ?? "unknown";

    switch (event.type) {
      case "task_claimed":
        this.sink.emit({
          type: "swarm_task_claimed",
          ts: event.ts,
          teamId,
          taskId: event.task_id,
          byMemberId: event.by ?? "unknown",
          title: event.title,
        });
        break;

      case "task_completed":
        this.sink.emit({
          type: "swarm_task_completed",
          ts: event.ts,
          teamId,
          taskId: event.task_id,
          byMemberId: event.by ?? "unknown",
          title: event.title,
        });
        break;

      // task_added, task_blocked: no specific ExecEvent type, emit as info if needed
    }
  }
}
