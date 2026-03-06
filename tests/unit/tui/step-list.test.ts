import { describe, it, expect } from "bun:test";
import { buildLeftPaneEntries } from "../../../src/tui/components/step-list.js";
import { RingBuffer } from "../../../src/tui/ring-buffer.js";
import type { WorkflowUiState, StepUiState } from "../../../src/tui/state-store.js";

function makeStep(stepId: string, status = "PENDING"): StepUiState {
  const logOpts = { maxLines: 100, maxBytes: 10000 };
  return {
    stepId,
    status,
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
  };
}

function makeState(stepIds: string[]): WorkflowUiState {
  const steps = new Map<string, StepUiState>();
  for (const id of stepIds) {
    steps.set(id, makeStep(id));
  }
  const logOpts = { maxLines: 100, maxBytes: 10000 };
  return {
    steps,
    stepOrder: stepIds,
    followMode: "running",
    selectedTab: "overview",
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

describe("buildLeftPaneEntries", () => {
  it("returns only steps when no agents exist", () => {
    const state = makeState(["plan", "implement", "test"]);
    const entries = buildLeftPaneEntries(state);

    expect(entries).toEqual([
      { kind: "step", stepId: "plan" },
      { kind: "step", stepId: "implement" },
      { kind: "step", stepId: "test" },
    ]);
  });

  it("separates steps and agents with a separator", () => {
    const state = makeState(["plan", "_agent:scout", "implement", "_agent:researcher"]);
    const entries = buildLeftPaneEntries(state);

    expect(entries).toEqual([
      { kind: "step", stepId: "plan" },
      { kind: "step", stepId: "implement" },
      { kind: "separator", label: "Agents" },
      { kind: "agent", stepId: "_agent:scout", memberId: "scout" },
      { kind: "agent", stepId: "_agent:researcher", memberId: "researcher" },
    ]);
  });

  it("returns empty array for empty state", () => {
    const state = makeState([]);
    const entries = buildLeftPaneEntries(state);
    expect(entries).toEqual([]);
  });

  it("returns only agents section (with separator) when all entries are agents", () => {
    const state = makeState(["_agent:alpha", "_agent:beta"]);
    const entries = buildLeftPaneEntries(state);

    expect(entries).toEqual([
      { kind: "separator", label: "Agents" },
      { kind: "agent", stepId: "_agent:alpha", memberId: "alpha" },
      { kind: "agent", stepId: "_agent:beta", memberId: "beta" },
    ]);
  });

  it("preserves original order within each section", () => {
    const state = makeState(["_agent:b", "step2", "_agent:a", "step1"]);
    const entries = buildLeftPaneEntries(state);

    // Steps appear first in their original order, then agents
    expect(entries).toEqual([
      { kind: "step", stepId: "step2" },
      { kind: "step", stepId: "step1" },
      { kind: "separator", label: "Agents" },
      { kind: "agent", stepId: "_agent:b", memberId: "b" },
      { kind: "agent", stepId: "_agent:a", memberId: "a" },
    ]);
  });
});
