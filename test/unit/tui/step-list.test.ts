import { describe, expect, test } from "bun:test";
import { TuiStateStore } from "../../../src/tui/state-store.js";
import { buildLeftPaneEntries, renderStepList } from "../../../src/tui/components/step-list.js";

describe("step-list", () => {
  test("includes dormant roster agents in the left pane", () => {
    const store = new TuiStateStore();
    store.emit({
      type: "workflow_started",
      workflowId: "wf-1",
      name: "test",
      workspaceDir: "/tmp/ws",
      supervised: true,
      startedAt: 1000,
      definitionSummary: {
        steps: ["orchestrate"],
        timeout: "30m",
      },
    });
    store.syncAgentRoster([
      { memberId: "manual_verifier", name: "manual_verifier", role: "dormant", agentId: "manual_verifier" },
      { memberId: "reviewer", name: "reviewer", role: "member", agentId: "reviewer" },
    ]);

    const entries = buildLeftPaneEntries(store.state);
    expect(entries).toEqual([
      { kind: "step", stepId: "orchestrate" },
      { kind: "separator", label: "Agents" },
      { kind: "agent", stepId: "_agent:manual_verifier", memberId: "manual_verifier" },
      { kind: "agent", stepId: "_agent:reviewer", memberId: "reviewer" },
    ]);

    const rendered = renderStepList(store.state, 80, 10);
    expect(rendered).toContain("manual_verifier");
    expect(rendered).toContain("sleeping");
  });
});
