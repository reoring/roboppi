import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ResidentAgent } from "../../../src/agents/resident-agent.js";
import { addTask, claimTask, completeTask, listTasks } from "../../../src/agents/task-store.js";
import type { ExecEventSink } from "../../../src/tui/exec-event.js";
import type { AgentProfile } from "../../../src/workflow/agent-catalog.js";

const sink: ExecEventSink = {
  emit() {
    // no-op for unit tests
  },
};

const profile: AgentProfile = {
  worker: "CLAUDE_CODE",
};

function createResidentAgent(contextDir: string, memberId: string): ResidentAgent {
  return new ResidentAgent({
    contextDir,
    memberId,
    teamId: "team-1",
    profile,
    workspaceDir: contextDir,
    sink,
    env: {},
  });
}

function hasClaimableTasks(agent: ResidentAgent): Promise<boolean> {
  return (agent as unknown as { hasClaimableTasks(): Promise<boolean> }).hasClaimableTasks();
}

describe("task claiming respects assigned_to", () => {
  let contextDir: string;

  beforeEach(async () => {
    contextDir = await mkdtemp(path.join(tmpdir(), "roboppi-task-claim-"));
  });

  afterEach(async () => {
    await rm(contextDir, { recursive: true, force: true });
  });

  test("lead cannot claim a task assigned to manual_verifier and it stays pending", async () => {
    const { taskId } = await addTask({
      contextDir,
      title: "Verify live cluster blocker",
      description: "Preserve the cluster and verify the blocker fix.",
      assignedTo: "manual_verifier",
    });

    const denied = await claimTask(contextDir, taskId, "lead");

    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("manual_verifier");

    const pending = await listTasks(contextDir, "pending");
    const inProgress = await listTasks(contextDir, "in_progress");

    expect(pending).toHaveLength(1);
    expect(pending[0]?.task_id).toBe(taskId);
    expect(pending[0]?.claimed_by).toBeNull();
    expect(inProgress).toHaveLength(0);
  });

  test("the assigned member can claim the task after a denied claim", async () => {
    const { taskId } = await addTask({
      contextDir,
      title: "Verify live cluster blocker",
      description: "Preserve the cluster and verify the blocker fix.",
      assignedTo: "manual_verifier",
    });

    const denied = await claimTask(contextDir, taskId, "lead");
    expect(denied.ok).toBe(false);

    const claimed = await claimTask(contextDir, taskId, "manual_verifier");

    expect(claimed).toEqual({ ok: true });

    const pending = await listTasks(contextDir, "pending");
    const inProgress = await listTasks(contextDir, "in_progress");

    expect(pending).toHaveLength(0);
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0]?.task_id).toBe(taskId);
    expect(inProgress[0]?.claimed_by).toBe("manual_verifier");
    expect(inProgress[0]?.assigned_to).toBe("manual_verifier");
  });

  test("unassigned tasks remain claimable", async () => {
    const { taskId } = await addTask({
      contextDir,
      title: "Handle unassigned triage",
      description: "Any member may pick this up.",
    });

    const claimed = await claimTask(contextDir, taskId, "lead");

    expect(claimed).toEqual({ ok: true });

    const inProgress = await listTasks(contextDir, "in_progress");
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0]?.task_id).toBe(taskId);
    expect(inProgress[0]?.claimed_by).toBe("lead");
    expect(inProgress[0]?.assigned_to).toBeNull();
  });

  test("resident agents use the same claimability rule", async () => {
    await addTask({
      contextDir,
      title: "Verify live cluster blocker",
      description: "Preserve the cluster and verify the blocker fix.",
      assignedTo: "manual_verifier",
    });

    const leadAgent = createResidentAgent(contextDir, "lead");
    const manualVerifierAgent = createResidentAgent(contextDir, "manual_verifier");

    expect(await hasClaimableTasks(leadAgent)).toBe(false);
    expect(await hasClaimableTasks(manualVerifierAgent)).toBe(true);
  });

  test("resident agents ignore pending tasks whose dependencies are not yet complete", async () => {
    const { taskId: bootstrapId } = await addTask({
      contextDir,
      title: "Bootstrap evidence",
      description: "Create the prerequisite evidence first.",
      assignedTo: "lead",
    });

    await addTask({
      contextDir,
      title: "Verify live cluster blocker",
      description: "Preserve the cluster and verify the blocker fix.",
      assignedTo: "manual_verifier",
      dependsOn: [bootstrapId],
    });

    const manualVerifierAgent = createResidentAgent(contextDir, "manual_verifier");
    expect(await hasClaimableTasks(manualVerifierAgent)).toBe(false);

    expect(await claimTask(contextDir, bootstrapId, "lead")).toEqual({ ok: true });
    expect(await completeTask(contextDir, bootstrapId, "lead")).toEqual({ ok: true });

    expect(await hasClaimableTasks(manualVerifierAgent)).toBe(true);
  });
});
