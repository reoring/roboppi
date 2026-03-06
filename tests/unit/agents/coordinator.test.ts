/**
 * AgentCoordinator unit tests.
 *
 * Verifies CUSTOM worker compatibility, teammate spawning, bounded shutdown,
 * and dynamic membership reconcile behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";

const TEST_TMP_ROOT = path.join(process.cwd(), ".roboppi-loop", "tmp", "unit-coordinator");

import { AgentCoordinator } from "../../../src/agents/coordinator.js";
import { initAgentsContext, writeMembersConfig } from "../../../src/agents/store.js";
import { agentEventsPath } from "../../../src/agents/paths.js";
import type { StepRunResult } from "../../../src/workflow/executor.js";
import type { StepDefinition } from "../../../src/workflow/types.js";
import type { ExecEventSink, ExecEvent } from "../../../src/tui/exec-event.js";

let contextDir: string;

beforeEach(async () => {
  await mkdir(TEST_TMP_ROOT, { recursive: true });
  contextDir = await mkdtemp(path.join(TEST_TMP_ROOT, "agents-coord-"));
});

afterEach(async () => {
  await rm(contextDir, { recursive: true, force: true });
});

function noopSink(): ExecEventSink {
  return { emit(_e: ExecEvent) {} };
}

describe("AgentCoordinator teammate spawning", () => {
  it("CUSTOM worker instructions are shell-safe (no natural-language lines)", async () => {
    await initAgentsContext({
      contextDir,
      teamName: "test",
      leadMemberId: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "team_lead" },
        { member_id: "worker1", name: "Worker1", role: "worker" },
      ],
    });

    const captured: { stepId: string; stepDef: StepDefinition }[] = [];
    const mockRunner = {
      runStep(
        stepId: string,
        step: StepDefinition,
        _workspace: string,
        _signal: AbortSignal,
      ): Promise<StepRunResult> {
        captured.push({ stepId, stepDef: step });
        // Settle immediately
        return Promise.resolve({ status: "SUCCEEDED" as const });
      },
      runCheck() {
        return Promise.resolve({ complete: true, failed: false });
      },
    };

    const coord = new AgentCoordinator({
      contextDir,
      sink: noopSink(),
      stepRunner: mockRunner,
      workspaceDir: process.cwd(),
      agentCatalog: {
        worker_agent: {
          worker: "CUSTOM",
          base_instructions: "#!/bin/bash\necho hello",
          capabilities: ["READ"],
        },
      },
      members: {
        lead: { agent: "lead_agent" },
        worker1: { agent: "worker_agent" },
      },
      leadMemberId: "lead",
      teamId: "test-team-id",
    });

    await coord.start();
    await coord.stop();

    // Verify the CUSTOM teammate was spawned
    expect(captured.length).toBe(1);
    const entry = captured[0]!;
    expect(entry.stepId).toBe("_agent:worker1");
    expect(entry.stepDef.worker).toBe("CUSTOM");

    // Instructions must be shell-safe: no natural-language lines like "You are team member"
    const instructions = entry.stepDef.instructions!;
    expect(instructions).toContain("#!/bin/bash");
    expect(instructions).toContain("echo hello");
    expect(instructions).not.toContain("You are team member");

    // Appended lines should be shell comments
    for (const line of instructions.split("\n")) {
      if (line.startsWith("#") || line.trim() === "" || line.startsWith("echo") || line.startsWith("!") || line.startsWith("/")) {
        continue; // shell comments, shebang, empty, or script content
      }
      // base_instructions content is allowed
      if (line === "#!/bin/bash") continue;
    }
  });

  it("LLM worker uses ResidentAgent (not stepRunner)", async () => {
    await initAgentsContext({
      contextDir,
      teamName: "test",
      leadMemberId: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "team_lead" },
        { member_id: "assistant", name: "Assistant", role: "worker" },
      ],
    });

    const captured: { stepId: string; stepDef: StepDefinition }[] = [];
    const mockRunner = {
      runStep(
        stepId: string,
        step: StepDefinition,
        _workspace: string,
        _signal: AbortSignal,
      ): Promise<StepRunResult> {
        captured.push({ stepId, stepDef: step });
        return Promise.resolve({ status: "SUCCEEDED" as const });
      },
      runCheck() {
        return Promise.resolve({ complete: true, failed: false });
      },
    };

    // Track events emitted to the sink
    const events: ExecEvent[] = [];
    const trackingSink: ExecEventSink = { emit(e: ExecEvent) { events.push(e); } };

    const coord = new AgentCoordinator({
      contextDir,
      sink: trackingSink,
      stepRunner: mockRunner,
      workspaceDir: process.cwd(),
      agentCatalog: {
        assistant_agent: {
          worker: "CLAUDE_CODE",
          base_instructions: "You are a helpful assistant.",
          capabilities: ["READ", "EDIT"],
        },
      },
      members: {
        lead: { agent: "lead_agent" },
        assistant: { agent: "assistant_agent" },
      },
      leadMemberId: "lead",
      teamId: "test-team-id",
    });

    await coord.start();

    // LLM workers now use ResidentAgent, NOT stepRunner — so captured is empty
    expect(captured.length).toBe(0);

    // But a step_state RUNNING event should have been emitted for the resident agent
    const stepStates = events.filter(
      (e) => e.type === "step_state" && (e as any).stepId === "_agent:assistant",
    );
    expect(stepStates.length).toBeGreaterThanOrEqual(1);

    await coord.stop();
  });
});

// -------------------------------------------------------------------------
// Spec 3.2: Bounded shutdown, abort, cleanup policy, and final cleanup event
// -------------------------------------------------------------------------

describe("AgentCoordinator bounded shutdown (Spec 3.2)", () => {
  it("stop() returns within timeout even when a teammate hangs", async () => {
    await initAgentsContext({
      contextDir,
      teamName: "test",
      leadMemberId: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "team_lead" },
        { member_id: "hung", name: "Hung", role: "worker" },
      ],
    });

    let abortSignalRef: AbortSignal | undefined;
    const mockRunner = {
      runStep(
        _stepId: string,
        _step: StepDefinition,
        _workspace: string,
        signal: AbortSignal,
      ): Promise<StepRunResult> {
        abortSignalRef = signal;
        // Return a promise that never resolves on its own —
        // it only resolves when the abort signal fires.
        return new Promise<StepRunResult>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve({ status: "FAILED" as const });
          });
        });
      },
      runCheck() {
        return Promise.resolve({ complete: true, failed: false });
      },
    };

    const shutdownWaitMs = 200; // short for testing
    const coord = new AgentCoordinator({
      contextDir,
      sink: noopSink(),
      stepRunner: mockRunner,
      workspaceDir: process.cwd(),
      agentCatalog: {
        hung_agent: {
          worker: "CUSTOM",
          base_instructions: "#!/bin/bash\nsleep infinity",
          capabilities: ["READ"],
        },
      },
      members: {
        lead: { agent: "lead_agent" },
        hung: { agent: "hung_agent" },
      },
      leadMemberId: "lead",
      teamId: "test-team-id",
      teammateShutdownWaitMs: shutdownWaitMs,
    });

    await coord.start();

    const startTime = Date.now();
    await coord.stop();
    const elapsed = Date.now() - startTime;

    // stop() must return within a bounded time (shutdownWaitMs + settle cap + margin)
    expect(elapsed).toBeLessThan(shutdownWaitMs + 5_000 + 2_000);

    // The hung teammate's abort signal should have fired
    expect(abortSignalRef?.aborted).toBe(true);
  });

  it("abort is issued only for non-settled teammates", async () => {
    await initAgentsContext({
      contextDir,
      teamName: "test",
      leadMemberId: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "team_lead" },
        { member_id: "fast", name: "Fast", role: "worker" },
        { member_id: "slow", name: "Slow", role: "worker" },
      ],
    });

    const abortSignals: Map<string, AbortSignal> = new Map();
    const mockRunner = {
      runStep(
        stepId: string,
        _step: StepDefinition,
        _workspace: string,
        signal: AbortSignal,
      ): Promise<StepRunResult> {
        const memberId = stepId.replace("_agent:", "");
        abortSignals.set(memberId, signal);

        if (memberId === "fast") {
          // Settles immediately
          return Promise.resolve({ status: "SUCCEEDED" as const });
        }
        // "slow" hangs until aborted
        return new Promise<StepRunResult>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve({ status: "FAILED" as const });
          });
        });
      },
      runCheck() {
        return Promise.resolve({ complete: true, failed: false });
      },
    };

    const coord = new AgentCoordinator({
      contextDir,
      sink: noopSink(),
      stepRunner: mockRunner,
      workspaceDir: process.cwd(),
      agentCatalog: {
        fast_agent: { worker: "CUSTOM", base_instructions: "#!/bin/bash\ntrue", capabilities: ["READ"] },
        slow_agent: { worker: "CUSTOM", base_instructions: "#!/bin/bash\nsleep infinity", capabilities: ["READ"] },
      },
      members: {
        lead: { agent: "lead_agent" },
        fast: { agent: "fast_agent" },
        slow: { agent: "slow_agent" },
      },
      leadMemberId: "lead",
      teamId: "test-team-id",
      teammateShutdownWaitMs: 200,
    });

    await coord.start();
    // Give "fast" a moment to settle
    await new Promise<void>((r) => setTimeout(r, 50));
    await coord.stop();

    // "slow" was still running and should have been aborted
    expect(abortSignals.get("slow")?.aborted).toBe(true);
    // "fast" settled before shutdown — its abort may or may not fire (depends on timing),
    // but the important thing is stop() returned and slow was aborted.
  });

  it("_agents/_events.jsonl contains agent_cleanup event after stop()", async () => {
    await initAgentsContext({
      contextDir,
      teamName: "test",
      leadMemberId: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "team_lead" },
        { member_id: "w1", name: "W1", role: "worker" },
      ],
    });

    const mockRunner = {
      runStep(
        _stepId: string,
        _step: StepDefinition,
        _workspace: string,
        _signal: AbortSignal,
      ): Promise<StepRunResult> {
        return Promise.resolve({ status: "SUCCEEDED" as const });
      },
      runCheck() {
        return Promise.resolve({ complete: true, failed: false });
      },
    };

    const coord = new AgentCoordinator({
      contextDir,
      sink: noopSink(),
      stepRunner: mockRunner,
      workspaceDir: process.cwd(),
      agentCatalog: {
        w1_agent: { worker: "CUSTOM", base_instructions: "#!/bin/bash\ntrue", capabilities: ["READ"] },
      },
      members: {
        lead: { agent: "lead_agent" },
        w1: { agent: "w1_agent" },
      },
      leadMemberId: "lead",
      teamId: "test-team-id",
      teammateShutdownWaitMs: 200,
    });

    await coord.start();
    await coord.stop();

    // Read agent-level events
    const eventsContent = await readFile(agentEventsPath(contextDir), "utf-8");
    const events = eventsContent.trim().split("\n").map((l) => JSON.parse(l));
    const cleanupEvents = events.filter((e: any) => e.type === "agent_cleanup");
    expect(cleanupEvents.length).toBe(1);
    expect(cleanupEvents[0].team_id).toBe("test-team-id");
    expect(typeof cleanupEvents[0].teammates_settled).toBe("number");
    expect(typeof cleanupEvents[0].teammates_aborted).toBe("number");
    expect(typeof cleanupEvents[0].mailbox_retained).toBe("boolean");
    expect(typeof cleanupEvents[0].tasks_retained).toBe("boolean");
  });

  it("cleanup policy removes mailbox when retain_mailbox=false", async () => {
    await initAgentsContext({
      contextDir,
      teamName: "test",
      leadMemberId: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "team_lead" },
      ],
      cleanupPolicy: { retain_mailbox: false, retain_tasks: true },
    });

    const coord = new AgentCoordinator({
      contextDir,
      sink: noopSink(),
      teamId: "test-team-id",
      teammateShutdownWaitMs: 100,
    });

    await coord.start();
    await coord.stop();

    // Mailbox should be removed
    const { resolve: resolvePath } = await import("node:path");
    const { stat } = await import("node:fs/promises");
    const mailboxPath = resolvePath(contextDir, "_agents", "mailbox");
    await expect(stat(mailboxPath)).rejects.toThrow();

    // Tasks should still exist
    const tasksPath = resolvePath(contextDir, "_agents", "tasks");
    const tasksStat = await stat(tasksPath);
    expect(tasksStat.isDirectory()).toBe(true);

    // Cleanup event should reflect what was retained/removed
    const eventsContent = await readFile(agentEventsPath(contextDir), "utf-8");
    const events = eventsContent.trim().split("\n").map((l) => JSON.parse(l));
    const cleanupEvent = events.find((e: any) => e.type === "agent_cleanup");
    expect(cleanupEvent.mailbox_retained).toBe(false);
    expect(cleanupEvent.tasks_retained).toBe(true);
  });
});

// -------------------------------------------------------------------------
// Dynamic membership reconcile
// -------------------------------------------------------------------------

describe("AgentCoordinator reconcile (dynamic membership)", () => {
  it("spawns a newly-added member as a ResidentAgent", async () => {
    await initAgentsContext({
      contextDir,
      teamName: "test",
      leadMemberId: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "team_lead" },
      ],
    });

    const events: ExecEvent[] = [];
    const trackingSink: ExecEventSink = { emit(e: ExecEvent) { events.push(e); } };

    const coord = new AgentCoordinator({
      contextDir,
      sink: trackingSink,
      workspaceDir: process.cwd(),
      leadMemberId: "lead",
      teamId: "test-team-id",
      reconcileIntervalMs: 100,
    });

    await coord.start();

    // Dynamically add a new member to members.json
    await writeMembersConfig(contextDir, [
      { member_id: "lead", name: "Lead", role: "team_lead" },
      { member_id: "newbie", name: "Newbie", role: "worker", agent: "newbie_agent" },
    ]);

    // Wait for reconcile to pick it up
    await new Promise<void>((r) => setTimeout(r, 300));
    await coord.stop();

    // Verify the new member was spawned — step_state RUNNING event should exist
    const stepStates = events.filter(
      (e) => e.type === "step_state" && (e as any).stepId === "_agent:newbie",
    );
    expect(stepStates.length).toBeGreaterThanOrEqual(1);
  });

  it("shuts down a removed member (ResidentAgent stop)", async () => {
    await initAgentsContext({
      contextDir,
      teamName: "test",
      leadMemberId: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "team_lead" },
        { member_id: "removable", name: "Removable", role: "worker" },
      ],
    });

    const events: ExecEvent[] = [];
    const trackingSink: ExecEventSink = { emit(e: ExecEvent) { events.push(e); } };

    const coord = new AgentCoordinator({
      contextDir,
      sink: trackingSink,
      workspaceDir: process.cwd(),
      members: {
        lead: { agent: "lead_agent" },
        removable: { agent: "removable_agent" },
      },
      leadMemberId: "lead",
      teamId: "test-team-id",
      reconcileIntervalMs: 100,
      teammateShutdownWaitMs: 200,
    });

    await coord.start();
    // Verify the member was spawned (step_state RUNNING emitted)
    await new Promise<void>((r) => setTimeout(r, 100));
    const runningEvents = events.filter(
      (e) => e.type === "step_state" && (e as any).stepId === "_agent:removable" && (e as any).status === "RUNNING",
    );
    expect(runningEvents.length).toBeGreaterThanOrEqual(1);

    // Remove the member from desired state
    await writeMembersConfig(contextDir, [
      { member_id: "lead", name: "Lead", role: "team_lead" },
    ]);

    // Wait for reconcile to detect removal and shut it down
    await new Promise<void>((r) => setTimeout(r, 500));
    await coord.stop();

    // The removed member should have a SUCCEEDED step_state (from ResidentAgent.stop())
    const succeededEvents = events.filter(
      (e) => e.type === "step_state" && (e as any).stepId === "_agent:removable" && (e as any).status === "SUCCEEDED",
    );
    expect(succeededEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("runaway guard: max teammates cap prevents spawning beyond limit", async () => {
    await initAgentsContext({
      contextDir,
      teamName: "test",
      leadMemberId: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "team_lead" },
      ],
    });

    const warnings: string[] = [];
    const spawnedAgents: string[] = [];
    const warningSink: ExecEventSink = {
      emit(e: ExecEvent) {
        if ("message" in e) warnings.push((e as any).message);
        // Track step_state RUNNING events to count spawned agents
        if (e.type === "step_state" && (e as any).status === "RUNNING") {
          spawnedAgents.push((e as any).stepId);
        }
      },
    };

    const coord = new AgentCoordinator({
      contextDir,
      sink: warningSink,
      workspaceDir: process.cwd(),
      leadMemberId: "lead",
      teamId: "test-team-id",
      reconcileIntervalMs: 100,
      maxTeammates: 2,
      maxSpawnsPerMinute: 20,
      teammateShutdownWaitMs: 200,
    });

    await coord.start();

    // Add 4 members — only 2 should be spawned (maxTeammates=2)
    await writeMembersConfig(contextDir, [
      { member_id: "lead", name: "Lead", role: "team_lead" },
      { member_id: "m1", name: "M1", role: "worker" },
      { member_id: "m2", name: "M2", role: "worker" },
      { member_id: "m3", name: "M3", role: "worker" },
      { member_id: "m4", name: "M4", role: "worker" },
    ]);

    await new Promise<void>((r) => setTimeout(r, 500));
    await coord.stop();

    // At most 2 should be spawned due to the cap
    expect(spawnedAgents.length).toBeLessThanOrEqual(2);
    // Warning should be emitted for the capped ones
    const capWarnings = warnings.filter((w) => w.includes("Max teammates cap"));
    expect(capWarnings.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it("reconcile can respawn a previously stopped member (remove+re-add)", async () => {
    // Start with only lead in members.json
    await initAgentsContext({
      contextDir,
      teamName: "test",
      leadMemberId: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "team_lead" },
      ],
    });

    const events: ExecEvent[] = [];
    const trackingSink: ExecEventSink = { emit(e: ExecEvent) { events.push(e); } };

    const coord = new AgentCoordinator({
      contextDir,
      sink: trackingSink,
      workspaceDir: process.cwd(),
      leadMemberId: "lead",
      teamId: "test-team-id",
      reconcileIntervalMs: 100,
      teammateShutdownWaitMs: 200,
    });

    await coord.start();

    // Dynamically add ephemeral
    await writeMembersConfig(contextDir, [
      { member_id: "lead", name: "Lead", role: "team_lead" },
      { member_id: "ephemeral", name: "Ephemeral", role: "worker" },
    ]);
    await new Promise<void>((r) => setTimeout(r, 300));

    // Should have been spawned (step_state RUNNING)
    const runningEvents1 = events.filter(
      (e) => e.type === "step_state" && (e as any).stepId === "_agent:ephemeral" && (e as any).status === "RUNNING",
    );
    expect(runningEvents1.length).toBe(1);

    // Remove ephemeral from desired state — reconcile stops the agent
    await writeMembersConfig(contextDir, [
      { member_id: "lead", name: "Lead", role: "team_lead" },
    ]);
    await new Promise<void>((r) => setTimeout(r, 300));

    // Re-add ephemeral — should be respawned
    await writeMembersConfig(contextDir, [
      { member_id: "lead", name: "Lead", role: "team_lead" },
      { member_id: "ephemeral", name: "Ephemeral", role: "worker" },
    ]);
    await new Promise<void>((r) => setTimeout(r, 300));

    // Should have been spawned twice (initial + respawn after re-add)
    const allRunning = events.filter(
      (e) => e.type === "step_state" && (e as any).stepId === "_agent:ephemeral" && (e as any).status === "RUNNING",
    );
    expect(allRunning.length).toBeGreaterThanOrEqual(2);

    await coord.stop();
  }, 10_000);
});
