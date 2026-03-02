/**
 * Swarm concurrency tests.
 *
 * Covers design §11.2:
 * - N parallel senders deliver to one inbox without corruption
 * - N claimers contend for one task; exactly one wins
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  initSwarmContext,
  deliverMessage,
  recvMessages,
} from "../../../src/swarm/store.js";
import {
  addTask,
  claimTask,
} from "../../../src/swarm/task-store.js";
import {
  inboxNew,
  tasksStatusDir,
} from "../../../src/swarm/paths.js";

let contextDir: string;

beforeEach(async () => {
  contextDir = await mkdtemp(path.join(tmpdir(), "swarm-concurrency-test-"));
  await initSwarmContext({
    contextDir,
    teamName: "test-team",
    leadMemberId: "lead",
    members: [
      { member_id: "lead", name: "Lead", role: "team_lead" },
      { member_id: "alice", name: "Alice", role: "researcher" },
      { member_id: "bob", name: "Bob", role: "reviewer" },
      { member_id: "carol", name: "Carol", role: "coder" },
      { member_id: "dave", name: "Dave", role: "tester" },
    ],
  });
});

afterEach(async () => {
  await rm(contextDir, { recursive: true, force: true });
});

describe("parallel senders to one inbox", () => {
  it("N parallel sends all deliver without corruption", async () => {
    const N = 10;
    const senders = ["alice", "bob", "carol", "dave"];

    // Fire N sends in parallel from different senders to "lead"
    const promises = Array.from({ length: N }, (_, i) => {
      const sender = senders[i % senders.length]!;
      return deliverMessage({
        contextDir,
        teamId: "team-1",
        fromMemberId: sender,
        fromName: sender,
        toMemberId: "lead",
        topic: `parallel-${i}`,
        body: `message ${i} from ${sender}`,
      });
    });

    const results = await Promise.all(promises);

    // All should succeed with unique messageIds
    const ids = new Set(results.map((r) => r.messageId));
    expect(ids.size).toBe(N);

    // All N messages should be in lead's inbox
    const entries = await readdir(inboxNew(contextDir, "lead"));
    const jsonEntries = entries.filter((f) => f.endsWith(".json"));
    expect(jsonEntries.length).toBe(N);

    // Each file should be valid JSON (no corruption from interleaving)
    for (const filename of jsonEntries) {
      const raw = await readFile(
        path.join(inboxNew(contextDir, "lead"), filename),
        "utf-8",
      );
      const msg = JSON.parse(raw);
      expect(msg.version).toBe("1");
      expect(msg.message_id).toBeTruthy();
      expect(msg.to.member_id).toBe("lead");
    }
  });

  it("concurrent recv+claim on same inbox resolves without duplication", async () => {
    // Deliver 5 messages to alice
    for (let i = 0; i < 5; i++) {
      await deliverMessage({
        contextDir,
        teamId: "team-1",
        fromMemberId: "lead",
        fromName: "Lead",
        toMemberId: "alice",
        topic: `work-${i}`,
        body: `task ${i}`,
      });
    }

    // Two concurrent recv+claim calls
    const [batch1, batch2] = await Promise.all([
      recvMessages({ contextDir, memberId: "alice", claim: true, max: 5 }),
      recvMessages({ contextDir, memberId: "alice", claim: true, max: 5 }),
    ]);

    // Together they should have claimed all 5, with no duplicates
    const allIds = [
      ...batch1.map((m) => m.messageId),
      ...batch2.map((m) => m.messageId),
    ];
    const uniqueIds = new Set(allIds);
    // Due to race conditions, some might be skipped (rename fails),
    // but there should be NO duplicates
    expect(uniqueIds.size).toBe(allIds.length);
    // Total claimed should be <= 5
    expect(allIds.length).toBeLessThanOrEqual(5);
  });
});

describe("contended task claim", () => {
  it("exactly one claimant wins when N compete", async () => {
    const { taskId } = await addTask({
      contextDir,
      title: "Contested Task",
      description: "Only one can claim me",
    });

    const claimers = ["lead", "alice", "bob", "carol", "dave"];

    // Fire all claims in parallel
    const results = await Promise.all(
      claimers.map((memberId) => claimTask(contextDir, taskId, memberId)),
    );

    // Exactly one should succeed
    const winners = results.filter((r) => r.ok);
    expect(winners.length).toBe(1);

    // The rest should fail
    const losers = results.filter((r) => !r.ok);
    expect(losers.length).toBe(claimers.length - 1);

    // Task should be in in_progress/
    const ipEntries = await readdir(tasksStatusDir(contextDir, "in_progress"));
    expect(ipEntries).toContain(`${taskId}.json`);

    // Verify the winner is recorded
    const raw = await readFile(
      path.join(tasksStatusDir(contextDir, "in_progress"), `${taskId}.json`),
      "utf-8",
    );
    const task = JSON.parse(raw);
    expect(claimers).toContain(task.claimed_by);
  });

  it("parallel claim of different tasks all succeed", async () => {
    const taskIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { taskId } = await addTask({
        contextDir,
        title: `Task ${i}`,
        description: "",
      });
      taskIds.push(taskId);
    }

    // Each claimer claims a different task
    const claimers = ["lead", "alice", "bob", "carol", "dave"];
    const results = await Promise.all(
      taskIds.map((tid, i) => claimTask(contextDir, tid, claimers[i]!)),
    );

    // All should succeed (no contention)
    for (const r of results) {
      expect(r.ok).toBe(true);
    }

    // All tasks should be in in_progress/
    const ipEntries = await readdir(tasksStatusDir(contextDir, "in_progress"));
    for (const tid of taskIds) {
      expect(ipEntries).toContain(`${tid}.json`);
    }
  });
});
