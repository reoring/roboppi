import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileInboxSource } from "../../../src/task-orchestrator/index.js";

describe("FileInboxSource", () => {
  let baseDir: string;
  let inboxDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), "roboppi-file-inbox-"));
    inboxDir = path.join(baseDir, "inbox");
    await mkdir(path.join(inboxDir, "nested"), { recursive: true });
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("lists candidates using the configured glob pattern", async () => {
    await writeFile(
      path.join(inboxDir, "task-a.json"),
      JSON.stringify({ title: "Task A" }),
    );
    await writeFile(
      path.join(inboxDir, "nested", "task-b.json"),
      JSON.stringify({ title: "Task B" }),
    );
    await writeFile(
      path.join(inboxDir, "notes.txt"),
      "not a task",
    );

    const source = new FileInboxSource(
      "inbox",
      { type: "file_inbox", path: "./inbox", pattern: "**/*.json" },
      baseDir,
    );
    const candidates = await source.listCandidates();

    expect(candidates.map((candidate) => candidate.external_id)).toEqual([
      "nested/task-b.json",
      "task-a.json",
    ]);
    expect(candidates.every((candidate) => candidate.revision)).toBe(true);
  });

  it("normalizes a JSON task document into a TaskEnvelope", async () => {
    await writeFile(
      path.join(inboxDir, "nested", "task-b.json"),
      JSON.stringify({
        title: "Investigate flaky test",
        body: "The scheduler restart test is flaky.",
        labels: ["bug", "ci-flake"],
        priority: "high",
        repository: {
          id: "owner/repo",
          default_branch: "main",
          local_path: "../repo",
        },
        requested_action: "implement",
        requested_by: "octocat",
        metadata: {
          milestone: "v0.2",
        },
        timestamps: {
          created_at: 1000,
          updated_at: 2000,
        },
      }),
    );

    const source = new FileInboxSource(
      "inbox",
      { type: "file_inbox", path: "./inbox", pattern: "**/*.json" },
      baseDir,
    );
    const [candidate] = await source.listCandidates();
    const envelope = await source.fetchEnvelope(candidate!);

    expect(envelope).toEqual({
      version: "1",
      task_id: "file_inbox:inbox:nested/task-b.json",
      source: {
        kind: "file_inbox",
        system_id: "file_inbox",
        external_id: "nested/task-b.json",
        url: candidate!.url,
        revision: candidate!.revision,
      },
      title: "Investigate flaky test",
      body: "The scheduler restart test is flaky.",
      labels: ["bug", "ci-flake"],
      priority: "high",
      repository: {
        id: "owner/repo",
        default_branch: "main",
        local_path: path.resolve(inboxDir, "nested", "../repo"),
      },
      requested_action: "implement",
      requested_by: "octocat",
      metadata: {
        milestone: "v0.2",
      },
      timestamps: {
        created_at: 1000,
        updated_at: 2000,
      },
    });
  });

  it("writes ack files under .roboppi-acks", async () => {
    await writeFile(
      path.join(inboxDir, "task-a.json"),
      JSON.stringify({ title: "Task A" }),
    );

    const source = new FileInboxSource(
      "inbox",
      { type: "file_inbox", path: "./inbox" },
      baseDir,
    );
    await source.ack?.({
      task_id: "file_inbox:inbox:task-a.json",
      run_id: "run-1",
      state: "review_required",
      note: "awaiting human review",
    });

    const ack = JSON.parse(
      await readFile(
        path.join(inboxDir, ".roboppi-acks", "task-a.json.ack.json"),
        "utf-8",
      ),
    );
    expect(ack).toMatchObject({
      task_id: "file_inbox:inbox:task-a.json",
      run_id: "run-1",
      state: "review_required",
      note: "awaiting human review",
    });
    expect(typeof ack.acknowledged_at).toBe("number");
  });
});
