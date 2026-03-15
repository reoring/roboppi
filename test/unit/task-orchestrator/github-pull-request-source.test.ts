import { describe, expect, it } from "bun:test";

import { GitHubPullRequestSource } from "../../../src/task-orchestrator/index.js";

describe("GitHubPullRequestSource", () => {
  it("lists open pull requests via gh api", async () => {
    const calls: string[][] = [];
    const source = new GitHubPullRequestSource(
      "github-prs",
      {
        type: "github_pull_request",
        repo: "owner/repo",
      },
      async (args) => {
        calls.push(args);
        return JSON.stringify([
          [
            {
              number: 14,
              html_url: "https://github.com/owner/repo/pull/14",
              updated_at: "2026-03-05T00:00:00Z",
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
        "repos/owner/repo/pulls?state=open&per_page=100",
      ],
    ]);
    expect(candidates).toEqual([
      {
        source_id: "github-prs",
        external_id: "owner/repo#14",
        revision: "2026-03-05T00:00:00Z",
        url: "https://github.com/owner/repo/pull/14",
      },
    ]);
  });

  it("fetches a full pull request and normalizes it into a review task", async () => {
    const source = new GitHubPullRequestSource(
      "github-prs",
      {
        type: "github_pull_request",
        repo: "owner/repo",
        base_branches: ["main"],
        local_path: "/tmp/repo",
      },
      async (args) => {
        expect(args).toEqual(["repos/owner/repo/pulls/14"]);
        return JSON.stringify({
          number: 14,
          html_url: "https://github.com/owner/repo/pull/14",
          title: "Add live PR flow",
          body: "Implements a PR workflow.",
          labels: [{ name: "roboppi-review" }, { name: "priority:high" }],
          user: { login: "octocat" },
          assignees: [{ login: "robot" }],
          milestone: { title: "v0.3" },
          comments: 2,
          author_association: "MEMBER",
          created_at: "2026-03-01T00:00:00Z",
          updated_at: "2026-03-06T12:34:56Z",
          state: "open",
          draft: false,
          mergeable: true,
          mergeable_state: "clean",
          head: {
            ref: "roboppi/live-pr",
            sha: "abc123",
          },
          base: {
            ref: "main",
          },
        });
      },
    );

    const envelope = await source.fetchEnvelope({
      source_id: "github-prs",
      external_id: "owner/repo#14",
      revision: "2026-03-06T12:34:56Z",
      url: "https://github.com/owner/repo/pull/14",
    });

    expect(envelope).toEqual({
      version: "1",
      task_id: "github:pull_request:owner/repo#14",
      source: {
        kind: "github_pull_request",
        system_id: "github",
        external_id: "owner/repo#14",
        url: "https://github.com/owner/repo/pull/14",
        revision: expect.any(String),
      },
      title: "Add live PR flow",
      body: "Implements a PR workflow.",
      labels: ["roboppi-review", "priority:high"],
      priority: "high",
      repository: {
        id: "owner/repo",
        local_path: "/tmp/repo",
        default_branch: "main",
      },
      requested_action: "review",
      requested_by: "octocat",
      metadata: {
        source_id: "github-prs",
        state: "open",
        draft: false,
        base_ref: "main",
        head_ref: "roboppi/live-pr",
        head_sha: "abc123",
        mergeable: true,
        mergeable_state: "clean",
        assignees: ["robot"],
        milestone: "v0.3",
        comments: 2,
        author_association: "MEMBER",
      },
      timestamps: {
        created_at: Date.parse("2026-03-01T00:00:00Z"),
        updated_at: Date.parse("2026-03-06T12:34:56Z"),
      },
    });
    expect(envelope.source.revision).toHaveLength(64);
  });

  it("acks by posting a machine-readable comment through gh api", async () => {
    const calls: string[][] = [];
    const source = new GitHubPullRequestSource(
      "github-prs",
      {
        type: "github_pull_request",
        repo: "owner/repo",
      },
      async (args) => {
        calls.push(args);
        return JSON.stringify({ id: 12345 });
      },
    );

    await source.ack({
      task_id: "github:pull_request:owner/repo#14",
      run_id: "run-review",
      state: "landed",
      note: "merged after review",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 4)).toEqual([
      "-X",
      "POST",
      "repos/owner/repo/issues/14/comments",
      "-f",
    ]);
    expect(calls[0]?.[4]).toContain("state=landed");
    expect(calls[0]?.[4]).toContain("pull request changes have been landed");
  });
});
