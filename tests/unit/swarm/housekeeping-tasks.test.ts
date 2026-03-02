/**
 * Swarm task housekeeping unit tests (Spec 3.3).
 *
 * Covers:
 * - stale `tasks/in_progress/` detection via TTL
 * - requeue to `tasks/pending/` with metadata update
 * - `task_requeued` event emission
 * - idempotency and concurrent housekeeping safety
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initSwarmContext } from "../../../src/swarm/store.js";
import { addTask, claimTask } from "../../../src/swarm/task-store.js";
import { housekeepTasksInProgress } from "../../../src/swarm/housekeeping.js";
import { tasksStatusDir, tasksEventsPath } from "../../../src/swarm/paths.js";

let contextDir: string;

beforeEach(async () => {
  contextDir = await mkdtemp(path.join(tmpdir(), "swarm-task-hk-"));
  await initSwarmContext({
    contextDir,
    teamName: "test-team",
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

describe("housekeepTasksInProgress (Spec 3.3)", () => {
  it("does nothing when no tasks are stale", async () => {
    // Create and claim a task (it's fresh, not stale)
    const { taskId } = await addTask({ contextDir, title: "Fresh", description: "" });
    await claimTask(contextDir, taskId, "alice");

    const result = await housekeepTasksInProgress({ contextDir, inProgressTtlMs: 60_000 });
    expect(result.requeued).toBe(0);
    expect(result.warnings).toEqual([]);

    // Task should remain in in_progress/
    const ipEntries = await readdir(tasksStatusDir(contextDir, "in_progress"));
    expect(ipEntries).toContain(`${taskId}.json`);
  });

  it("requeues stale in_progress task to pending with metadata update", async () => {
    const { taskId } = await addTask({ contextDir, title: "Stale Task", description: "" });
    await claimTask(contextDir, taskId, "alice");

    // Make the file appear stale by setting mtime to the past
    const filePath = path.join(tasksStatusDir(contextDir, "in_progress"), `${taskId}.json`);
    const past = new Date(Date.now() - 20 * 60 * 1000); // 20 minutes ago
    await utimes(filePath, past, past);

    // Also update claimed_at to match staleness
    const raw = await readFile(filePath, "utf-8");
    const task = JSON.parse(raw);
    task.claimed_at = Date.now() - 20 * 60 * 1000;
    await writeFile(filePath, JSON.stringify(task, null, 2));
    await utimes(filePath, past, past);

    const result = await housekeepTasksInProgress({ contextDir, inProgressTtlMs: 10 * 60 * 1000 });
    expect(result.requeued).toBe(1);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain(taskId);

    // Task should be back in pending/
    const pendingEntries = await readdir(tasksStatusDir(contextDir, "pending"));
    expect(pendingEntries).toContain(`${taskId}.json`);

    // in_progress/ should be empty
    const ipEntries = await readdir(tasksStatusDir(contextDir, "in_progress"));
    expect(ipEntries).not.toContain(`${taskId}.json`);

    // Verify metadata was updated
    const requeued = JSON.parse(
      await readFile(
        path.join(tasksStatusDir(contextDir, "pending"), `${taskId}.json`),
        "utf-8",
      ),
    );
    expect(requeued.status).toBe("pending");
    expect(requeued.claimed_by).toBeNull();
    expect(requeued.claimed_at).toBeNull();
    expect(requeued.updated_at).toBeGreaterThan(0);
  });

  it("emits task_requeued event on requeue", async () => {
    const { taskId } = await addTask({ contextDir, title: "Event Task", description: "" });
    await claimTask(contextDir, taskId, "alice");

    // Make stale
    const filePath = path.join(tasksStatusDir(contextDir, "in_progress"), `${taskId}.json`);
    const past = new Date(Date.now() - 20 * 60 * 1000);
    await utimes(filePath, past, past);
    const raw = await readFile(filePath, "utf-8");
    const task = JSON.parse(raw);
    task.claimed_at = Date.now() - 20 * 60 * 1000;
    await writeFile(filePath, JSON.stringify(task, null, 2));
    await utimes(filePath, past, past);

    await housekeepTasksInProgress({ contextDir, inProgressTtlMs: 10 * 60 * 1000 });

    // Check events
    const eventsRaw = await readFile(tasksEventsPath(contextDir), "utf-8");
    const events = eventsRaw.trim().split("\n").map((l) => JSON.parse(l));
    const requeuedEvents = events.filter((e: any) => e.type === "task_requeued");
    expect(requeuedEvents.length).toBe(1);
    expect(requeuedEvents[0].task_id).toBe(taskId);
    expect(requeuedEvents[0].by).toBe("alice");
  });

  it("is idempotent — second run requeues nothing", async () => {
    const { taskId } = await addTask({ contextDir, title: "Idempotent", description: "" });
    await claimTask(contextDir, taskId, "alice");

    // Make stale
    const filePath = path.join(tasksStatusDir(contextDir, "in_progress"), `${taskId}.json`);
    const past = new Date(Date.now() - 20 * 60 * 1000);
    await utimes(filePath, past, past);
    const raw = await readFile(filePath, "utf-8");
    const task = JSON.parse(raw);
    task.claimed_at = Date.now() - 20 * 60 * 1000;
    await writeFile(filePath, JSON.stringify(task, null, 2));
    await utimes(filePath, past, past);

    // First run
    const r1 = await housekeepTasksInProgress({ contextDir, inProgressTtlMs: 10 * 60 * 1000 });
    expect(r1.requeued).toBe(1);

    // Second run — nothing left to requeue
    const r2 = await housekeepTasksInProgress({ contextDir, inProgressTtlMs: 10 * 60 * 1000 });
    expect(r2.requeued).toBe(0);
  });

  it("handles concurrent housekeeping safely (one wins the rename)", async () => {
    const { taskId } = await addTask({ contextDir, title: "Race", description: "" });
    await claimTask(contextDir, taskId, "alice");

    // Make stale
    const filePath = path.join(tasksStatusDir(contextDir, "in_progress"), `${taskId}.json`);
    const past = new Date(Date.now() - 20 * 60 * 1000);
    await utimes(filePath, past, past);
    const raw = await readFile(filePath, "utf-8");
    const task = JSON.parse(raw);
    task.claimed_at = Date.now() - 20 * 60 * 1000;
    await writeFile(filePath, JSON.stringify(task, null, 2));
    await utimes(filePath, past, past);

    // Run two concurrent housekeep operations
    const [r1, r2] = await Promise.all([
      housekeepTasksInProgress({ contextDir, inProgressTtlMs: 10 * 60 * 1000 }),
      housekeepTasksInProgress({ contextDir, inProgressTtlMs: 10 * 60 * 1000 }),
    ]);

    // Exactly one should succeed
    expect(r1.requeued + r2.requeued).toBe(1);

    // Task should be in pending/ regardless
    const pendingEntries = await readdir(tasksStatusDir(contextDir, "pending"));
    expect(pendingEntries).toContain(`${taskId}.json`);
  });
});
