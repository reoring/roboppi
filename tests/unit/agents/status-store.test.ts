import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  readWorkflowStatus,
  writeWorkflowStatus,
  clearWorkflowStatus,
} from "../../../src/agents/status-store.js";

const TEST_TMP_ROOT = path.join(process.cwd(), ".roboppi-loop", "tmp", "unit-status-store");

let contextDir: string;

beforeEach(async () => {
  await mkdir(TEST_TMP_ROOT, { recursive: true });
  contextDir = await mkdtemp(path.join(TEST_TMP_ROOT, "status-store-"));
});

afterEach(async () => {
  await rm(contextDir, { recursive: true, force: true });
});

describe("workflow status store", () => {
  it("writes and reads workflow status summary", async () => {
    const written = await writeWorkflowStatus({
      contextDir,
      ownerMemberId: "planner",
      summary: "Implementer is fixing the current blocker.",
      blockers: ["kind bootstrap fails"],
      nextActions: ["rerun fast gates", "refresh issue index"],
    });

    const read = await readWorkflowStatus(contextDir);

    expect(read).toBeTruthy();
    expect(read?.version).toBe("1");
    expect(read?.owner_member_id).toBe("planner");
    expect(read?.summary).toBe("Implementer is fixing the current blocker.");
    expect(read?.blockers).toEqual(["kind bootstrap fails"]);
    expect(read?.next_actions).toEqual(["rerun fast gates", "refresh issue index"]);
    expect(read?.updated_at).toBe(written.updated_at);
  });

  it("clears workflow status summary", async () => {
    await writeWorkflowStatus({
      contextDir,
      ownerMemberId: "planner",
      summary: "Temporary summary",
    });

    await clearWorkflowStatus(contextDir);

    expect(await readWorkflowStatus(contextDir)).toBeNull();
  });
});
