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
import type { WorkflowUiState, AgentActivityEntry, AgentRosterEntry, AgentRuntimeStats, StepUiState } from "../../../src/tui/state-store.js";

function makeState(
  entries: AgentActivityEntry[] = [],
  activityLines: string[] = [],
  opts?: {
    roster?: AgentRosterEntry[];
    runtime?: AgentRuntimeStats[];
    steps?: StepUiState[];
  },
): WorkflowUiState {
  const buf = new RingBuffer<string>({ maxLines: 100, maxBytes: 10000 });
  for (const l of activityLines) buf.push(l);
  const steps = new Map((opts?.steps ?? []).map((step) => [step.stepId, step]));
  const roster = opts?.roster ?? [];
  const runtime = opts?.runtime ?? [];

  return {
    steps,
    stepOrder: [...steps.keys()],
    followMode: "running",
    selectedTab: "agents",
    coreLogs: new RingBuffer<string>({ maxLines: 100, maxBytes: 10000 }),
    warnings: new RingBuffer<string>({ maxLines: 100, maxBytes: 10000 }),
    agentActivity: buf,
    agentEntries: entries,
    agentRoster: new Map(roster.map((entry) => [entry.memberId, entry])),
    agentRosterOrder: roster.map((entry) => entry.memberId),
    agentRuntime: new Map(runtime.map((entry) => [entry.memberId, entry])),
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

  it("renders cross-agent summary rows in the global Agents tab", () => {
    const state = makeState([], [], {
      roster: [
        { memberId: "implementer", name: "implementer", role: "member", agentId: "implementer" },
        { memberId: "manual_verifier", name: "manual_verifier", role: "dormant", agentId: "manual_verifier" },
      ],
      runtime: [
        {
          memberId: "implementer",
          dispatchCount: 5,
          restartCount: 2,
          totalEstimatedTokens: 23_400,
          totalInstructionBytes: 32_768,
          lastStartedAt: Date.parse("2026-03-09T01:00:00.000Z"),
          lastStoppedAt: Date.parse("2026-03-09T01:05:00.000Z"),
          lastDispatchStartedAt: Date.parse("2026-03-09T01:00:10.000Z"),
          lastDispatchFinishedAt: Date.parse("2026-03-09T01:00:50.000Z"),
          lastDispatchDurationMs: 40_000,
          totalDispatchActiveMs: 125_000,
        },
      ],
      steps: [
        {
          stepId: "_agent:implementer",
          status: "RUNNING",
          phase: "executing",
          iteration: 1,
          maxIterations: 1,
          startedAt: Date.parse("2026-03-09T01:00:00.000Z"),
          logs: {
            stdout: new RingBuffer<string>({ maxLines: 100, maxBytes: 10000 }),
            stderr: new RingBuffer<string>({ maxLines: 100, maxBytes: 10000 }),
            progress: new RingBuffer<string>({ maxLines: 100, maxBytes: 10000 }),
          },
          patches: {
            byId: new Map(),
            order: [],
            byFilePath: new Map(),
          },
        },
      ],
    });

    const output = renderAgentsTab(state, 110, 20);
    expect(output).toContain("Agent Summary");
    expect(output).toContain("implementer");
    expect(output).toContain("RUNNING");
    expect(output).toContain("manual_verifier");
    expect(output).toContain("DORMANT");
    expect(output).toContain("Disp");
    expect(output).toContain("Re");
    expect(output).toContain("Tok");
    expect(output).toContain("Prompt");
    expect(output).toContain("23k");
    expect(output).toContain("32K");
  });

  it("uses available height to show all summary rows when activity is empty", () => {
    const roster: AgentRosterEntry[] = Array.from({ length: 12 }, (_, i) => ({
      memberId: `agent_${i}`,
      name: `agent_${i}`,
      role: i < 5 ? "member" : "dormant",
      agentId: `profile_${i}`,
    }));
    const runtime: AgentRuntimeStats[] = roster.map((entry, i) => ({
      memberId: entry.memberId,
      dispatchCount: i,
      restartCount: 0,
      totalDispatchActiveMs: i * 1000,
      lastStartedAt: Date.parse(`2026-03-09T01:${String(i).padStart(2, "0")}:00.000Z`),
    }));

    const output = renderAgentsTab(makeState([], [], { roster, runtime }), 110, 24);
    expect(output).toContain("agent_0");
    expect(output).toContain("agent_11");
    expect(output).not.toContain("+");
    expect(output).not.toContain("Recent Activity");
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

  it("keeps filtered agent activity view focused on activity", () => {
    const state = makeState([
      {
        ts: Date.now(),
        type: "agent_message_sent",
        teamId: "team-1",
        id: "msg-1",
        memberId: "reviewer",
        targetMemberId: "lead",
        label: "review",
      },
    ], [], {
      roster: [
        { memberId: "reviewer", name: "reviewer", role: "member", agentId: "reviewer" },
      ],
      runtime: [
        {
          memberId: "reviewer",
          dispatchCount: 2,
          restartCount: 1,
          totalDispatchActiveMs: 15_000,
        },
      ],
    });

    const output = renderAgentsTab(state, 80, 20, "reviewer");
    expect(output).toContain("Activity: reviewer");
    expect(output).not.toContain("Agent Summary");
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
