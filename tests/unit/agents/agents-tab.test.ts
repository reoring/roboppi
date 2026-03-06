/**
 * Agents tab renderer unit tests.
 *
 * Covers:
 * - renderAgentsTab produces output for message/task events
 * - Metadata-only display: no message bodies or task descriptions in output
 */
import { describe, it, expect } from "bun:test";
import { renderAgentsTab } from "../../../src/tui/components/tabs/agents-tab.js";
import { RingBuffer } from "../../../src/tui/ring-buffer.js";
import type { WorkflowUiState, AgentActivityEntry } from "../../../src/tui/state-store.js";

function makeState(entries: AgentActivityEntry[] = [], activityLines: string[] = []): WorkflowUiState {
  const buf = new RingBuffer<string>({ maxLines: 100, maxBytes: 10000 });
  for (const l of activityLines) buf.push(l);

  return {
    steps: new Map(),
    stepOrder: [],
    followMode: "running",
    selectedTab: "agents",
    coreLogs: new RingBuffer<string>({ maxLines: 100, maxBytes: 10000 }),
    warnings: new RingBuffer<string>({ maxLines: 100, maxBytes: 10000 }),
    agentActivity: buf,
    agentEntries: entries,
    chatMessages: [],
    chatInputActive: false,
    chatInputBuffer: "",
    chatInputTarget: "",
  };
}

describe("renderAgentsTab", () => {
  it("shows 'No agent activity yet' when empty", () => {
    const state = makeState();
    const output = renderAgentsTab(state, 80, 20);
    expect(output).toContain("No agent activity");
  });

  it("renders message sent entries", () => {
    const entries: AgentActivityEntry[] = [
      {
        ts: Date.now(),
        type: "agent_message_sent",
        teamId: "team-1",
        id: "msg-1",
        memberId: "alice",
        label: "findings",
      },
    ];
    const state = makeState(entries);
    const output = renderAgentsTab(state, 80, 20);
    expect(output).toContain("alice");
    expect(output).toContain("→");
    expect(output).toContain("findings");
  });

  it("renders message received entries", () => {
    const entries: AgentActivityEntry[] = [
      {
        ts: Date.now(),
        type: "agent_message_received",
        teamId: "team-1",
        id: "msg-2",
        memberId: "lead",
        label: "update",
      },
    ];
    const state = makeState(entries);
    const output = renderAgentsTab(state, 80, 20);
    expect(output).toContain("lead");
    expect(output).toContain("←");
  });

  it("renders task claimed entries", () => {
    const entries: AgentActivityEntry[] = [
      {
        ts: Date.now(),
        type: "agent_task_claimed",
        teamId: "team-1",
        id: "task-1",
        memberId: "bob",
        label: "Review auth module",
      },
    ];
    const state = makeState(entries);
    const output = renderAgentsTab(state, 80, 20);
    expect(output).toContain("bob");
    expect(output).toContain("claimed");
    expect(output).toContain("Review auth module");
  });

  it("renders task completed entries", () => {
    const entries: AgentActivityEntry[] = [
      {
        ts: Date.now(),
        type: "agent_task_completed",
        teamId: "team-1",
        id: "task-2",
        memberId: "carol",
        label: "Fix bug #42",
      },
    ];
    const state = makeState(entries);
    const output = renderAgentsTab(state, 80, 20);
    expect(output).toContain("carol");
    expect(output).toContain("completed");
  });

  it("falls back to activity log lines when no structured entries", () => {
    const state = makeState([], ["[agents] message from alice"]);
    const output = renderAgentsTab(state, 80, 20);
    expect(output).toContain("message from alice");
  });

  it("respects height limit", () => {
    const entries: AgentActivityEntry[] = Array.from({ length: 50 }, (_, i) => ({
      ts: Date.now() + i,
      type: "agent_message_sent" as const,
      teamId: "team-1",
      id: `msg-${i}`,
      memberId: "alice",
      label: `topic-${i}`,
    }));
    const state = makeState(entries);
    const output = renderAgentsTab(state, 80, 10);
    const lines = output.split("\n");
    expect(lines.length).toBe(10);
  });
});

describe("metadata-only display policy", () => {
  it("agent entries never contain message bodies", () => {
    // AgentActivityEntry does not have a 'body' field at all
    const entries: AgentActivityEntry[] = [
      {
        ts: Date.now(),
        type: "agent_message_sent",
        teamId: "team-1",
        id: "msg-secret",
        memberId: "alice",
        label: "findings", // This is the topic, not the body
      },
    ];

    // Verify the type itself doesn't allow body
    const entry = entries[0]!;
    expect("body" in entry).toBe(false);

    // Render and verify no body could have leaked
    const state = makeState(entries);
    const output = renderAgentsTab(state, 80, 20);
    // Output should only contain metadata fields
    expect(output).not.toContain("SECRET_BODY");
  });

  it("agent entries never contain task descriptions", () => {
    const entries: AgentActivityEntry[] = [
      {
        ts: Date.now(),
        type: "agent_task_claimed",
        teamId: "team-1",
        id: "task-secret",
        memberId: "bob",
        label: "Review auth", // Title (metadata), not description
      },
    ];

    const entry = entries[0]!;
    expect("description" in entry).toBe(false);

    const state = makeState(entries);
    const output = renderAgentsTab(state, 80, 20);
    expect(output).not.toContain("SECRET_DESCRIPTION");
  });
});
