/**
 * Agent Coordinator — runner-owned lifecycle manager for agent teams.
 *
 * Responsibilities:
 * - Spawn teammate worker tasks from agents.members (agent refs)
 * - Set per-teammate env (ROBOPPI_AGENTS_CONTEXT_DIR, etc.)
 * - Run periodic housekeeping while the agents is active
 * - Bridge mailbox/task events into ExecEventSink (agent_* variants)
 * - Deterministic shutdown/cleanup at workflow end
 *
 * See `docs/features/agents.md` §3, §7.
 */
import { readFile, readdir, rm, rename as fsRename, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { housekeepMailbox, housekeepTasksInProgress } from "./housekeeping.js";
import { readTeam, readMembers, deliverMessage } from "./store.js";
import { appendAgentEvent } from "./agent-events.js";
import {
  mailboxEventsPath,
  tasksEventsPath,
  membersJsonPath,
  mailboxRoot,
  tasksRoot,
  agentsRoot,
  inboxNew,
  inboxProcessing,
  inboxCur,
  inboxDead,
} from "./paths.js";
import { ResidentAgent } from "./resident-agent.js";
import {
  DEFAULT_RECONCILE_INTERVAL_MS,
  DEFAULT_MAX_TEAMMATES,
  DEFAULT_MAX_SPAWNS_PER_MINUTE,
  DEFAULT_BROKER_PREVIEW_MAX_BYTES,
} from "./constants.js";
import type { ExecEventSink } from "../tui/exec-event.js";
import type { AgentMessage, MailboxEvent, TaskEvent, CleanupPolicy, MemberEntry } from "./types.js";
import type { StepRunner, StepRunResult } from "../workflow/executor.js";
import type { AgentMemberConfig } from "../workflow/types.js";
import type { AgentCatalog, AgentProfile } from "../workflow/agent-catalog.js";
import type { StepDefinition } from "../workflow/types.js";

const DEFAULT_HOUSEKEEP_INTERVAL_MS = 60_000; // 1 minute
const DEFAULT_TAIL_INTERVAL_MS = 2_000; // 2 seconds
const DEFAULT_TEAMMATE_SHUTDOWN_WAIT_MS = 30_000; // 30 seconds
const CHAT_BODY_PREVIEW_MAX_BYTES = DEFAULT_BROKER_PREVIEW_MAX_BYTES;

function truncateBodyPreview(body: string): string | undefined {
  if (!body) return undefined;

  const bodyBytes = Buffer.from(body, "utf-8");
  if (bodyBytes.length <= CHAT_BODY_PREVIEW_MAX_BYTES) {
    return body;
  }

  return `${bodyBytes.subarray(0, CHAT_BODY_PREVIEW_MAX_BYTES).toString("utf-8")}...`;
}

export interface AgentCoordinatorOptions {
  contextDir: string;
  sink: ExecEventSink;
  housekeepIntervalMs?: number;
  tailIntervalMs?: number;

  // Teammate spawning options (optional — when omitted, no teammates are spawned)
  stepRunner?: StepRunner;
  workspaceDir?: string;
  agentCatalog?: AgentCatalog;
  members?: Record<string, AgentMemberConfig>;
  leadMemberId?: string;
  teamId?: string;
  baseEnv?: Record<string, string>;
  teammateShutdownWaitMs?: number;

  // Dynamic membership reconcile options
  reconcileIntervalMs?: number;
  maxTeammates?: number;
  maxSpawnsPerMinute?: number;
}

interface TeammateHandle {
  memberId: string;
  abortController: AbortController;
  promise: Promise<StepRunResult>;
  settled: boolean;
}

export class AgentCoordinator {
  private readonly contextDir: string;
  private readonly sink: ExecEventSink;
  private readonly housekeepIntervalMs: number;
  private readonly tailIntervalMs: number;

  // Teammate spawning
  private readonly stepRunner?: StepRunner;
  private readonly workspaceDir?: string;
  private readonly agentCatalog?: AgentCatalog;
  private readonly members?: Record<string, AgentMemberConfig>;
  private readonly leadMemberId?: string;
  private readonly baseEnv?: Record<string, string>;
  private readonly teammateShutdownWaitMs: number;
  /** @deprecated Legacy one-shot teammates — kept for CUSTOM workers. */
  private readonly teammates: TeammateHandle[] = [];
  /** Persistent resident agents that stay alive and dispatch CLI agents on demand. */
  private readonly residentAgents: ResidentAgent[] = [];

  private housekeepTimer: ReturnType<typeof setInterval> | null = null;
  private tailTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private mailboxTailOffset = 0;
  private tasksTailOffset = 0;
  private teamId: string | undefined;
  private stopped = false;

  // Dynamic membership reconcile
  private readonly reconcileIntervalMs: number;
  private readonly maxTeammates: number;
  private readonly maxSpawnsPerMinute: number;
  private readonly spawnTimestamps: number[] = [];

  constructor(opts: AgentCoordinatorOptions) {
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
    this.reconcileIntervalMs = opts.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.maxTeammates = opts.maxTeammates ?? (
      Number(process.env.ROBOPPI_AGENTS_MAX_TEAMMATES) || DEFAULT_MAX_TEAMMATES
    );
    this.maxSpawnsPerMinute = opts.maxSpawnsPerMinute ?? DEFAULT_MAX_SPAWNS_PER_MINUTE;
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
            message: `[agents] ${warning}`,
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

    // Start periodic reconcile loop for dynamic membership
    if (this.workspaceDir) {
      this.reconcileTimer = setInterval(() => {
        if (this.stopped) return;
        this.reconcile().catch(() => {});
      }, this.reconcileIntervalMs);
    }
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
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
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
      await appendAgentEvent(this.contextDir, {
        ts: Date.now(),
        type: "agent_cleanup",
        team_id: this.teamId ?? "unknown",
        teammates_settled: this.teammates.filter((t) => t.settled).length + this.residentAgents.length,
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
    if (!this.workspaceDir || !this.members || !this.leadMemberId) {
      return; // No teammate spawning configured
    }

    const memberEntries = Object.entries(this.members);
    for (const [memberId, memberCfg] of memberEntries) {
      if (memberId === this.leadMemberId) continue; // Lead is the workflow itself

      const agentProfile = this.agentCatalog?.[memberCfg.agent];
      const workerKind = agentProfile?.worker ?? "CLAUDE_CODE";

      // CUSTOM workers still use the legacy one-shot StepRunner path
      if (workerKind === "CUSTOM" && this.stepRunner) {
        await this.spawnLegacyTeammate(memberId, agentProfile);
        continue;
      }

      // LLM-backed workers use the persistent ResidentAgent
      await this.spawnResidentAgent(memberId, agentProfile);
    }
  }

  private async spawnResidentAgent(memberId: string, agentProfile?: AgentProfile): Promise<void> {
    if (!this.workspaceDir) return;

    const teammateEnv: Record<string, string> = {
      ...(this.baseEnv ?? {}),
      ROBOPPI_AGENTS_CONTEXT_DIR: this.contextDir,
      ROBOPPI_AGENTS_TEAM_ID: this.teamId ?? "",
      ROBOPPI_AGENTS_MEMBER_ID: memberId,
      ROBOPPI_AGENTS_MEMBERS_FILE: membersJsonPath(this.contextDir),
    };

    const agent = new ResidentAgent({
      contextDir: this.contextDir,
      memberId,
      teamId: this.teamId ?? "",
      profile: agentProfile ?? {},
      workspaceDir: this.workspaceDir,
      sink: this.sink,
      env: teammateEnv,
    });

    agent.start();
    this.residentAgents.push(agent);
  }

  private async spawnLegacyTeammate(memberId: string, profile?: AgentProfile): Promise<void> {
    if (!this.stepRunner || !this.workspaceDir) return;

    // CUSTOM workers use shell script instructions
    const parts: string[] = [];
    if (profile?.base_instructions) {
      parts.push(profile.base_instructions);
    }
    parts.push(
      `# agent teammate: ${memberId}`,
      `# Use roboppi agents commands to communicate with the team.`,
    );

    const stepDef: StepDefinition = {
      worker: profile?.worker ?? "CUSTOM",
      instructions: parts.join("\n"),
      capabilities: (profile?.capabilities ?? ["READ", "EDIT", "MAILBOX", "TASKS"]) as StepDefinition["capabilities"],
      ...(profile?.timeout ? { timeout: profile.timeout } : {}),
    };

    const teammateEnv: Record<string, string> = {
      ...(this.baseEnv ?? {}),
      ROBOPPI_AGENTS_CONTEXT_DIR: this.contextDir,
      ROBOPPI_AGENTS_TEAM_ID: this.teamId ?? "",
      ROBOPPI_AGENTS_MEMBER_ID: memberId,
      ROBOPPI_AGENTS_MEMBERS_FILE: membersJsonPath(this.contextDir),
    };

    const ac = new AbortController();
    const stepId = `_agent:${memberId}`;

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

    promise.then(
      () => { handle.settled = true; },
      () => { handle.settled = true; },
    );

    this.teammates.push(handle);
  }

  // -----------------------------------------------------------------------
  // Dynamic membership reconcile
  // -----------------------------------------------------------------------

  private async reconcile(): Promise<void> {
    if (this.stopped || !this.workspaceDir || !this.leadMemberId) return;

    let desiredMembers: MemberEntry[];
    try {
      const config = await readMembers(this.contextDir);
      desiredMembers = config.members;
    } catch {
      return; // members.json not readable yet
    }

    if (this.stopped) return;

    // Sort by member_id for determinism
    desiredMembers.sort((a, b) => a.member_id.localeCompare(b.member_id));

    // A desired member may still need to respawn if its prior ResidentAgent
    // stopped unexpectedly. Prune stopped entries before computing spawn gaps
    // so reconcile does not treat a dead agent as satisfying desired state.
    this.removeStoppedResidentAgents();

    if (this.stopped) return;

    // Build sets for diff
    const desiredIds = new Set(
      desiredMembers
        .filter((m) => m.member_id !== this.leadMemberId && m.role !== "human" && m.role !== "dormant")
        .map((m) => m.member_id),
    );
    const runningResidentIds = new Set(
      this.residentAgents
        .filter((a) => a.isRunning)
        .map((a) => a.memberId),
    );
    const runningLegacyIds = new Set(
      this.teammates
        .filter((t) => !t.settled)
        .map((t) => t.memberId),
    );

    // Spawn missing (desired but not running)
    for (const member of desiredMembers) {
      if (this.stopped) return;
      if (member.member_id === this.leadMemberId) continue;
      if (member.role === "human") continue;
      if (member.role === "dormant") continue;
      if (runningResidentIds.has(member.member_id)) continue;
      if (runningLegacyIds.has(member.member_id)) continue;
      // Skip members with existing resident agents (even stopped — cleaned below)
      if (this.residentAgents.some((a) => a.memberId === member.member_id)) continue;
      if (this.teammates.some((t) => t.memberId === member.member_id)) continue;

      // Runaway guard: max teammates cap
      const activeCount =
        this.residentAgents.filter((a) => a.isRunning).length +
        this.teammates.filter((t) => !t.settled).length;
      if (activeCount >= this.maxTeammates) {
        this.sink.emit({
          type: "warning",
          ts: Date.now(),
          message: `[agents] Max teammates cap (${this.maxTeammates}) reached, skipping spawn of "${member.member_id}"`,
        });
        break;
      }

      if (!this.checkSpawnRateLimit()) {
        this.sink.emit({
          type: "warning",
          ts: Date.now(),
          message: `[agents] Spawn rate limit (${this.maxSpawnsPerMinute}/min) reached, deferring spawn of "${member.member_id}"`,
        });
        break;
      }

      await this.spawnSingleTeammate(member);

      if (this.stopped) return;
    }

    if (this.stopped) return;

    // Shutdown removed resident agents
    for (const agent of this.residentAgents) {
      if (desiredIds.has(agent.memberId)) continue;
      if (agent.isRunning) {
        agent.stop();
      }
    }
    // Clean up stopped resident agents for removed members
    for (let i = this.residentAgents.length - 1; i >= 0; i--) {
      const a = this.residentAgents[i]!;
      if (!desiredIds.has(a.memberId) && !a.isRunning) {
        this.residentAgents.splice(i, 1);
      }
    }

    // Shutdown removed legacy teammates
    for (const handle of this.teammates) {
      if (desiredIds.has(handle.memberId)) continue;
      if (!handle.settled) {
        await this.shutdownSingleTeammate(handle);
      }
    }
    for (let i = this.teammates.length - 1; i >= 0; i--) {
      const h = this.teammates[i]!;
      if (!desiredIds.has(h.memberId) && h.settled) {
        this.teammates.splice(i, 1);
      }
    }
  }

  private removeStoppedResidentAgents(): void {
    for (let i = this.residentAgents.length - 1; i >= 0; i--) {
      const agent = this.residentAgents[i]!;
      if (!agent.isRunning) {
        this.residentAgents.splice(i, 1);
      }
    }
  }

  private checkSpawnRateLimit(): boolean {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    // Prune old timestamps
    while (this.spawnTimestamps.length > 0 && this.spawnTimestamps[0]! < oneMinuteAgo) {
      this.spawnTimestamps.shift();
    }
    if (this.spawnTimestamps.length >= this.maxSpawnsPerMinute) {
      return false;
    }
    this.spawnTimestamps.push(now);
    return true;
  }

  private async spawnSingleTeammate(member: MemberEntry): Promise<void> {
    if (!this.workspaceDir) return;

    const agentId = member.agent;
    const agentProfile = agentId ? this.agentCatalog?.[agentId] : undefined;
    const workerKind = agentProfile?.worker ?? "CLAUDE_CODE";

    // CUSTOM workers use legacy one-shot path
    if (workerKind === "CUSTOM") {
      await this.spawnLegacyTeammate(member.member_id, agentProfile);
      return;
    }

    // LLM-backed workers use ResidentAgent
    await this.spawnResidentAgent(member.member_id, agentProfile);
  }

  private async shutdownSingleTeammate(handle: TeammateHandle): Promise<void> {
    // Send shutdown_request
    try {
      await deliverMessage({
        contextDir: this.contextDir,
        teamId: this.teamId ?? "",
        fromMemberId: this.leadMemberId ?? "lead",
        fromName: "Coordinator",
        toMemberId: handle.memberId,
        kind: "shutdown_request",
        topic: "shutdown",
        body: "Member removed from desired state.",
      });
    } catch {
      // best-effort
    }

    // Bounded abort after a short wait
    const shutdownWait = Math.min(this.teammateShutdownWaitMs, 10_000);
    await Promise.race([
      handle.promise,
      new Promise<void>((r) => setTimeout(r, shutdownWait)),
    ]).catch(() => {});

    if (!handle.settled) {
      handle.abortController.abort("agent_member_removed");
    }
  }

  // -----------------------------------------------------------------------
  // Teammate shutdown
  // -----------------------------------------------------------------------

  private async shutdownTeammates(): Promise<void> {
    // 1. Stop all ResidentAgents (they handle their own CLI agent cancellation)
    for (const agent of this.residentAgents) {
      agent.stop();
    }

    // Wait for all resident agents to settle (bounded)
    if (this.residentAgents.length > 0) {
      await Promise.race([
        Promise.allSettled(this.residentAgents.map((a) => a.settled)),
        new Promise<void>((r) => setTimeout(r, this.teammateShutdownWaitMs)),
      ]).catch(() => {});
    }

    // 2. Handle legacy (CUSTOM) teammates via the old shutdown protocol
    if (this.teammates.length === 0) return;

    const shutdownMessageIds: Map<string, string> = new Map();
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

    const deadline = Date.now() + this.teammateShutdownWaitMs;
    const ackedMembers = new Set<string>();

    while (Date.now() < deadline) {
      const unsettled = this.teammates.filter(
        (t) => !t.settled && !ackedMembers.has(t.memberId),
      );
      if (unsettled.length === 0) break;

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

      const stillPending = this.teammates.filter(
        (t) => !t.settled && !ackedMembers.has(t.memberId),
      );
      if (stillPending.length === 0) break;

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([
        Promise.allSettled(stillPending.map((t) => t.promise)),
        new Promise<void>((r) => setTimeout(r, Math.min(1000, remaining))),
      ]);
    }

    for (const t of this.teammates) {
      if (!t.settled) {
        t.abortController.abort("agent_shutdown");
      }
    }

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

    // Atomic cleanup: rename-to-trash under _agents/.trash/ then rm
    // (never moves artifacts outside context_dir/_agents, never shows partial deletions)
    const trashBase = resolve(agentsRoot(this.contextDir), ".trash", randomUUID());

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
        await this.emitMailboxEvent(event);
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

  private async emitMailboxEvent(event: MailboxEvent): Promise<void> {
    const teamId = this.teamId ?? "unknown";
    const bodyPreview = await this.resolveMailboxBodyPreview(event);

    switch (event.type) {
      case "message_delivered":
        this.sink.emit({
          type: "agent_message_sent",
          ts: event.ts,
          teamId,
          messageId: event.message_id,
          fromMemberId: event.from ?? "unknown",
          toMemberId: event.to,
          topic: event.topic ?? "",
          bodyPreview,
        });
        break;

      case "message_claimed":
        this.sink.emit({
          type: "agent_message_received",
          ts: event.ts,
          teamId,
          messageId: event.message_id,
          fromMemberId: event.from ?? "unknown",
          toMemberId: event.by ?? event.to ?? "unknown",
          topic: event.topic ?? "",
          bodyPreview,
        });
        break;

      // message_acked, message_requeued, message_dead: emit as warnings
      case "message_requeued":
      case "message_dead":
        this.sink.emit({
          type: "warning",
          ts: event.ts,
          message: `[agents] ${event.type}: message ${event.message_id} (attempt ${event.delivery_attempt ?? "?"})`,
        });
        break;
    }
  }

  private async resolveMailboxBodyPreview(
    event: MailboxEvent,
  ): Promise<string | undefined> {
    if (event.body_preview) return event.body_preview;
    if (event.type !== "message_delivered" && event.type !== "message_claimed") {
      return undefined;
    }

    const recipientId = event.to ?? event.by;
    if (!recipientId) return undefined;

    const message = await this.readMailboxMessage(recipientId, event.message_id);
    if (!message?.body) return undefined;

    return truncateBodyPreview(message.body);
  }

  private async readMailboxMessage(
    memberId: string,
    messageId: string,
  ): Promise<AgentMessage | null> {
    const dirs = [
      inboxNew(this.contextDir, memberId),
      inboxProcessing(this.contextDir, memberId),
      inboxCur(this.contextDir, memberId),
      inboxDead(this.contextDir, memberId),
    ];

    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }

      const filename = entries.find((entry) => entry.endsWith(".json") && entry.includes(messageId));
      if (!filename) continue;

      try {
        const raw = await readFile(resolve(dir, filename), "utf-8");
        return JSON.parse(raw) as AgentMessage;
      } catch {
        continue;
      }
    }

    return null;
  }

  private emitTaskEvent(event: TaskEvent): void {
    const teamId = this.teamId ?? "unknown";

    switch (event.type) {
      case "task_claimed":
        this.sink.emit({
          type: "agent_task_claimed",
          ts: event.ts,
          teamId,
          taskId: event.task_id,
          byMemberId: event.by ?? "unknown",
          title: event.title,
        });
        break;

      case "task_completed":
        this.sink.emit({
          type: "agent_task_completed",
          ts: event.ts,
          teamId,
          taskId: event.task_id,
          byMemberId: event.by ?? "unknown",
          title: event.title,
        });
        break;

      case "task_superseded":
        this.sink.emit({
          type: "agent_task_superseded",
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
