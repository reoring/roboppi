import { describe, expect, it } from "bun:test";

import { GitHubIssueSource } from "../../../src/task-orchestrator/index.js";

describe("GitHubIssueSource", () => {
  it("lists issue candidates via gh api and filters out pull requests", async () => {
    const calls: string[][] = [];
    const source = new GitHubIssueSource(
      "github-main",
      {
        type: "github_issue",
        repo: "owner/repo",
        labels: ["bug", "roboppi"],
      },
      async (args) => {
        calls.push(args);
        return JSON.stringify([
          [
            {
              number: 12,
              html_url: "https://github.com/owner/repo/issues/12",
              created_at: "2026-03-01T00:00:00Z",
              updated_at: "2026-03-02T00:00:00Z",
              title: "Fix scheduler test",
            },
            {
              number: 13,
              html_url: "https://github.com/owner/repo/pull/13",
              created_at: "2026-03-01T00:00:00Z",
              updated_at: "2026-03-02T00:00:00Z",
              title: "PR should be filtered",
              pull_request: {},
            },
          ],
        ]);
      },
    );

    const candidates = await source.listCandidates();

    expect(calls).toEqual([
      [
        "--paginate",
        "--slurp",
        "repos/owner/repo/issues?state=open&per_page=100&labels=bug%2Croboppi",
      ],
    ]);
    expect(candidates).toEqual([
      {
        source_id: "github-main",
        external_id: "owner/repo#12",
        revision: "2026-03-02T00:00:00Z",
        url: "https://github.com/owner/repo/issues/12",
      },
    ]);
  });

  it("fetches a full issue and normalizes it into a TaskEnvelope", async () => {
    const calls: string[][] = [];
    const source = new GitHubIssueSource(
      "github-main",
      {
        type: "github_issue",
        repo: "owner/repo",
      },
      async (args) => {
        calls.push(args);
        if (args[0] === "repos/owner/repo/issues/12") {
          return JSON.stringify({
            number: 12,
            html_url: "https://github.com/owner/repo/issues/12",
            title: "Fix scheduler test",
            body: "The restart test is flaky.",
            labels: [{ name: "bug" }, { name: "priority:high" }],
            user: { login: "octocat" },
            assignees: [{ login: "robot" }],
            milestone: { title: "v0.2" },
            comments: 3,
            author_association: "MEMBER",
            created_at: "2026-03-01T00:00:00Z",
            updated_at: "2026-03-02T12:34:56Z",
            state: "open",
          });
        }
        expect(args).toEqual(["repos/owner/repo/issues/12/comments?per_page=100"]);
        return JSON.stringify([
          {
            id: 3001,
            body: "I can reproduce this on CI.",
            updated_at: "2026-03-03T00:00:00Z",
            user: { login: "octocat" },
          },
        ]);
      },
    );

    const envelope = await source.fetchEnvelope({
      source_id: "github-main",
      external_id: "owner/repo#12",
      revision: "2026-03-02T12:34:56Z",
      url: "https://github.com/owner/repo/issues/12",
    });

    const revision = envelope.source.revision;
    expect(envelope).toMatchObject({
      version: "1",
      task_id: "github:issue:owner/repo#12",
      source: {
        kind: "github_issue",
        system_id: "github",
        external_id: "owner/repo#12",
        url: "https://github.com/owner/repo/issues/12",
      },
      title: "Fix scheduler test",
      body: "The restart test is flaky.",
      labels: ["bug", "priority:high"],
      priority: "high",
      repository: {
        id: "owner/repo",
      },
      requested_action: "implement",
      requested_by: "octocat",
      metadata: {
        source_id: "github-main",
        state: "open",
        assignees: ["robot"],
        milestone: "v0.2",
        comments: 3,
        last_human_comment_id: 3001,
        last_human_comment_at: "2026-03-03T00:00:00Z",
        author_association: "MEMBER",
      },
      timestamps: {
        created_at: Date.parse("2026-03-01T00:00:00Z"),
        updated_at: Date.parse("2026-03-02T12:34:56Z"),
      },
    });
    expect(typeof revision).toBe("string");
    expect(revision?.length).toBe(64);
    expect(calls).toEqual([
      ["repos/owner/repo/issues/12"],
      ["repos/owner/repo/issues/12/comments?per_page=100"],
    ]);
  });

  it("derives a stable revision from issue content rather than updated_at", async () => {
    const payload = {
      number: 12,
      html_url: "https://github.com/owner/repo/issues/12",
      title: "Fix scheduler test",
      body: "The restart test is flaky.",
      labels: [{ name: "bug" }, { name: "priority:high" }],
      user: { login: "octocat" },
      assignees: [{ login: "robot" }],
      milestone: { title: "v0.2" },
      comments: 3,
      author_association: "MEMBER",
      created_at: "2026-03-01T00:00:00Z",
      state: "open",
    };

    const source = new GitHubIssueSource(
      "github-main",
      {
        type: "github_issue",
        repo: "owner/repo",
      },
      async (args) => {
        if (args[0] === "repos/owner/repo/issues/12/comments?per_page=100") {
          return JSON.stringify([]);
        }
        return JSON.stringify({
          ...payload,
          updated_at: "2026-03-02T12:34:56Z",
        });
      },
    );

    const sourceLaterUpdate = new GitHubIssueSource(
      "github-main",
      {
        type: "github_issue",
        repo: "owner/repo",
      },
      async (args) => {
        if (args[0] === "repos/owner/repo/issues/12/comments?per_page=100") {
          return JSON.stringify([]);
        }
        return JSON.stringify({
          ...payload,
          updated_at: "2026-03-04T12:34:56Z",
        });
      },
    );

    const envelopeA = await source.fetchEnvelope({
      source_id: "github-main",
      external_id: "owner/repo#12",
      revision: "2026-03-02T12:34:56Z",
      url: "https://github.com/owner/repo/issues/12",
    });
    const envelopeB = await sourceLaterUpdate.fetchEnvelope({
      source_id: "github-main",
      external_id: "owner/repo#12",
      revision: "2026-03-04T12:34:56Z",
      url: "https://github.com/owner/repo/issues/12",
    });

    expect(envelopeA.source.revision).toBe(envelopeB.source.revision);
  });

  it("changes the revision when a new human comment appears but ignores Roboppi comments", async () => {
    const payload = {
      number: 12,
      html_url: "https://github.com/owner/repo/issues/12",
      title: "Fix scheduler test",
      body: "The restart test is flaky.",
      labels: [{ name: "bug" }],
      user: { login: "octocat" },
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-02T12:34:56Z",
      state: "open",
    };

    const baseComments = [
      {
        id: 1,
        body: "<!-- roboppi:issue-status task_id=github:issue:owner/repo#12 run_id=run-1 -->\nstatus",
        updated_at: "2026-03-03T00:00:00Z",
        user: { login: "reoring" },
      },
    ];

    const sourceA = new GitHubIssueSource(
      "github-main",
      {
        type: "github_issue",
        repo: "owner/repo",
      },
      async (args) => {
        if (args[0] === "repos/owner/repo/issues/12/comments?per_page=100") {
          return JSON.stringify(baseComments);
        }
        return JSON.stringify(payload);
      },
    );

    const sourceB = new GitHubIssueSource(
      "github-main",
      {
        type: "github_issue",
        repo: "owner/repo",
      },
      async (args) => {
        if (args[0] === "repos/owner/repo/issues/12/comments?per_page=100") {
          return JSON.stringify([
            ...baseComments,
            {
              id: 2,
              body: "Expected behavior is to add one line to README.",
              updated_at: "2026-03-04T00:00:00Z",
              user: { login: "octocat" },
            },
          ]);
        }
        return JSON.stringify(payload);
      },
    );

    const envelopeA = await sourceA.fetchEnvelope({
      source_id: "github-main",
      external_id: "owner/repo#12",
      revision: payload.updated_at,
      url: payload.html_url,
    });
    const envelopeB = await sourceB.fetchEnvelope({
      source_id: "github-main",
      external_id: "owner/repo#12",
      revision: payload.updated_at,
      url: payload.html_url,
    });

    expect(envelopeA.source.revision).not.toBe(envelopeB.source.revision);
    expect(envelopeA.metadata?.last_human_comment_id).toBeUndefined();
    expect(envelopeB.metadata?.last_human_comment_id).toBe(2);
  });

  it("rejects external ids that do not match the configured repo", async () => {
    const source = new GitHubIssueSource(
      "github-main",
      {
        type: "github_issue",
        repo: "owner/repo",
      },
      async () => {
        throw new Error("should not be called");
      },
    );

    await expect(
      source.fetchEnvelope({
        source_id: "github-main",
        external_id: "other/repo#12",
      }),
    ).rejects.toThrow(/does not match configured repo/);
  });

  it("acks by posting a machine-readable comment through gh api", async () => {
    const calls: string[][] = [];
    const source = new GitHubIssueSource(
      "github-main",
      {
        type: "github_issue",
        repo: "owner/repo",
      },
      async (args) => {
        calls.push(args);
        return JSON.stringify({
          id: 12345,
          html_url: "https://github.com/owner/repo/issues/12#issuecomment-12345",
        });
      },
    );

    await source.ack({
      task_id: "github:issue:owner/repo#12",
      run_id: "run-1",
      state: "review_required",
      note: "review artifacts uploaded",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 4)).toEqual([
      "-X",
      "POST",
      "repos/owner/repo/issues/12/comments",
      "-f",
    ]);
    expect(calls[0]?.[4]).toContain("body=<!-- roboppi:task-ack task_id=github:issue:owner/repo#12 run_id=run-1 state=review_required -->");
    expect(calls[0]?.[4]).toContain("Roboppi task update: implementation completed and is waiting for human review");
    expect(calls[0]?.[4]).toContain("- Note: review artifacts uploaded");
  });
});
