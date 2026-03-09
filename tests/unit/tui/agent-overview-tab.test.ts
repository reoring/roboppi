import { describe, it, expect } from "bun:test";
import { renderAgentOverviewTab } from "../../../src/tui/components/tabs/agent-overview-tab.js";
import { RingBuffer } from "../../../src/tui/ring-buffer.js";
import type { WorkflowUiState, StepUiState, AgentRosterEntry } from "../../../src/tui/state-store.js";

function makeStep(stepId: string, overrides?: Partial<StepUiState>): StepUiState {
  const logOpts = { maxLines: 100, maxBytes: 10000 };
  return {
    stepId,
    status: "RUNNING",
    iteration: 0,
    maxIterations: 1,
    logs: {
      stdout: new RingBuffer<string>(logOpts),
      stderr: new RingBuffer<string>(logOpts),
      progress: new RingBuffer<string>(logOpts),
    },
    patches: {
      byId: new Map(),
      order: [],
      byFilePath: new Map(),
    },
    ...overrides,
  };
}

function makeState(steps: StepUiState[], roster: AgentRosterEntry[] = []): WorkflowUiState {
  const map = new Map<string, StepUiState>();
  for (const s of steps) map.set(s.stepId, s);
  const logOpts = { maxLines: 100, maxBytes: 10000 };
  return {
    steps: map,
    stepOrder: steps.map((s) => s.stepId),
    followMode: "running",
    selectedTab: "agent_overview",
    coreLogs: new RingBuffer<string>(logOpts),
    warnings: new RingBuffer<string>(logOpts),
    agentActivity: new RingBuffer<string>(logOpts),
    agentEntries: [],
    agentRoster: new Map(roster.map((entry) => [entry.memberId, entry])),
    agentRosterOrder: roster.map((entry) => entry.memberId),
    agentRuntime: new Map(),
    chatMessages: [],
    chatInputActive: false,
    chatInputBuffer: "",
    chatInputTarget: "",
  };
}

describe("renderAgentOverviewTab", () => {
  it("renders Current Output section from stdout", () => {
    const step = makeStep("_agent:impl");
    step.logs.stdout.push("Reading src/counter.ts...");
    step.logs.stdout.push("Editing lines 15-30");
    step.logs.stdout.push("Running: bun test");

    const state = makeState([step], [{ memberId: "impl", name: "impl", role: "member", agentId: "implementer" }]);
    const output = renderAgentOverviewTab(state, step, state.agentRoster.get("impl"), "impl", 80, 30);

    expect(output).toContain("Current Output");
    expect(output).toContain("Reading src/counter.ts...");
    expect(output).toContain("Running: bun test");
  });

  it("renders Modified Files section from patches", () => {
    const step = makeStep("_agent:impl");
    step.patches.byFilePath.set("src/cli.ts", ["p1"]);
    step.patches.byFilePath.set("src/counter.ts", ["p2", "p3", "p4"]);

    const state = makeState([step], [{ memberId: "impl", name: "impl", role: "member", agentId: "implementer" }]);
    const output = renderAgentOverviewTab(state, step, state.agentRoster.get("impl"), "impl", 80, 30);

    expect(output).toContain("Modified Files");
    expect(output).toContain("src/cli.ts");
    expect(output).toContain("src/counter.ts (3)");
  });

  it("shows no output section when stdout is empty", () => {
    const step = makeStep("_agent:impl");
    const state = makeState([step], [{ memberId: "impl", name: "impl", role: "member", agentId: "implementer" }]);
    const output = renderAgentOverviewTab(state, step, state.agentRoster.get("impl"), "impl", 80, 30);

    expect(output).not.toContain("Current Output");
  });

  it("shows no modified files section when patches are empty", () => {
    const step = makeStep("_agent:impl");
    const state = makeState([step], [{ memberId: "impl", name: "impl", role: "member", agentId: "implementer" }]);
    const output = renderAgentOverviewTab(state, step, state.agentRoster.get("impl"), "impl", 80, 30);

    expect(output).not.toContain("Modified Files");
  });

  it("renders dormant agents even when no step is running", () => {
    const state = makeState([], [{ memberId: "manual_verifier", name: "manual_verifier", role: "dormant", agentId: "manual_verifier" }]);
    const output = renderAgentOverviewTab(state, undefined, state.agentRoster.get("manual_verifier"), "manual_verifier", 80, 30);

    expect(output).toContain("manual_verifier");
    expect(output).toContain("DORMANT");
    expect(output).toContain("sleeping");
  });

  it("renders runtime metrics for agent dispatches and restarts", () => {
    const step = makeStep("_agent:impl", {
      startedAt: Date.parse("2026-03-09T00:10:00.000Z"),
      phase: "ready",
    });
    const state = makeState([step], [{ memberId: "impl", name: "impl", role: "member", agentId: "implementer" }]);
    state.agentRuntime.set("impl", {
      memberId: "impl",
      dispatchCount: 3,
      restartCount: 1,
      tokenSampleCount: 1,
      totalEstimatedTokens: 12345,
      lastEstimatedTokens: 2345,
      totalInstructionBytes: 16_384,
      lastInstructionBytes: 4_096,
      lastStartedAt: Date.parse("2026-03-09T00:10:00.000Z"),
      lastStoppedAt: Date.parse("2026-03-09T00:12:00.000Z"),
      lastDispatchStartedAt: Date.parse("2026-03-09T00:10:10.000Z"),
      lastDispatchFinishedAt: Date.parse("2026-03-09T00:10:40.000Z"),
      lastDispatchDurationMs: 30_000,
      totalDispatchActiveMs: 95_000,
    });

    const output = renderAgentOverviewTab(state, step, state.agentRoster.get("impl"), "impl", 100, 30);

    expect(output).toContain("Dispatches:");
    expect(output).toContain("3");
    expect(output).toContain("Restarts:");
    expect(output).toContain("1");
    expect(output).toContain("Tokens:");
    expect(output).toContain("12k");
    expect(output).toContain("last 2.3k");
    expect(output).toContain("Prompt:");
    expect(output).toContain("16KiB");
    expect(output).toContain("last 4.0KiB");
    expect(output).toContain("2026-03-09 00:10:00");
    expect(output).toContain("2026-03-09 00:12:00");
    expect(output).toContain("2026-03-09 00:10:10 -> 2026-03-09 00:10:40 (30s)");
    expect(output).toContain("Busy Time:");
    expect(output).toContain("1m35s");
  });

  it("renders current instructions for an active dispatch", () => {
    const step = makeStep("_agent:planner", {
      startedAt: Date.parse("2026-03-09T00:10:00.000Z"),
      phase: "executing",
    });
    const state = makeState([step], [{ memberId: "planner", name: "planner", role: "member", agentId: "planner" }]);
    state.agentRuntime.set("planner", {
      memberId: "planner",
      dispatchCount: 1,
      restartCount: 0,
      totalDispatchActiveMs: 0,
      currentlyDispatchingSince: Date.parse("2026-03-09T00:10:10.000Z"),
      currentInstructions: "You are planner.\nRead todo.md\nReply to lead.",
      lastInstructions: "You are planner.\nRead todo.md\nReply to lead.",
    });

    const output = renderAgentOverviewTab(state, step, state.agentRoster.get("planner"), "planner", 80, 30);

    expect(output).toContain("Current Instructions");
    expect(output).toContain("You are planner.");
    expect(output).toContain("Read todo.md");
    expect(output).toContain("Reply to lead.");
  });

  it("renders configured and observed MCP/skill usage", () => {
    const step = makeStep("_agent:manual_verifier", {
      startedAt: Date.parse("2026-03-09T00:10:00.000Z"),
      phase: "ready",
    });
    const state = makeState([step], [{ memberId: "manual_verifier", name: "manual_verifier", role: "member", agentId: "manual_verifier" }]);
    state.agentRuntime.set("manual_verifier", {
      memberId: "manual_verifier",
      dispatchCount: 1,
      restartCount: 0,
      totalDispatchActiveMs: 10_000,
      mcpAvailable: ["apthctl_loop"],
      skillHints: ["apthctl-live-cluster-retention", "apthctl-kubernetes-debug"],
      observedMcpTools: ["apthctl_loop.live_cluster_reuse_candidates"],
      observedSkills: ["apthctl-live-cluster-retention"],
    });

    const output = renderAgentOverviewTab(
      state,
      step,
      state.agentRoster.get("manual_verifier"),
      "manual_verifier",
      120,
      30,
    );

    expect(output).toContain("MCP Ready:");
    expect(output).toContain("apthctl_loop");
    expect(output).toContain("MCP Used:");
    expect(output).toContain("apthctl_loop.live_cluster_reuse_candidates");
    expect(output).toContain("Skill Hints:");
    expect(output).toContain("apthctl-live-cluster-retention");
    expect(output).toContain("apthctl-kubernetes-debug");
    expect(output).toContain("Skills Read:");
    expect(output).toContain("apthctl-live-cluster-retention");
  });

  it("renders last instructions after a dispatch has finished", () => {
    const step = makeStep("_agent:planner", {
      startedAt: Date.parse("2026-03-09T00:10:00.000Z"),
      phase: "ready",
    });
    const state = makeState([step], [{ memberId: "planner", name: "planner", role: "member", agentId: "planner" }]);
    state.agentRuntime.set("planner", {
      memberId: "planner",
      dispatchCount: 1,
      restartCount: 0,
      totalDispatchActiveMs: 30_000,
      lastInstructions: "You are planner.\nSummarize issue state.",
    });

    const output = renderAgentOverviewTab(state, step, state.agentRoster.get("planner"), "planner", 80, 30);

    expect(output).toContain("Last Instructions");
    expect(output).toContain("Summarize issue state.");
  });
});
