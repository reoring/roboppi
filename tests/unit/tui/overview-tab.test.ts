import { describe, it, expect } from "bun:test";

import { renderOverviewTab } from "../../../src/tui/components/tabs/overview-tab.js";
import { RingBuffer } from "../../../src/tui/ring-buffer.js";
import type { StepUiState, WorkflowUiState } from "../../../src/tui/state-store.js";

function makeStep(stepId: string, overrides?: Partial<StepUiState>): StepUiState {
  const logOpts = { maxLines: 100, maxBytes: 10000 };
  return {
    stepId,
    status: "RUNNING",
    iteration: 1,
    maxIterations: 3,
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

function makeState(step: StepUiState): WorkflowUiState {
  const logOpts = { maxLines: 100, maxBytes: 10000 };
  return {
    steps: new Map([[step.stepId, step]]),
    stepOrder: [step.stepId],
    followMode: "selected",
    selectedTab: "overview",
    coreLogs: new RingBuffer<string>(logOpts),
    warnings: new RingBuffer<string>(logOpts),
    agentActivity: new RingBuffer<string>(logOpts),
    agentEntries: [],
    agentRoster: new Map(),
    agentRosterOrder: [],
    agentRuntime: new Map(),
    workflowStatusSummary: undefined,
    chatMessages: [],
    chatInputActive: false,
    chatInputBuffer: "",
    chatInputTarget: "",
  };
}

describe("renderOverviewTab", () => {
  it("renders workflow status summary when present", () => {
    const step = makeStep("implement", { progress: { ts: 1000, message: "editing", percent: 40 } });
    const state = makeState(step);
    state.workflowStatusSummary = {
      version: "1",
      updated_at: Date.parse("2026-03-09T01:02:03.000Z"),
      owner_member_id: "planner",
      summary: "Implementer is fixing the cluster bootstrap blocker.",
      blockers: ["Manual verification evidence is still missing."],
      next_actions: ["Wait for implementer patch", "Rerun tester after patch lands"],
    };

    const output = renderOverviewTab(state, step, 100, 30);

    expect(output).toContain("Summary");
    expect(output).toContain("Implementer is fixing the cluster bootstrap blocker.");
    expect(output).toContain("2026-03-09 01:02:03 by planner");
    expect(output).toContain("Blockers:");
    expect(output).toContain("Manual verification evidence is still missing.");
    expect(output).toContain("Next:");
    expect(output).toContain("Wait for implementer patch");
  });

  it("renders placeholder when no workflow status summary exists", () => {
    const step = makeStep("implement");
    const state = makeState(step);

    const output = renderOverviewTab(state, step, 80, 20);

    expect(output).toContain("Summary");
    expect(output).toContain("No agent summary yet");
  });
});
