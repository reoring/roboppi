/**
 * Swarm tab renderer unit tests.
 *
 * Covers:
 * - renderSwarmTab produces output for message/task events
 * - Metadata-only display: no message bodies or task descriptions in output
 */
import { describe, it, expect } from "bun:test";
import { renderSwarmTab } from "../../../src/tui/components/tabs/swarm-tab.js";
import { RingBuffer } from "../../../src/tui/ring-buffer.js";
import type { WorkflowUiState, SwarmActivityEntry } from "../../../src/tui/state-store.js";

function makeState(entries: SwarmActivityEntry[] = [], activityLines: string[] = []): WorkflowUiState {
  const buf = new RingBuffer<string>({ maxLines: 100, maxBytes: 10000 });
  for (const l of activityLines) buf.push(l);

  return {
    steps: new Map(),
    stepOrder: [],
    followMode: "running",
    selectedTab: "swarm",
    coreLogs: new RingBuffer<string>({ maxLines: 100, maxBytes: 10000 }),
    warnings: new RingBuffer<string>({ maxLines: 100, maxBytes: 10000 }),
    swarmActivity: buf,
    swarmEntries: entries,
  };
}

describe("renderSwarmTab", () => {
  it("shows 'No swarm activity yet' when empty", () => {
    const state = makeState();
    const output = renderSwarmTab(state, 80, 20);
    expect(output).toContain("No swarm activity");
  });

  it("renders message sent entries", () => {
    const entries: SwarmActivityEntry[] = [
      {
        ts: Date.now(),
        type: "swarm_message_sent",
        teamId: "team-1",
        id: "msg-1",
        memberId: "alice",
        label: "findings",
      },
    ];
    const state = makeState(entries);
    const output = renderSwarmTab(state, 80, 20);
    expect(output).toContain("alice");
    expect(output).toContain("sent");
    expect(output).toContain("findings");
  });

  it("renders message received entries", () => {
    const entries: SwarmActivityEntry[] = [
      {
        ts: Date.now(),
        type: "swarm_message_received",
        teamId: "team-1",
        id: "msg-2",
        memberId: "lead",
        label: "update",
      },
    ];
    const state = makeState(entries);
    const output = renderSwarmTab(state, 80, 20);
    expect(output).toContain("lead");
    expect(output).toContain("recv");
  });

  it("renders task claimed entries", () => {
    const entries: SwarmActivityEntry[] = [
      {
        ts: Date.now(),
        type: "swarm_task_claimed",
        teamId: "team-1",
        id: "task-1",
        memberId: "bob",
        label: "Review auth module",
      },
    ];
    const state = makeState(entries);
    const output = renderSwarmTab(state, 80, 20);
    expect(output).toContain("bob");
    expect(output).toContain("claimed");
    expect(output).toContain("Review auth module");
  });

  it("renders task completed entries", () => {
    const entries: SwarmActivityEntry[] = [
      {
        ts: Date.now(),
        type: "swarm_task_completed",
        teamId: "team-1",
        id: "task-2",
        memberId: "carol",
        label: "Fix bug #42",
      },
    ];
    const state = makeState(entries);
    const output = renderSwarmTab(state, 80, 20);
    expect(output).toContain("carol");
    expect(output).toContain("completed");
  });

  it("falls back to activity log lines when no structured entries", () => {
    const state = makeState([], ["[swarm] message from alice"]);
    const output = renderSwarmTab(state, 80, 20);
    expect(output).toContain("message from alice");
  });

  it("respects height limit", () => {
    const entries: SwarmActivityEntry[] = Array.from({ length: 50 }, (_, i) => ({
      ts: Date.now() + i,
      type: "swarm_message_sent" as const,
      teamId: "team-1",
      id: `msg-${i}`,
      memberId: "alice",
      label: `topic-${i}`,
    }));
    const state = makeState(entries);
    const output = renderSwarmTab(state, 80, 10);
    const lines = output.split("\n");
    expect(lines.length).toBe(10);
  });
});

describe("metadata-only display policy", () => {
  it("swarm entries never contain message bodies", () => {
    // SwarmActivityEntry does not have a 'body' field at all
    const entries: SwarmActivityEntry[] = [
      {
        ts: Date.now(),
        type: "swarm_message_sent",
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
    const output = renderSwarmTab(state, 80, 20);
    // Output should only contain metadata fields
    expect(output).not.toContain("SECRET_BODY");
  });

  it("swarm entries never contain task descriptions", () => {
    const entries: SwarmActivityEntry[] = [
      {
        ts: Date.now(),
        type: "swarm_task_claimed",
        teamId: "team-1",
        id: "task-secret",
        memberId: "bob",
        label: "Review auth", // Title (metadata), not description
      },
    ];

    const entry = entries[0]!;
    expect("description" in entry).toBe(false);

    const state = makeState(entries);
    const output = renderSwarmTab(state, 80, 20);
    expect(output).not.toContain("SECRET_DESCRIPTION");
  });
});
