/**
 * Agent Store — mailbox semantics unit tests.
 *
 * Covers design §11.1:
 * - deliverMessage() -> file appears in inbox/<member>/new/ + event
 * - recvMessages({ claim:true }) -> moves to processing/ + claim token
 * - claim-token ack -> moves to cur/ + emits message_acked
 * - broadcastMessage() -> delivers to N recipients deterministically
 * - housekeeping -> requeues stale processing/ -> new/, dead-letters after max
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, readFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  initAgentsContext,
  deliverMessage,
  broadcastMessage,
  recvMessages,
  ackMessage,
  ackMessageByClaimToken,
  claimMessage,
} from "../../../src/agents/store.js";
import { housekeepMailbox } from "../../../src/agents/housekeeping.js";
import {
  inboxNew,
  inboxProcessing,
  inboxCur,
  inboxDead,
  mailboxEventsPath,
} from "../../../src/agents/paths.js";

let contextDir: string;

beforeEach(async () => {
  contextDir = await mkdtemp(path.join(tmpdir(), "agents-store-test-"));
  await initAgentsContext({
    contextDir,
    teamName: "test-team",
    leadMemberId: "lead",
    members: [
      { member_id: "lead", name: "Lead", role: "team_lead" },
      { member_id: "alice", name: "Alice", role: "researcher" },
      { member_id: "bob", name: "Bob", role: "reviewer" },
    ],
  });
});

afterEach(async () => {
  await rm(contextDir, { recursive: true, force: true });
});

describe("deliverMessage", () => {
  it("creates a file in inbox/<member>/new/", async () => {
    const { messageId } = await deliverMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      toMemberId: "alice",
      topic: "greeting",
      body: "Hello Alice",
    });

    expect(messageId).toBeTruthy();

    const newDir = inboxNew(contextDir, "alice");
    const entries = await readdir(newDir);
    expect(entries.length).toBe(1);
    expect(entries[0]!).toContain(messageId);
    expect(entries[0]!).toEndWith(".json");

    // Verify file contents
    const raw = await readFile(path.join(newDir, entries[0]!), "utf-8");
    const msg = JSON.parse(raw);
    expect(msg.message_id).toBe(messageId);
    expect(msg.from.member_id).toBe("lead");
    expect(msg.to.type).toBe("member");
    expect(msg.to.member_id).toBe("alice");
    expect(msg.topic).toBe("greeting");
    expect(msg.body).toBe("Hello Alice");
  });

  it("emits message_delivered event", async () => {
    await deliverMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      toMemberId: "alice",
      topic: "test",
      body: "hi",
    });

    const eventsRaw = await readFile(mailboxEventsPath(contextDir), "utf-8");
    const events = eventsRaw.trim().split("\n").map((l) => JSON.parse(l));
    const delivered = events.find((e: Record<string, unknown>) => e.type === "message_delivered");
    expect(delivered).toBeTruthy();
    expect(delivered!.from).toBe("lead");
    expect(delivered!.to).toBe("alice");
    expect(delivered!.topic).toBe("test");
  });

  it("rejects messages exceeding max body size", async () => {
    const bigBody = "x".repeat(65 * 1024); // > 64KB
    await expect(
      deliverMessage({
        contextDir,
        teamId: "team-1",
        fromMemberId: "lead",
        fromName: "Lead",
        toMemberId: "alice",
        topic: "big",
        body: bigBody,
      }),
    ).rejects.toThrow(/exceeds max size/);
  });
});

describe("recvMessages with claim", () => {
  it("moves message to processing/ and returns claim token", async () => {
    await deliverMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      toMemberId: "alice",
      topic: "work",
      body: "do this",
    });

    const messages = await recvMessages({
      contextDir,
      memberId: "alice",
      claim: true,
    });

    expect(messages.length).toBe(1);
    const msg0 = messages[0]!;
    expect(msg0.claim).toBeTruthy();
    expect(msg0.claim!.token).toBeTruthy();
    expect(msg0.claim!.expires_at).toBeGreaterThan(Date.now());

    // new/ should be empty, processing/ should have the file
    const newEntries = await readdir(inboxNew(contextDir, "alice"));
    expect(newEntries.length).toBe(0);

    const procEntries = await readdir(inboxProcessing(contextDir, "alice"));
    expect(procEntries.length).toBe(1);
  });

  it("respects --max parameter", async () => {
    // Deliver 3 messages
    for (let i = 0; i < 3; i++) {
      await deliverMessage({
        contextDir,
        teamId: "team-1",
        fromMemberId: "lead",
        fromName: "Lead",
        toMemberId: "alice",
        topic: `msg-${i}`,
        body: `body-${i}`,
      });
    }

    const messages = await recvMessages({
      contextDir,
      memberId: "alice",
      claim: true,
      max: 2,
    });

    expect(messages.length).toBe(2);
  });

  it("returns messages in lexicographic (chronological) order", async () => {
    for (let i = 0; i < 3; i++) {
      await deliverMessage({
        contextDir,
        teamId: "team-1",
        fromMemberId: "lead",
        fromName: "Lead",
        toMemberId: "alice",
        topic: `msg-${i}`,
        body: `body-${i}`,
      });
      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 2));
    }

    const messages = await recvMessages({
      contextDir,
      memberId: "alice",
    });

    expect(messages.length).toBe(3);
    // Should be in chronological order
    for (let i = 1; i < messages.length; i++) {
      expect(messages[i]!.message.ts).toBeGreaterThanOrEqual(messages[i - 1]!.message.ts);
    }
  });
});

describe("claim-token ack", () => {
  it("moves message from processing/ to cur/", async () => {
    await deliverMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      toMemberId: "alice",
      topic: "ack-test",
      body: "ack me",
    });

    const messages = await recvMessages({
      contextDir,
      memberId: "alice",
      claim: true,
    });

    const token = messages[0]!.claim!.token;
    const success = await ackMessageByClaimToken(contextDir, "alice", token);
    expect(success).toBe(true);

    // processing/ should be empty, cur/ should have the file
    const procEntries = await readdir(inboxProcessing(contextDir, "alice"));
    expect(procEntries.length).toBe(0);

    const curEntries = await readdir(inboxCur(contextDir, "alice"));
    expect(curEntries.length).toBe(1);
  });

  it("emits message_acked event", async () => {
    await deliverMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      toMemberId: "alice",
      topic: "ack-evt",
      body: "body",
    });

    const messages = await recvMessages({
      contextDir,
      memberId: "alice",
      claim: true,
    });

    await ackMessageByClaimToken(contextDir, "alice", messages[0]!.claim!.token);

    const eventsRaw = await readFile(mailboxEventsPath(contextDir), "utf-8");
    const events = eventsRaw.trim().split("\n").map((l) => JSON.parse(l));
    const acked = events.find((e: Record<string, unknown>) => e.type === "message_acked");
    expect(acked).toBeTruthy();
    expect(acked!.by).toBe("alice");
  });

  it("rejects invalid claim token", async () => {
    const success = await ackMessageByClaimToken(contextDir, "alice", "bogus-token");
    expect(success).toBe(false);
  });

  it("legacy ackMessage by messageId still works", async () => {
    const { messageId } = await deliverMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      toMemberId: "alice",
      topic: "legacy",
      body: "legacy body",
    });

    await recvMessages({ contextDir, memberId: "alice", claim: true });
    const success = await ackMessage(contextDir, "alice", messageId);
    expect(success).toBe(true);

    const curEntries = await readdir(inboxCur(contextDir, "alice"));
    expect(curEntries.length).toBe(1);
  });
});

describe("broadcastMessage", () => {
  it("delivers to N recipients (excluding sender)", async () => {
    const result = await broadcastMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      topic: "announcement",
      body: "hello all",
    });

    expect(result.messageId).toBeTruthy();
    // Delivered to alice and bob (not lead)
    expect(result.delivered.length).toBe(2);
    expect(result.delivered).toContain("alice");
    expect(result.delivered).toContain("bob");

    // Each recipient should have the message
    for (const memberId of ["alice", "bob"]) {
      const entries = await readdir(inboxNew(contextDir, memberId));
      expect(entries.length).toBe(1);
    }

    // Lead should NOT have the message
    const leadEntries = await readdir(inboxNew(contextDir, "lead"));
    expect(leadEntries.length).toBe(0);
  });

  it("returns delivered member IDs in sorted order (deterministic)", async () => {
    const result = await broadcastMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      topic: "order-test",
      body: "test",
    });

    // Should be sorted alphabetically
    const sorted = [...result.delivered].sort();
    expect(result.delivered).toEqual(sorted);
  });

  it("includes sender when includeSelf is true", async () => {
    const result = await broadcastMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      topic: "self-include",
      body: "me too",
      includeSelf: true,
    });

    expect(result.delivered).toContain("lead");
    expect(result.delivered.length).toBe(3);
  });
});

describe("housekeeping", () => {
  it("requeues stale processing/ messages back to new/", async () => {
    await deliverMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      toMemberId: "alice",
      topic: "stale",
      body: "will be stale",
    });

    // Claim it
    await recvMessages({ contextDir, memberId: "alice", claim: true });

    // Make processing file look old by touching mtime
    const procDir = inboxProcessing(contextDir, "alice");
    const procEntries = await readdir(procDir);
    const filePath = path.join(procDir, procEntries[0]!);
    const oldTime = new Date(Date.now() - 20 * 60 * 1000); // 20 minutes ago
    await utimes(filePath, oldTime, oldTime);

    // Run housekeeping with short TTL
    const result = await housekeepMailbox({
      contextDir,
      processingTtlMs: 1, // 1ms TTL = everything is stale
    });

    expect(result.requeued).toBe(1);
    expect(result.deadLettered).toBe(0);

    // Message should be back in new/
    const newEntries = await readdir(inboxNew(contextDir, "alice"));
    expect(newEntries.length).toBe(1);

    // processing/ should be empty
    const procAfter = await readdir(procDir);
    expect(procAfter.length).toBe(0);
  });

  it("increments delivery_attempt on requeue", async () => {
    await deliverMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      toMemberId: "alice",
      topic: "attempt",
      body: "retry me",
    });

    // Claim and make stale
    await recvMessages({ contextDir, memberId: "alice", claim: true });
    const procDir = inboxProcessing(contextDir, "alice");
    const procEntries = await readdir(procDir);
    const filePath = path.join(procDir, procEntries[0]!);
    const oldTime = new Date(Date.now() - 20 * 60 * 1000);
    await utimes(filePath, oldTime, oldTime);

    await housekeepMailbox({ contextDir, processingTtlMs: 1 });

    // Read the requeued message and check attempt
    const newDir = inboxNew(contextDir, "alice");
    const newEntries = await readdir(newDir);
    const raw = await readFile(path.join(newDir, newEntries[0]!), "utf-8");
    const msg = JSON.parse(raw);
    expect(msg.delivery_attempt).toBe(2);
  });

  it("dead-letters after max delivery attempts", async () => {
    await deliverMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      toMemberId: "alice",
      topic: "dead",
      body: "will die",
    });

    // Claim and make stale, repeat until dead-lettered
    for (let i = 0; i < 5; i++) {
      await recvMessages({ contextDir, memberId: "alice", claim: true });
      const procDir = inboxProcessing(contextDir, "alice");
      let procEntries: string[];
      try {
        procEntries = await readdir(procDir);
      } catch {
        break; // already moved
      }
      if (procEntries.length === 0) break;
      const filePath = path.join(procDir, procEntries[0]!);
      const oldTime = new Date(Date.now() - 20 * 60 * 1000);
      await utimes(filePath, oldTime, oldTime);
      await housekeepMailbox({ contextDir, processingTtlMs: 1, maxDeliveryAttempts: 3 });
    }

    // Should be in dead/
    const deadDir = inboxDead(contextDir, "alice");
    const deadEntries = await readdir(deadDir);
    expect(deadEntries.length).toBe(1);

    // new/ and processing/ should be empty
    const newEntries = await readdir(inboxNew(contextDir, "alice"));
    expect(newEntries.length).toBe(0);
  });

  it("emits message_requeued and message_dead events", async () => {
    await deliverMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      toMemberId: "alice",
      topic: "events",
      body: "evt body",
    });

    // Claim, stale, requeue
    await recvMessages({ contextDir, memberId: "alice", claim: true });
    const procDir = inboxProcessing(contextDir, "alice");
    const procEntries = await readdir(procDir);
    const filePath = path.join(procDir, procEntries[0]!);
    const oldTime = new Date(Date.now() - 20 * 60 * 1000);
    await utimes(filePath, oldTime, oldTime);

    await housekeepMailbox({ contextDir, processingTtlMs: 1 });

    const eventsRaw = await readFile(mailboxEventsPath(contextDir), "utf-8");
    const events = eventsRaw.trim().split("\n").map((l) => JSON.parse(l));
    const requeued = events.find((e: Record<string, unknown>) => e.type === "message_requeued");
    expect(requeued).toBeTruthy();
    expect(requeued!.delivery_attempt).toBe(2);
  });
});

describe("claimMessage (standalone)", () => {
  it("moves a specific message from new/ to processing/ and returns claim token", async () => {
    const { messageId } = await deliverMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      toMemberId: "alice",
      topic: "claim",
      body: "claim me",
    });

    const result = await claimMessage(contextDir, "alice", messageId);
    expect(result.ok).toBe(true);
    expect(result.claim).toBeTruthy();
    expect(result.claim!.token).toBeTruthy();

    const newEntries = await readdir(inboxNew(contextDir, "alice"));
    expect(newEntries.length).toBe(0);

    const procEntries = await readdir(inboxProcessing(contextDir, "alice"));
    expect(procEntries.length).toBe(1);
  });
});

describe("metadata-only events", () => {
  it("event entries never contain message body", async () => {
    await deliverMessage({
      contextDir,
      teamId: "team-1",
      fromMemberId: "lead",
      fromName: "Lead",
      toMemberId: "alice",
      topic: "secret-test",
      body: "THIS_IS_SECRET_BODY_CONTENT",
    });

    await recvMessages({ contextDir, memberId: "alice", claim: true });

    const eventsRaw = await readFile(mailboxEventsPath(contextDir), "utf-8");
    // Verify body does not appear anywhere in the events file
    expect(eventsRaw).not.toContain("THIS_IS_SECRET_BODY_CONTENT");
  });
});
