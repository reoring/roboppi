import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readWorkflowStatus,
  syncWorkflowStatusToCurrentState,
  writeWorkflowStatus,
  clearWorkflowStatus,
} from "../../../src/agents/status-store.js";
import { writeTaskTemplates } from "../../../src/agents/task-store.js";

let contextDir: string;

beforeEach(async () => {
  contextDir = await mkdtemp(path.join(tmpdir(), "status-store-"));
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

  it("materializes derived workflow status from task templates even when no status file exists", async () => {
    const currentStatePath = path.join(contextDir, "current-state.json");
    await writeFile(
      currentStatePath,
      JSON.stringify({ phase: "awaiting-manual-verification", phase_reason: "fresh bootstrap required" }, null, 2),
    );
    await writeTaskTemplates(contextDir, [
      {
        template_id: "prove-main",
        title: "Proof",
        description: "desc",
        assigned_to: "developer",
        depends_on_template_ids: [],
        phase_guard: {
          source_kind: "current_state_phase_v1",
          source_path: "current-state.json",
          allowed_phases: ["awaiting-manual-verification", "ready-for-next-e2e"],
        },
        tags: [],
        requires_plan_approval: false,
      },
    ]);

    const status = await syncWorkflowStatusToCurrentState(contextDir, "lead");
    expect(status?.summary).toBe(
      "Current phase: awaiting-manual-verification. Developer-owned manual verification is the next gate for cluster-backed work.",
    );
    expect(status?.blockers).toEqual(["fresh bootstrap required"]);
    expect(status?.source?.kind).toBe("current_state_phase_v1");
  });

  it("derives actionable startup guidance from initializing current-state", async () => {
    const currentStatePath = path.join(contextDir, "current-state.json");
    await writeFile(
      currentStatePath,
      JSON.stringify({ phase: "initializing" }, null, 2),
    );
    await writeTaskTemplates(contextDir, [
      {
        template_id: "implement-main",
        title: "Implement",
        description: "desc",
        assigned_to: "developer",
        depends_on_template_ids: [],
        phase_guard: {
          source_kind: "current_state_phase_v1",
          source_path: "current-state.json",
          allowed_phases: ["initializing", "awaiting-remediation"],
        },
        tags: [],
        requires_plan_approval: false,
      },
    ]);

    const status = await syncWorkflowStatusToCurrentState(contextDir, "lead");
    expect(status?.summary).toBe(
      "Current phase: initializing. Developer must replace startup stubs with canonical state before repo-side work continues.",
    );
    expect(status?.blockers).toEqual(["Developer-owned canonical startup sync is still pending."]);
    expect(status?.next_actions).toEqual([
      "Use developer_sync_bundle or state_promote_attempt to replace startup stubs in current-state.json, todo.md, memory.md, and issues/index.md.",
      "Record the active blocker or first repo-side slice, then republish workflow status from canonical current-state.",
    ]);
    expect(status?.source?.kind).toBe("current_state_phase_v1");
  });

  it("derives post-startup guidance from initializing current-state once startup sync is complete", async () => {
    const currentStatePath = path.join(contextDir, "current-state.json");
    await writeFile(
      currentStatePath,
      JSON.stringify({
        phase: "initializing",
        state_version: 1,
        phase_reason: "Startup sync is complete; define the first repo-side slice.",
      }, null, 2),
    );
    await writeTaskTemplates(contextDir, [
      {
        template_id: "implement-main",
        title: "Implement",
        description: "desc",
        assigned_to: "developer",
        depends_on_template_ids: [],
        phase_guard: {
          source_kind: "current_state_phase_v1",
          source_path: "current-state.json",
          allowed_phases: ["initializing", "awaiting-remediation"],
        },
        tags: [],
        requires_plan_approval: false,
      },
    ]);

    const status = await syncWorkflowStatusToCurrentState(contextDir, "lead");
    expect(status?.summary).toBe(
      "Current phase: initializing. Startup sync is complete; define the first repo-side slice and canonical issue before broader work continues.",
    );
    expect(status?.blockers).toEqual(["Startup sync is complete; define the first repo-side slice."]);
    expect(status?.next_actions).toEqual([
      "Read request.md and apthctl-plan.md to define the first concrete repo-side slice.",
      "Read ARCHITECTURE.md and AGENTS.md, then establish the canonical issue and workspace fingerprint for that slice.",
      "Refresh canonical current-state and workflow status after the first repo-side slice is named.",
    ]);
    expect(status?.source?.kind).toBe("current_state_phase_v1");
  });
});
