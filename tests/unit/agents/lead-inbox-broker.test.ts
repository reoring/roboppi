/**
 * LeadInboxBroker unit tests.
 *
 * Verifies:
 * - Broker writes/updates `_agents/inbox-summary.json` when messages are delivered
 * - Summary bounds + secret safety (no full body, preview truncation, max entries)
 * - Broker uses claim+ack-by-token; messages end up in cur/ not processing/
 * - Broker stops promptly on abort and does not leak timers
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const TEST_TMP_ROOT = path.join(process.cwd(), ".roboppi-loop", "tmp", "unit-broker");

import { LeadInboxBroker } from "../../../src/agents/lead-inbox-broker.js";
import type { InboxSummary } from "../../../src/agents/lead-inbox-broker.js";
import {
  initAgentsContext,
  deliverMessage,
} from "../../../src/agents/store.js";
import {
  inboxSummaryPath,
  inboxCur,
  inboxProcessing,
} from "../../../src/agents/paths.js";

let contextDir: string;
const TEAM_ID = "test-team-id";

beforeEach(async () => {
  await mkdir(TEST_TMP_ROOT, { recursive: true });
  contextDir = await mkdtemp(path.join(TEST_TMP_ROOT, "agents-broker-test-"));
  await initAgentsContext({
    contextDir,
    teamName: "test-team",
    teamId: TEAM_ID,
    leadMemberId: "lead",
    members: [
      { member_id: "lead", name: "Lead", role: "team_lead" },
      { member_id: "alice", name: "Alice", role: "researcher" },
    ],
  });
});

afterEach(async () => {
  await rm(contextDir, { recursive: true, force: true });
});

async function readSummary(): Promise<InboxSummary> {
  const raw = await readFile(inboxSummaryPath(contextDir), "utf-8");
  return JSON.parse(raw);
}

describe("LeadInboxBroker", () => {
  it("writes inbox-summary.json when messages are delivered to the lead", async () => {
    // Deliver a message to the lead
    await deliverMessage({
      contextDir,
      teamId: TEAM_ID,
      fromMemberId: "alice",
      fromName: "Alice",
      toMemberId: "lead",
      topic: "findings",
      body: "I found something interesting.",
    });

    const broker = new LeadInboxBroker({
      contextDir,
      teamId: TEAM_ID,
      leadMemberId: "lead",
      pollIntervalMs: 50,
    });

    broker.start();
    // Wait for at least one poll cycle
    await new Promise<void>((r) => setTimeout(r, 200));
    broker.stop();

    // Verify summary was written
    const summary = await readSummary();
    expect(summary.version).toBe("1");
    expect(summary.team_id).toBe(TEAM_ID);
    expect(summary.lead_member_id).toBe("lead");
    expect(summary.entries.length).toBe(1);
    expect(summary.entries[0]!.from).toBe("alice");
    expect(summary.entries[0]!.topic).toBe("findings");
    expect(summary.entries[0]!.kind).toBe("text");
    expect(summary.entries[0]!.mailbox_path).toContain("_agents/mailbox/inbox/lead/cur/");
  });

  it("uses claim+ack-by-token; messages end up in cur/ not processing/", async () => {
    await deliverMessage({
      contextDir,
      teamId: TEAM_ID,
      fromMemberId: "alice",
      fromName: "Alice",
      toMemberId: "lead",
      topic: "test",
      body: "Test body.",
    });

    const broker = new LeadInboxBroker({
      contextDir,
      teamId: TEAM_ID,
      leadMemberId: "lead",
      pollIntervalMs: 50,
    });

    broker.start();
    await new Promise<void>((r) => setTimeout(r, 200));
    broker.stop();

    // Messages should be in cur/, not stuck in processing/
    const curFiles = await readdir(inboxCur(contextDir, "lead"));
    expect(curFiles.length).toBe(1);

    let processingFiles: string[] = [];
    try {
      processingFiles = await readdir(inboxProcessing(contextDir, "lead"));
    } catch {
      // processing/ may not exist or be empty
    }
    expect(processingFiles.length).toBe(0);
  });

  it("truncates body preview and never copies full body (secret safety)", async () => {
    const longBody = "A".repeat(500); // > 200 byte default max
    await deliverMessage({
      contextDir,
      teamId: TEAM_ID,
      fromMemberId: "alice",
      fromName: "Alice",
      toMemberId: "lead",
      topic: "secret",
      body: longBody,
    });

    const broker = new LeadInboxBroker({
      contextDir,
      teamId: TEAM_ID,
      leadMemberId: "lead",
      pollIntervalMs: 50,
      previewMaxBytes: 200,
    });

    broker.start();
    await new Promise<void>((r) => setTimeout(r, 200));
    broker.stop();

    const summary = await readSummary();
    expect(summary.entries.length).toBe(1);
    const preview = summary.entries[0]!.body_preview!;
    // Preview must be truncated (shorter than original)
    expect(preview.length).toBeLessThan(longBody.length);
    // Preview must end with ASCII "..." not Unicode ellipsis
    expect(preview.endsWith("...")).toBe(true);
    expect(preview).not.toContain("\u2026"); // no Unicode ellipsis
  });

  it("omits body_preview for short bodies (never copies full body)", async () => {
    const shortBody = "hello";
    await deliverMessage({
      contextDir,
      teamId: TEAM_ID,
      fromMemberId: "alice",
      fromName: "Alice",
      toMemberId: "lead",
      topic: "short",
      body: shortBody,
    });

    const broker = new LeadInboxBroker({
      contextDir,
      teamId: TEAM_ID,
      leadMemberId: "lead",
      pollIntervalMs: 50,
    });

    broker.start();
    await new Promise<void>((r) => setTimeout(r, 200));
    broker.stop();

    const summary = await readSummary();
    expect(summary.entries.length).toBe(1);
    // Short bodies must NOT appear in the summary at all — secret safety
    expect(summary.entries[0]!.body_preview).toBeUndefined();
  });

  it("bounds entries to maxSummaryEntries", async () => {
    // Deliver more messages than the max
    const maxEntries = 3;
    for (let i = 0; i < 5; i++) {
      await deliverMessage({
        contextDir,
        teamId: TEAM_ID,
        fromMemberId: "alice",
        fromName: "Alice",
        toMemberId: "lead",
        topic: `topic-${i}`,
        body: `body ${i}`,
      });
    }

    const broker = new LeadInboxBroker({
      contextDir,
      teamId: TEAM_ID,
      leadMemberId: "lead",
      pollIntervalMs: 50,
      maxSummaryEntries: maxEntries,
      batchSize: 10,
    });

    broker.start();
    await new Promise<void>((r) => setTimeout(r, 300));
    broker.stop();

    const summary = await readSummary();
    // Should be bounded to maxSummaryEntries
    expect(summary.entries.length).toBeLessThanOrEqual(maxEntries);
    // Most recent entries should be kept
    expect(summary.unread_count).toBe(5);
  });

  it("stops promptly on abort signal and does not leak timers", async () => {
    await deliverMessage({
      contextDir,
      teamId: TEAM_ID,
      fromMemberId: "alice",
      fromName: "Alice",
      toMemberId: "lead",
      topic: "pre-abort",
      body: "message before abort",
    });

    const ac = new AbortController();
    const broker = new LeadInboxBroker({
      contextDir,
      teamId: TEAM_ID,
      leadMemberId: "lead",
      pollIntervalMs: 50,
      signal: ac.signal,
    });

    broker.start();
    // Let it process the first message
    await new Promise<void>((r) => setTimeout(r, 200));

    // Deliver another message then immediately abort
    await deliverMessage({
      contextDir,
      teamId: TEAM_ID,
      fromMemberId: "alice",
      fromName: "Alice",
      toMemberId: "lead",
      topic: "post-abort",
      body: "message after abort",
    });
    ac.abort("workflow_cancelled");

    // Wait a bit — broker should have stopped, no more processing
    await new Promise<void>((r) => setTimeout(r, 200));

    // The summary should exist from the first message
    const summary = await readSummary();
    expect(summary.entries.length).toBeGreaterThanOrEqual(1);
    // The broker should be stopped (calling stop again is a no-op)
    broker.stop();
  });

  it("stops immediately if signal is already aborted at start()", async () => {
    const ac = new AbortController();
    ac.abort("already_aborted");

    const broker = new LeadInboxBroker({
      contextDir,
      teamId: TEAM_ID,
      leadMemberId: "lead",
      pollIntervalMs: 50,
      signal: ac.signal,
    });

    broker.start();
    // Should be stopped immediately; wait briefly to confirm no crash
    await new Promise<void>((r) => setTimeout(r, 100));
    broker.stop(); // no-op
  });
});
