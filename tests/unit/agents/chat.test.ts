/**
 * Agent Chat unit tests.
 *
 * Tests parseChatCommand and formatReceivedMessage — the pure functions
 * that don't require filesystem state.
 */
import { describe, it, expect } from "bun:test";
import { parseChatCommand, formatReceivedMessage } from "../../../src/agents/chat.js";
import type { ReceivedMessage } from "../../../src/agents/store.js";

// ---------------------------------------------------------------------------
// parseChatCommand
// ---------------------------------------------------------------------------

describe("parseChatCommand", () => {
  it("returns empty for blank input", () => {
    expect(parseChatCommand("")).toEqual({ type: "empty" });
    expect(parseChatCommand("   ")).toEqual({ type: "empty" });
  });

  it("parses /to with target and body", () => {
    expect(parseChatCommand("/to lead hello world")).toEqual({
      type: "to",
      target: "lead",
      body: "hello world",
    });
  });

  it("returns help for /to without body", () => {
    expect(parseChatCommand("/to lead")).toEqual({ type: "help" });
  });

  it("returns help for /to without target", () => {
    expect(parseChatCommand("/to")).toEqual({ type: "help" });
  });

  it("parses /broadcast with body", () => {
    expect(parseChatCommand("/broadcast hey everyone")).toEqual({
      type: "broadcast",
      body: "hey everyone",
    });
  });

  it("returns help for /broadcast without body", () => {
    expect(parseChatCommand("/broadcast")).toEqual({ type: "help" });
  });

  it("parses /members", () => {
    expect(parseChatCommand("/members")).toEqual({ type: "members" });
  });

  it("parses /tasks without status", () => {
    expect(parseChatCommand("/tasks")).toEqual({ type: "tasks", status: undefined });
  });

  it("parses /tasks with status", () => {
    expect(parseChatCommand("/tasks pending")).toEqual({ type: "tasks", status: "pending" });
  });

  it("parses /history without count (default 20)", () => {
    expect(parseChatCommand("/history")).toEqual({ type: "history", count: 20 });
  });

  it("parses /history with count", () => {
    expect(parseChatCommand("/history 5")).toEqual({ type: "history", count: 5 });
  });

  it("parses /history with non-numeric count (default 20)", () => {
    expect(parseChatCommand("/history abc")).toEqual({ type: "history", count: 20 });
  });

  it("parses /help", () => {
    expect(parseChatCommand("/help")).toEqual({ type: "help" });
  });

  it("parses /quit", () => {
    expect(parseChatCommand("/quit")).toEqual({ type: "quit" });
  });

  it("parses /exit as quit", () => {
    expect(parseChatCommand("/exit")).toEqual({ type: "quit" });
  });

  it("parses /q as quit", () => {
    expect(parseChatCommand("/q")).toEqual({ type: "quit" });
  });

  it("returns help for unknown command", () => {
    expect(parseChatCommand("/unknown")).toEqual({ type: "help" });
  });

  it("returns repeat for plain text", () => {
    expect(parseChatCommand("hello")).toEqual({ type: "repeat", body: "hello" });
  });

  it("trims whitespace on plain text repeat", () => {
    expect(parseChatCommand("  hello world  ")).toEqual({ type: "repeat", body: "hello world" });
  });
});

// ---------------------------------------------------------------------------
// formatReceivedMessage
// ---------------------------------------------------------------------------

describe("formatReceivedMessage", () => {
  function makeMsg(overrides: Partial<{
    ts: number;
    fromId: string;
    fromName: string;
    kind: string;
    body: string;
  }> = {}): ReceivedMessage {
    return {
      messageId: "test-uuid",
      filename: "123-test-uuid.json",
      message: {
        version: "1",
        team_id: "team-1",
        message_id: "test-uuid",
        ts: overrides.ts ?? 1700000000000,
        from: {
          member_id: overrides.fromId ?? "lead",
          name: overrides.fromName ?? "Lead",
        },
        to: { type: "member", member_id: "human" },
        kind: (overrides.kind as "text") ?? "text",
        topic: "chat",
        body: overrides.body ?? "Hello there",
      },
    };
  }

  it("includes sender name and body", () => {
    const result = formatReceivedMessage(makeMsg());
    expect(result).toContain("Lead");
    expect(result).toContain("Hello there");
  });

  it("falls back to member_id when name is empty", () => {
    const result = formatReceivedMessage(makeMsg({ fromName: "", fromId: "worker1" }));
    expect(result).toContain("worker1");
  });

  it("shows kind tag for non-text messages", () => {
    const result = formatReceivedMessage(makeMsg({ kind: "task_update" }));
    expect(result).toContain("[task_update]");
  });

  it("does not show kind tag for text messages", () => {
    const result = formatReceivedMessage(makeMsg({ kind: "text" }));
    expect(result).not.toContain("[text]");
  });

  it("includes timestamp", () => {
    // Use a known timestamp — 2023-11-14T22:13:20.000Z
    const result = formatReceivedMessage(makeMsg({ ts: 1700000000000 }));
    // The formatted time depends on local timezone but should contain digits
    expect(result).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });
});
