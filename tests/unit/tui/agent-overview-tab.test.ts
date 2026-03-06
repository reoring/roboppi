import { describe, it, expect } from "bun:test";
import { renderAgentOverviewTab } from "../../../src/tui/components/tabs/agent-overview-tab.js";
import { RingBuffer } from "../../../src/tui/ring-buffer.js";
import type { WorkflowUiState, StepUiState } from "../../../src/tui/state-store.js";

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

function makeState(steps: StepUiState[]): WorkflowUiState {
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

    const state = makeState([step]);
    const output = renderAgentOverviewTab(state, step, "impl", 80, 30);

    expect(output).toContain("Current Output");
    expect(output).toContain("Reading src/counter.ts...");
    expect(output).toContain("Running: bun test");
  });

  it("renders Modified Files section from patches", () => {
    const step = makeStep("_agent:impl");
    step.patches.byFilePath.set("src/cli.ts", ["p1"]);
    step.patches.byFilePath.set("src/counter.ts", ["p2", "p3", "p4"]);

    const state = makeState([step]);
    const output = renderAgentOverviewTab(state, step, "impl", 80, 30);

    expect(output).toContain("Modified Files");
    expect(output).toContain("src/cli.ts");
    expect(output).toContain("src/counter.ts (3)");
  });

  it("shows no output section when stdout is empty", () => {
    const step = makeStep("_agent:impl");
    const state = makeState([step]);
    const output = renderAgentOverviewTab(state, step, "impl", 80, 30);

    expect(output).not.toContain("Current Output");
  });

  it("shows no modified files section when patches are empty", () => {
    const step = makeStep("_agent:impl");
    const state = makeState([step]);
    const output = renderAgentOverviewTab(state, step, "impl", 80, 30);

    expect(output).not.toContain("Modified Files");
  });
});
