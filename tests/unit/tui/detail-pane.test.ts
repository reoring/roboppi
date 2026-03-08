import { describe, it, expect } from "bun:test";
import { resolveEffectiveTab } from "../../../src/tui/components/detail-pane.js";

describe("resolveEffectiveTab", () => {
  it("maps overview to agent_overview when switching to agent", () => {
    expect(resolveEffectiveTab("overview", "_agent:impl")).toBe("agent_overview");
  });

  it("maps agent_overview to overview when switching to step", () => {
    expect(resolveEffectiveTab("agent_overview", "build")).toBe("overview");
  });

  it("preserves logs tab across step/agent", () => {
    expect(resolveEffectiveTab("logs", "_agent:impl")).toBe("logs");
    expect(resolveEffectiveTab("logs", "build")).toBe("logs");
  });

  it("preserves raw_logs and usage tabs across step/agent", () => {
    expect(resolveEffectiveTab("raw_logs", "_agent:impl")).toBe("raw_logs");
    expect(resolveEffectiveTab("raw_logs", "build")).toBe("raw_logs");
    expect(resolveEffectiveTab("usage", "_agent:impl")).toBe("usage");
    expect(resolveEffectiveTab("usage", "build")).toBe("usage");
  });

  it("maps diffs to agents for agent context", () => {
    expect(resolveEffectiveTab("diffs", "_agent:impl")).toBe("agents");
  });
});
