import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  activityLogPath,
  emitTaskActivity,
  readLatestTaskActivity,
  readTaskActivityEvents,
} from "../../../src/task-orchestrator/index.js";

describe("task activity log", () => {
  let contextDir: string;

  beforeEach(async () => {
    contextDir = await mkdtemp(path.join(tmpdir(), "roboppi-task-activity-"));
    await mkdir(path.join(contextDir, "_task"), { recursive: true });
    await writeFile(
      path.join(contextDir, "_task", "run.json"),
      JSON.stringify({
        version: "1",
        task_id: "github:issue:owner/repo#1",
        run_id: "run-1",
      }),
    );
  });

  afterEach(async () => {
    await rm(contextDir, { recursive: true, force: true });
  });

  it("emits and reads activity events", async () => {
    const first = await emitTaskActivity({
      contextDir,
      kind: "progress",
      message: "Started implementation",
      phase: "implement",
      memberId: "lead",
      ts: 1000,
    });
    const second = await emitTaskActivity({
      contextDir,
      kind: "push_completed",
      message: "Pushed branch updates",
      metadata: { branch: "roboppi/issue/1" },
      ts: 2000,
    });

    expect(activityLogPath(contextDir)).toBe(
      path.join(contextDir, "_task", "activity.jsonl"),
    );
    expect(first.task_id).toBe("github:issue:owner/repo#1");
    expect(second.run_id).toBe("run-1");

    const events = await readTaskActivityEvents(contextDir);
    expect(events).toHaveLength(2);
    expect(events[0]?.message).toBe("Started implementation");
    expect(events[1]?.kind).toBe("push_completed");

    const latest = await readLatestTaskActivity(contextDir);
    expect(latest).toMatchObject({
      kind: "push_completed",
      message: "Pushed branch updates",
      metadata: {
        branch: "roboppi/issue/1",
      },
    });
  });
});
