import { describe, it, expect } from "bun:test";
import { getAgentHintText } from "../../../src/tui/state-store.js";
import { RingBuffer } from "../../../src/tui/ring-buffer.js";
import type { StepUiState } from "../../../src/tui/state-store.js";

function makeStep(overrides?: Partial<StepUiState>): StepUiState {
  const logOpts = { maxLines: 100, maxBytes: 10000 };
  return {
    stepId: "_agent:test",
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

describe("getAgentHintText", () => {
  it("returns empty string when no data", () => {
    const step = makeStep();
    expect(getAgentHintText(step)).toBe("");
  });

  it("returns progress message when available", () => {
    const step = makeStep({
      progress: { ts: Date.now(), message: "Editing file..." },
    });
    step.logs.stdout.push("some stdout line");
    step.phase = "executing";
    expect(getAgentHintText(step)).toBe("Editing file...");
  });

  it("returns last stdout line when no progress", () => {
    const step = makeStep();
    step.logs.stdout.push("line 1");
    step.logs.stdout.push("Writing src/counter.ts...");
    step.phase = "executing";
    expect(getAgentHintText(step)).toBe("Writing src/counter.ts...");
  });

  it("returns phase when no progress or stdout", () => {
    const step = makeStep({ phase: "reviewing" });
    expect(getAgentHintText(step)).toBe("reviewing");
  });

  it("skips whitespace-only stdout lines", () => {
    const step = makeStep({ phase: "working" });
    step.logs.stdout.push("   ");
    expect(getAgentHintText(step)).toBe("working");
  });
});
