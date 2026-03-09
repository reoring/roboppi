import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { addTask, claimTask, completeTask, listTasks } from "../../../src/agents/task-store.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeContextDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "roboppi-task-store-"));
  tmpDirs.push(dir);
  return dir;
}

describe("task-store claim ownership", () => {
  test("denies non-assignee claims and preserves the task for the assignee", async () => {
    const contextDir = await makeContextDir();
    const { taskId } = await addTask({
      contextDir,
      title: "manual verification",
      description: "run manual verification",
      assignedTo: "manual_verifier",
    });

    const denied = await claimTask(contextDir, taskId, "lead");
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('assigned to "manual_verifier"');

    const pending = await listTasks(contextDir, "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.task_id).toBe(taskId);
    expect(pending[0]?.claimed_by).toBeNull();

    const claimed = await claimTask(contextDir, taskId, "manual_verifier");
    expect(claimed.ok).toBe(true);

    const inProgress = await listTasks(contextDir, "in_progress");
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0]?.task_id).toBe(taskId);
    expect(inProgress[0]?.claimed_by).toBe("manual_verifier");
  });

  test("allows unassigned tasks to be claimed by any member", async () => {
    const contextDir = await makeContextDir();
    const { taskId } = await addTask({
      contextDir,
      title: "general work",
      description: "do shared work",
    });

    const claimed = await claimTask(contextDir, taskId, "lead");
    expect(claimed.ok).toBe(true);

    const inProgress = await listTasks(contextDir, "in_progress");
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0]?.task_id).toBe(taskId);
    expect(inProgress[0]?.claimed_by).toBe("lead");
  });

  test("denies completion by a member that did not claim the task", async () => {
    const contextDir = await makeContextDir();
    const { taskId } = await addTask({
      contextDir,
      title: "manual verification",
      description: "run manual verification",
      assignedTo: "manual_verifier",
    });

    expect((await claimTask(contextDir, taskId, "manual_verifier")).ok).toBe(true);

    const denied = await completeTask(contextDir, taskId, "lead");
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('claimed by "manual_verifier"');

    const inProgress = await listTasks(contextDir, "in_progress");
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0]?.task_id).toBe(taskId);
    expect(inProgress[0]?.claimed_by).toBe("manual_verifier");
  });
});
