import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  emitTaskActivity,
  emitTaskIntent,
  readTaskIntentRecords,
  TaskIntentAuthorizationError,
} from "../../../src/task-orchestrator/index.js";

let tempDir: string;
let contextDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "roboppi-intent-log-test-"));
  contextDir = path.join(tempDir, "context");
  await mkdir(path.join(contextDir, "_task"), { recursive: true });
  await writeFile(
    path.join(contextDir, "_task", "run.json"),
    JSON.stringify(
      {
        version: "1",
        task_id: "github:pull_request:owner/repo#45",
        run_id: "run-123",
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(contextDir, "_task", "task-policy.json"),
    JSON.stringify(
      {
        version: "1",
        members: {
          lead: { roles: ["lead", "publisher"] },
          reviewer: { roles: ["reviewer"] },
          reporter: { roles: ["publisher"] },
        },
        intents: {
          activity: {
            allowed_members: ["reporter"],
            allowed_roles: ["publisher"],
          },
          pr_open_request: {
            allowed_members: ["lead"],
            allowed_roles: ["lead"],
          },
          review_verdict: {
            allowed_members: ["reviewer", "lead"],
            allowed_roles: ["reviewer", "lead"],
          },
          landing_decision: {
            allowed_members: ["lead"],
            allowed_roles: ["lead"],
          },
          clarification_request: {
            allowed_members: ["lead"],
            allowed_roles: ["lead"],
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("task intent log", () => {
  it("records and materializes an authorized review_verdict intent", async () => {
    const record = await emitTaskIntent({
      contextDir,
      kind: "review_verdict",
      memberId: "reviewer",
      payload: {
        decision: "approve",
        rationale: "Reviewed and found no blocking issues",
      },
      ts: 1234,
    });

    expect(record.accepted).toBe(true);
    expect(record.member_roles).toEqual(["reviewer"]);

    const records = await readTaskIntentRecords(contextDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "review_verdict",
      member_id: "reviewer",
      accepted: true,
    });

    const materialized = JSON.parse(
      await readFile(path.join(contextDir, "_task", "review-verdict.json"), "utf-8"),
    );
    expect(materialized).toEqual({
      version: "1",
      decision: "approve",
      rationale: "Reviewed and found no blocking issues",
      member_id: "reviewer",
      ts: 1234,
      source: "intent",
    });
  });

  it("records a rejected intent when the member is not authorized", async () => {
    await expect(
      emitTaskIntent({
        contextDir,
        kind: "landing_decision",
        memberId: "reviewer",
        payload: {
          lifecycle: "landed",
        },
        ts: 5678,
      }),
    ).rejects.toBeInstanceOf(TaskIntentAuthorizationError);

    const records = await readTaskIntentRecords(contextDir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "landing_decision",
      member_id: "reviewer",
      accepted: false,
      rejection_reason:
        'member "reviewer" is not authorized for intent "landing_decision"',
    });
  });

  it("materializes a pr_open_request intent", async () => {
    const record = await emitTaskIntent({
      contextDir,
      kind: "pr_open_request",
      memberId: "lead",
      payload: {
        title: "Fix issue #45: tighten README",
        body: "Implements the requested README tweak.\n\nCloses #45",
        head_ref: "roboppi/issue-45-tighten-readme",
        base_ref: "main",
        labels: ["roboppi-live-e2e-pr"],
      },
      ts: 7777,
    });

    expect(record.accepted).toBe(true);

    const request = JSON.parse(
      await readFile(path.join(contextDir, "_task", "pr-open-request.json"), "utf-8"),
    );
    expect(request).toEqual({
      version: "1",
      title: "Fix issue #45: tighten README",
      body: "Implements the requested README tweak.\n\nCloses #45",
      head_ref: "roboppi/issue-45-tighten-readme",
      base_ref: "main",
      labels: ["roboppi-live-e2e-pr"],
      member_id: "lead",
      ts: 7777,
      source: "intent",
    });
  });

  it("requires an authorized member for activity emission when task policy is configured", async () => {
    await expect(
      emitTaskActivity({
        contextDir,
        kind: "progress",
        message: "Started review work",
        memberId: "reviewer",
      }),
    ).rejects.toThrow(/not authorized for intent "activity"/);

    const event = await emitTaskActivity({
      contextDir,
      kind: "progress",
      message: "Published public progress update",
      memberId: "reporter",
      ts: 9000,
    });

    expect(event.member_id).toBe("reporter");
    expect(event.ts).toBe(9000);
  });

  it("materializes a clarification_request intent and waiting_for_input landing", async () => {
    const record = await emitTaskIntent({
      contextDir,
      kind: "clarification_request",
      memberId: "lead",
      payload: {
        summary: "Need the expected README text before editing docs",
        questions: [
          "What exact sentence should be added to README.md?",
        ],
        missing_fields: ["expected_text"],
        resume_hints: ["Reply on this issue with the desired sentence"],
        severity: "normal",
      },
      ts: 9999,
    });

    expect(record.accepted).toBe(true);

    const clarification = JSON.parse(
      await readFile(path.join(contextDir, "_task", "clarification-request.json"), "utf-8"),
    );
    expect(clarification).toEqual({
      version: "1",
      summary: "Need the expected README text before editing docs",
      questions: ["What exact sentence should be added to README.md?"],
      missing_fields: ["expected_text"],
      resume_hints: ["Reply on this issue with the desired sentence"],
      severity: "normal",
      member_id: "lead",
      ts: 9999,
      source: "intent",
    });

    const landing = JSON.parse(
      await readFile(path.join(contextDir, "_task", "landing.json"), "utf-8"),
    );
    expect(landing).toMatchObject({
      version: "1",
      lifecycle: "waiting_for_input",
      rationale: "Need the expected README text before editing docs",
      metadata: {
        clarification_summary: "Need the expected README text before editing docs",
        clarification_questions: ["What exact sentence should be added to README.md?"],
        clarification_missing_fields: ["expected_text"],
        clarification_resume_hints: ["Reply on this issue with the desired sentence"],
        clarification_severity: "normal",
      },
    });
  });
});
