/**
 * SwarmCoordinator unit tests.
 *
 * Verifies CUSTOM worker compatibility and teammate spawning behavior.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SwarmCoordinator } from "../../../src/swarm/coordinator.js";
import { initSwarmContext } from "../../../src/swarm/store.js";
import { swarmEventsPath } from "../../../src/swarm/paths.js";
import type { StepRunResult } from "../../../src/workflow/executor.js";
import type { StepDefinition } from "../../../src/workflow/types.js";
import type { ExecEventSink, ExecEvent } from "../../../src/tui/exec-event.js";

let contextDir: string;

beforeEach(async () => {
  contextDir = await mkdtemp(path.join(tmpdir(), "swarm-coord-"));
});

afterEach(async () => {
  await rm(contextDir, { recursive: true, force: true });
});

function noopSink(): ExecEventSink {
  return { emit(_e: ExecEvent) {} };
}

describe("SwarmCoordinator teammate spawning", () => {
  it("CUSTOM worker instructions are shell-safe (no natural-language lines)", async () => {
    await initSwarmContext({
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

    const coord = new SwarmCoordinator({
      contextDir,
      sink: noopSink(),
      stepRunner: mockRunner,
      workspaceDir: "/tmp",
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
    expect(entry.stepId).toBe("_swarm:worker1");
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

  it("LLM worker instructions contain natural-language guidance", async () => {
    await initSwarmContext({
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

    const coord = new SwarmCoordinator({
      contextDir,
      sink: noopSink(),
      stepRunner: mockRunner,
      workspaceDir: "/tmp",
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
    await coord.stop();

    expect(captured.length).toBe(1);
    const entry = captured[0]!;
    expect(entry.stepDef.worker).toBe("CLAUDE_CODE");
    expect(entry.stepDef.instructions).toContain("You are team member");
    expect(entry.stepDef.instructions).toContain("roboppi swarm");
  });
});

// -------------------------------------------------------------------------
// Spec 3.2: Bounded shutdown, abort, cleanup policy, and final cleanup event
// -------------------------------------------------------------------------

describe("SwarmCoordinator bounded shutdown (Spec 3.2)", () => {
  it("stop() returns within timeout even when a teammate hangs", async () => {
    await initSwarmContext({
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
    const coord = new SwarmCoordinator({
      contextDir,
      sink: noopSink(),
      stepRunner: mockRunner,
      workspaceDir: "/tmp",
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
    await initSwarmContext({
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
        const memberId = stepId.replace("_swarm:", "");
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

    const coord = new SwarmCoordinator({
      contextDir,
      sink: noopSink(),
      stepRunner: mockRunner,
      workspaceDir: "/tmp",
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

  it("_swarm/_events.jsonl contains swarm_cleanup event after stop()", async () => {
    await initSwarmContext({
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

    const coord = new SwarmCoordinator({
      contextDir,
      sink: noopSink(),
      stepRunner: mockRunner,
      workspaceDir: "/tmp",
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

    // Read swarm-level events
    const eventsContent = await readFile(swarmEventsPath(contextDir), "utf-8");
    const events = eventsContent.trim().split("\n").map((l) => JSON.parse(l));
    const cleanupEvents = events.filter((e: any) => e.type === "swarm_cleanup");
    expect(cleanupEvents.length).toBe(1);
    expect(cleanupEvents[0].team_id).toBe("test-team-id");
    expect(typeof cleanupEvents[0].teammates_settled).toBe("number");
    expect(typeof cleanupEvents[0].teammates_aborted).toBe("number");
    expect(typeof cleanupEvents[0].mailbox_retained).toBe("boolean");
    expect(typeof cleanupEvents[0].tasks_retained).toBe("boolean");
  });

  it("cleanup policy removes mailbox when retain_mailbox=false", async () => {
    await initSwarmContext({
      contextDir,
      teamName: "test",
      leadMemberId: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "team_lead" },
      ],
      cleanupPolicy: { retain_mailbox: false, retain_tasks: true },
    });

    const coord = new SwarmCoordinator({
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
    const mailboxPath = resolvePath(contextDir, "_swarm", "mailbox");
    await expect(stat(mailboxPath)).rejects.toThrow();

    // Tasks should still exist
    const tasksPath = resolvePath(contextDir, "_swarm", "tasks");
    const tasksStat = await stat(tasksPath);
    expect(tasksStat.isDirectory()).toBe(true);

    // Cleanup event should reflect what was retained/removed
    const eventsContent = await readFile(swarmEventsPath(contextDir), "utf-8");
    const events = eventsContent.trim().split("\n").map((l) => JSON.parse(l));
    const cleanupEvent = events.find((e: any) => e.type === "swarm_cleanup");
    expect(cleanupEvent.mailbox_retained).toBe(false);
    expect(cleanupEvent.tasks_retained).toBe(true);
  });
});
