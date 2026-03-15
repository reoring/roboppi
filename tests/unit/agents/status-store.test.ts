import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("auto-heals derived status when canonical current-state advances", async () => {
    const currentStatePath = path.join(contextDir, "current-state.json");
    await mkdir(path.join(contextDir, "_agents"), { recursive: true });
    await writeFile(
      currentStatePath,
      JSON.stringify({ phase: "ready-for-next-e2e", phase_reason: "proof-ready" }, null, 2),
    );

    const stale = {
      version: "1",
      updated_at: 1,
      owner_member_id: "developer",
      summary: "Current phase: ready-for-next-e2e. The current canonical state authorizes the next authoritative cluster-backed step.",
      blockers: ["proof-ready"],
      next_actions: ["Run the next authoritative cluster-backed verification for the active contract."],
      source: {
        kind: "current_state_phase_v1",
        path: currentStatePath,
        mtime_ms: 1,
      },
    };
    await writeFile(
      path.join(contextDir, "_agents", "workflow-status.json"),
      JSON.stringify(stale, null, 2),
    );

    await writeFile(
      currentStatePath,
      JSON.stringify({ phase: "awaiting-remediation", phase_reason: "label gap" }, null, 2),
    );

    const healed = await readWorkflowStatus(contextDir);
    expect(healed?.summary).toBe(
      "Current phase: awaiting-remediation. The last authoritative spend found a repo-side blocker; remediation must land before another proof spend.",
    );
    expect(healed?.blockers).toEqual(["label gap"]);
    expect(healed?.next_actions).toEqual([
      "Patch the active repo-side blocker, refresh canonical state, and reopen reviewer fast gates before another proof spend.",
    ]);
    expect(healed?.source?.kind).toBe("current_state_phase_v1");
    expect(healed?.source?.path).toBe(currentStatePath);
    expect((healed?.source?.mtime_ms ?? 0)).toBeGreaterThan(1);

    const persisted = JSON.parse(
      await readFile(path.join(contextDir, "_agents", "workflow-status.json"), "utf-8"),
    );
    expect(persisted.summary).toBe(healed?.summary);
    expect(persisted.blockers).toEqual(["label gap"]);
  });
});
