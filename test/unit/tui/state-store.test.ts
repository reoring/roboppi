import { describe, test, expect } from "bun:test";
import { TuiStateStore } from "../../../src/tui/state-store.js";
import type { ExecEvent } from "../../../src/tui/exec-event.js";
import { WorkflowStatus, StepStatus } from "../../../src/workflow/types.js";
import { WorkerStatus } from "../../../src/types/worker-result.js";

describe("TuiStateStore", () => {
  test("initializes with default state", () => {
    const store = new TuiStateStore();
    expect(store.state.steps.size).toBe(0);
    expect(store.state.stepOrder).toEqual([]);
    expect(store.state.agentRosterOrder).toEqual([]);
    expect(store.state.followMode).toBe("running");
    expect(store.state.selectedTab).toBe("overview");
    expect(store.state.coreLogs.length).toBe(0);
    expect(store.state.warnings.length).toBe(0);
    expect(store.dirty).toBe(false);
  });

  test("handles workflow_started event", () => {
    const store = new TuiStateStore();
    const event: ExecEvent = {
      type: "workflow_started",
      workflowId: "wf-1",
      name: "test-workflow",
      workspaceDir: "/tmp/ws",
      supervised: true,
      startedAt: 1000,
      definitionSummary: {
        steps: ["step-a", "step-b"],
        concurrency: 2,
        timeout: "30m",
        agentProfiles: {
          planner: {
            agentId: "implementation_planner",
            mcpAvailable: ["apthctl_loop", "roboppi_agents"],
            skillHints: ["apthctl-todo-sync", "apthctl-rerun-provenance"],
          },
        },
      },
    };

    store.emit(event);

    expect(store.state.workflowId).toBe("wf-1");
    expect(store.state.name).toBe("test-workflow");
    expect(store.state.workspaceDir).toBe("/tmp/ws");
    expect(store.state.supervised).toBe(true);
    expect(store.state.startedAt).toBe(1000);
    expect(store.state.status).toBe("RUNNING");
    expect(store.state.steps.size).toBe(2);
    expect(store.state.stepOrder).toEqual(["step-a", "step-b"]);
    expect(store.state.steps.get("step-a")?.status).toBe("PENDING");
    expect(store.state.steps.get("step-b")?.status).toBe("PENDING");
    expect(store.state.agentRuntime.get("planner")?.mcpAvailable).toEqual(["apthctl_loop", "roboppi_agents"]);
    expect(store.state.agentRuntime.get("planner")?.skillHints).toEqual([
      "apthctl-rerun-provenance",
      "apthctl-todo-sync",
    ]);
  });

  test("handles workflow_finished event", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "workflow_started",
      workflowId: "wf-1",
      name: "test",
      workspaceDir: "/tmp",
      supervised: false,
      startedAt: 1000,
    });
    store.emit({
      type: "workflow_finished",
      status: WorkflowStatus.SUCCEEDED,
      completedAt: 2000,
    });

    expect(store.state.status).toBe(WorkflowStatus.SUCCEEDED);
    expect(store.state.finishedAt).toBe(2000);
  });

  test("handles step_state event (create + update)", () => {
    const store = new TuiStateStore();

    // First event creates the step
    store.emit({
      type: "step_state",
      stepId: "s1",
      status: StepStatus.RUNNING,
      iteration: 1,
      maxIterations: 3,
      startedAt: 1000,
    });

    const step = store.state.steps.get("s1")!;
    expect(step.status).toBe("RUNNING");
    expect(step.iteration).toBe(1);
    expect(step.maxIterations).toBe(3);
    expect(step.startedAt).toBe(1000);

    // Second event updates it
    store.emit({
      type: "step_state",
      stepId: "s1",
      status: StepStatus.SUCCEEDED,
      iteration: 2,
      maxIterations: 3,
      completedAt: 2000,
    });

    expect(step.status).toBe("SUCCEEDED");
    expect(step.iteration).toBe(2);
    expect(step.completedAt).toBe(2000);
    // startedAt should still be set from before
    expect(step.startedAt).toBe(1000);
  });

  test("handles step_phase event", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "step_phase",
      stepId: "s1",
      phase: "executing",
      at: 1000,
    });

    const step = store.state.steps.get("s1")!;
    expect(step.phase).toBe("executing");
  });

  test("tracks current and last agent instructions from executing phases", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "step_phase",
      stepId: "_agent:planner",
      phase: "executing",
      at: 1000,
      detail: {
        instructions: "You are planner.\nUse skills/apthctl-todo-sync/SKILL.md.\nCheck tasks.",
      },
    });

    let stats = store.state.agentRuntime.get("planner");
    expect(stats?.dispatchCount).toBe(1);
    expect(stats?.currentInstructions).toBe("You are planner.\nUse skills/apthctl-todo-sync/SKILL.md.\nCheck tasks.");
    expect(stats?.lastInstructions).toBe("You are planner.\nUse skills/apthctl-todo-sync/SKILL.md.\nCheck tasks.");
    expect(stats?.skillHints).toEqual(["apthctl-todo-sync"]);

    store.emit({
      type: "step_phase",
      stepId: "_agent:planner",
      phase: "ready",
      at: 1500,
    });

    stats = store.state.agentRuntime.get("planner");
    expect(stats?.currentInstructions).toBeUndefined();
    expect(stats?.lastInstructions).toBe("You are planner.\nUse skills/apthctl-todo-sync/SKILL.md.\nCheck tasks.");
  });

  test("tracks observed MCP tools and skills from worker logs", () => {
    const store = new TuiStateStore();

    store.emit({
      type: "worker_event",
      stepId: "_agent:manual_verifier",
      ts: 1000,
      event: {
        type: "stdout",
        data: JSON.stringify({
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "mcp__apthctl_loop__live_cluster_reuse_candidates",
              input: { issue_id: "issue-1" },
            },
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "skills/apthctl-live-cluster-retention/SKILL.md" },
            },
          ],
        }),
      },
    });

    const stats = store.state.agentRuntime.get("manual_verifier");
    expect(stats?.observedMcpTools).toEqual(["apthctl_loop.live_cluster_reuse_candidates"]);
    expect(stats?.observedSkills).toEqual(["apthctl-live-cluster-retention"]);
  });

  test("syncs workflow status summary and marks store dirty only when changed", () => {
    const store = new TuiStateStore();
    store.syncWorkflowStatusSummary({
      version: "1",
      updated_at: 1000,
      owner_member_id: "planner",
      summary: "Implementer is working on the top blocker.",
      blockers: ["kind bootstrap is failing"],
      next_actions: ["wait for patch"],
    });

    expect(store.state.workflowStatusSummary?.owner_member_id).toBe("planner");
    expect(store.dirty).toBe(true);

    store.dirty = false;
    store.syncWorkflowStatusSummary({
      version: "1",
      updated_at: 1000,
      owner_member_id: "planner",
      summary: "Implementer is working on the top blocker.",
      blockers: ["kind bootstrap is failing"],
      next_actions: ["wait for patch"],
    });
    expect(store.dirty).toBe(false);
  });

  test("handles worker_event stdout", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1000,
      event: { type: "stdout", data: "hello world" },
    });

    const step = store.state.steps.get("s1")!;
    expect(step.logs.stdout.lines()).toEqual(["hello world"]);
  });

  test("handles worker_event stderr", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1000,
      event: { type: "stderr", data: "error msg" },
    });

    const step = store.state.steps.get("s1")!;
    expect(step.logs.stderr.lines()).toEqual(["error msg"]);
  });

  test("handles worker_event progress", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1500,
      event: { type: "progress", message: "50% done", percent: 50 },
    });

    const step = store.state.steps.get("s1")!;
    expect(step.logs.progress.lines()).toEqual(["50% done"]);
    expect(step.progress).toEqual({
      ts: 1500,
      message: "50% done",
      percent: 50,
    });
  });

  test("handles worker_event patch", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1000,
      event: { type: "patch", filePath: "src/foo.ts", diff: "+line1" },
    });

    const step = store.state.steps.get("s1")!;
    expect(step.patches.order.length).toBe(1);
    const patchId = step.patches.order[0]!;
    const entry = step.patches.byId.get(patchId)!;
    expect(entry.stepId).toBe("s1");
    expect(entry.filePath).toBe("src/foo.ts");
    expect(entry.diff).toBe("+line1");
    expect(step.patches.byFilePath.get("src/foo.ts")).toEqual([patchId]);
  });

  test("handles worker_result event", () => {
    const store = new TuiStateStore();
    const result = {
      status: WorkerStatus.SUCCEEDED,
      artifacts: [],
      observations: [],
      cost: { wallTimeMs: 500 },
      durationMs: 500,
    };
    store.emit({
      type: "worker_result",
      stepId: "s1",
      ts: 2000,
      result,
    });

    const step = store.state.steps.get("s1")!;
    expect(step.result).toBe(result);
  });

  test("handles core_log event", () => {
    const store = new TuiStateStore();
    store.emit({ type: "core_log", ts: 1000, line: "core started" });
    store.emit({ type: "core_log", ts: 1001, line: "permit issued" });

    expect(store.state.coreLogs.lines()).toEqual([
      "core started",
      "permit issued",
    ]);
  });

  test("handles warning event", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "warning",
      ts: 1000,
      message: "high latency detected",
    });

    expect(store.state.warnings.lines()).toEqual(["high latency detected"]);
  });

  test("sets dirty flag on emit", () => {
    const store = new TuiStateStore();
    expect(store.dirty).toBe(false);

    store.emit({ type: "core_log", ts: 1000, line: "test" });
    expect(store.dirty).toBe(true);

    // Consumer resets dirty
    store.dirty = false;
    expect(store.dirty).toBe(false);

    store.emit({ type: "warning", ts: 1001, message: "warn" });
    expect(store.dirty).toBe(true);
  });

  test("creates placeholder step for unknown stepId", () => {
    const store = new TuiStateStore();
    const step = store.getOrCreateStep("unknown-step");

    expect(step.stepId).toBe("unknown-step");
    expect(step.status).toBe("PENDING");
    expect(step.iteration).toBe(0);
    expect(step.maxIterations).toBe(1);
    expect(store.state.stepOrder).toContain("unknown-step");
  });

  test("patch index tracks byId, order, byFilePath correctly", () => {
    const store = new TuiStateStore();

    // Two patches to same file
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1000,
      event: { type: "patch", filePath: "src/a.ts", diff: "+first" },
    });
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1001,
      event: { type: "patch", filePath: "src/a.ts", diff: "+second" },
    });

    // One patch to a different file
    store.emit({
      type: "worker_event",
      stepId: "s1",
      ts: 1002,
      event: { type: "patch", filePath: "src/b.ts", diff: "+other" },
    });

    const step = store.state.steps.get("s1")!;
    expect(step.patches.order.length).toBe(3);
    expect(step.patches.byId.size).toBe(3);

    // byFilePath should group correctly
    const aPatches = step.patches.byFilePath.get("src/a.ts")!;
    expect(aPatches.length).toBe(2);
    const bPatches = step.patches.byFilePath.get("src/b.ts")!;
    expect(bPatches.length).toBe(1);

    // Verify ordering matches insertion
    expect(step.patches.order[0]).toBe(aPatches[0]!);
    expect(step.patches.order[1]).toBe(aPatches[1]!);
    expect(step.patches.order[2]).toBe(bPatches[0]!);

    // Verify entries have correct data
    const firstEntry = step.patches.byId.get(aPatches[0]!)!;
    expect(firstEntry.diff).toBe("+first");
    const secondEntry = step.patches.byId.get(aPatches[1]!)!;
    expect(secondEntry.diff).toBe("+second");
  });

  test("accepts supervised option in constructor", () => {
    const store = new TuiStateStore({ supervised: true });
    expect(store.state.supervised).toBe(true);
  });

  test("syncs agent roster and marks the store dirty only when it changes", () => {
    const store = new TuiStateStore();

    store.syncAgentRoster([
      { memberId: "manual_verifier", name: "manual_verifier", role: "dormant", agentId: "manual_verifier" },
      { memberId: "reviewer", name: "reviewer", role: "member", agentId: "reviewer" },
    ]);

    expect(store.dirty).toBe(true);
    expect(store.state.agentRosterOrder).toEqual(["manual_verifier", "reviewer"]);
    expect(store.state.agentRoster.get("manual_verifier")?.role).toBe("dormant");

    store.dirty = false;
    store.syncAgentRoster([
      { memberId: "manual_verifier", name: "manual_verifier", role: "dormant", agentId: "manual_verifier" },
      { memberId: "reviewer", name: "reviewer", role: "member", agentId: "reviewer" },
    ]);
    expect(store.dirty).toBe(false);

    store.syncAgentRoster([
      { memberId: "manual_verifier", name: "manual_verifier", role: "member", agentId: "manual_verifier" },
      { memberId: "reviewer", name: "reviewer", role: "member", agentId: "reviewer" },
    ]);
    expect(store.dirty).toBe(true);
    expect(store.state.agentRoster.get("manual_verifier")?.role).toBe("member");
  });

  test("tracks agent dispatch counts, active time, and restarts", () => {
    const store = new TuiStateStore();

    store.emit({
      type: "step_state",
      stepId: "_agent:reviewer",
      status: StepStatus.RUNNING,
      iteration: 1,
      maxIterations: 1,
      startedAt: 1000,
    });
    store.emit({
      type: "step_phase",
      stepId: "_agent:reviewer",
      phase: "executing",
      at: 1200,
    });
    store.emit({
      type: "step_phase",
      stepId: "_agent:reviewer",
      phase: "ready",
      at: 1700,
    });
    store.emit({
      type: "step_state",
      stepId: "_agent:reviewer",
      status: StepStatus.SUCCEEDED,
      iteration: 1,
      maxIterations: 1,
      completedAt: 2000,
    });
    store.emit({
      type: "step_state",
      stepId: "_agent:reviewer",
      status: StepStatus.RUNNING,
      iteration: 2,
      maxIterations: 2,
      startedAt: 3000,
    });
    store.emit({
      type: "step_phase",
      stepId: "_agent:reviewer",
      phase: "executing",
      at: 3100,
    });
    store.emit({
      type: "step_state",
      stepId: "_agent:reviewer",
      status: StepStatus.FAILED,
      iteration: 2,
      maxIterations: 2,
      completedAt: 3600,
      error: "timeout",
    });

    const stats = store.state.agentRuntime.get("reviewer");
    expect(stats).toBeDefined();
    expect(stats?.dispatchCount).toBe(2);
    expect(stats?.restartCount).toBe(1);
    expect(stats?.lastStartedAt).toBe(3000);
    expect(stats?.lastStoppedAt).toBe(3600);
    expect(stats?.lastDispatchStartedAt).toBe(3100);
    expect(stats?.lastDispatchFinishedAt).toBe(3600);
    expect(stats?.lastDispatchDurationMs).toBe(500);
    expect(stats?.totalDispatchActiveMs).toBe(1000);
    expect(stats?.currentlyDispatchingSince).toBeUndefined();
  });

  test("tracks token estimates and prompt bytes from agent worker results", () => {
    const store = new TuiStateStore();

    store.emit({
      type: "worker_result",
      stepId: "_agent:planner",
      ts: 1000,
      result: {
        status: WorkerStatus.SUCCEEDED,
        artifacts: [],
        observations: [],
        cost: {
          wallTimeMs: 500,
          estimatedTokens: 1200,
          instructionBytes: 4096,
        },
        durationMs: 500,
      },
    });
    store.emit({
      type: "worker_result",
      stepId: "_agent:planner",
      ts: 2000,
      result: {
        status: WorkerStatus.SUCCEEDED,
        artifacts: [],
        observations: [],
        cost: {
          wallTimeMs: 300,
          instructionBytes: 2048,
        },
        durationMs: 300,
      },
    });

    const stats = store.state.agentRuntime.get("planner");
    expect(stats).toBeDefined();
    expect(stats?.tokenSampleCount).toBe(1);
    expect(stats?.totalEstimatedTokens).toBe(1200);
    expect(stats?.lastEstimatedTokens).toBe(1200);
    expect(stats?.totalInstructionBytes).toBe(6144);
    expect(stats?.lastInstructionBytes).toBe(2048);
  });

  // -------------------------------------------------------------------------
  // Agents events
  // -------------------------------------------------------------------------

  test("handles agent_message_sent event", () => {
    const store = new TuiStateStore();
    const event: ExecEvent = {
      type: "agent_message_sent",
      ts: 1000,
      teamId: "team-1",
      messageId: "msg-1",
      fromMemberId: "researcher",
      toMemberId: "lead",
      topic: "findings",
      kind: "text",
    };

    store.emit(event);

    expect(store.dirty).toBe(true);
    expect(store.state.agentActivity.length).toBe(1);
    expect(store.state.agentActivity.lines()[0]).toContain("[agents]");
    expect(store.state.agentActivity.lines()[0]).toContain("message sent");
    expect(store.state.agentActivity.lines()[0]).toContain("researcher");
    expect(store.state.agentEntries.length).toBe(1);
    expect(store.state.agentEntries[0]!.type).toBe("agent_message_sent");
    expect(store.state.agentEntries[0]!.teamId).toBe("team-1");
    expect(store.state.agentEntries[0]!.id).toBe("msg-1");
    expect(store.state.agentEntries[0]!.memberId).toBe("researcher");
    expect(store.state.agentEntries[0]!.label).toBe("findings");
  });

  test("handles agent_message_sent broadcast event", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "agent_message_sent",
      ts: 1000,
      teamId: "team-1",
      messageId: "msg-2",
      fromMemberId: "lead",
      to: "broadcast",
      topic: "announcement",
    });

    expect(store.state.agentEntries.length).toBe(1);
    expect(store.state.agentEntries[0]!.memberId).toBe("lead");
  });

  test("handles agent_message_received event", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "agent_message_received",
      ts: 2000,
      teamId: "team-1",
      messageId: "msg-1",
      fromMemberId: "researcher",
      toMemberId: "lead",
      topic: "findings",
    });

    expect(store.state.agentActivity.length).toBe(1);
    expect(store.state.agentActivity.lines()[0]).toContain("message received");
    expect(store.state.agentActivity.lines()[0]).toContain("lead");
    expect(store.state.agentEntries[0]!.type).toBe("agent_message_received");
    expect(store.state.agentEntries[0]!.memberId).toBe("lead");
  });

  test("handles agent_task_claimed event", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "agent_task_claimed",
      ts: 3000,
      teamId: "team-1",
      taskId: "task-1",
      byMemberId: "researcher",
      title: "Investigate failure",
    });

    expect(store.state.agentActivity.length).toBe(1);
    expect(store.state.agentActivity.lines()[0]).toContain("task claimed");
    expect(store.state.agentActivity.lines()[0]).toContain("researcher");
    expect(store.state.agentEntries[0]!.type).toBe("agent_task_claimed");
    expect(store.state.agentEntries[0]!.id).toBe("task-1");
    expect(store.state.agentEntries[0]!.label).toBe("Investigate failure");
  });

  test("handles agent_task_completed event", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "agent_task_completed",
      ts: 4000,
      teamId: "team-1",
      taskId: "task-1",
      byMemberId: "researcher",
      title: "Investigate failure",
    });

    expect(store.state.agentActivity.length).toBe(1);
    expect(store.state.agentActivity.lines()[0]).toContain("task completed");
    expect(store.state.agentEntries[0]!.type).toBe("agent_task_completed");
    expect(store.state.agentEntries[0]!.id).toBe("task-1");
  });

  test("agent events do not end up in coreLogs or warnings", () => {
    const store = new TuiStateStore();

    store.emit({
      type: "agent_message_sent",
      ts: 1000,
      teamId: "team-1",
      messageId: "msg-1",
      fromMemberId: "researcher",
      toMemberId: "lead",
      topic: "findings",
    });
    store.emit({
      type: "agent_task_claimed",
      ts: 2000,
      teamId: "team-1",
      taskId: "task-1",
      byMemberId: "researcher",
    });

    expect(store.state.coreLogs.length).toBe(0);
    expect(store.state.warnings.length).toBe(0);
    expect(store.state.agentActivity.length).toBe(2);
  });
});
