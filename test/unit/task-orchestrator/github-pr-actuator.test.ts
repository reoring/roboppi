import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyGitHubPullRequestOpen,
  applyGitHubPullRequestActuation,
} from "../../../src/task-orchestrator/index.js";

let tempDir: string;
let contextDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "roboppi-gh-pr-actuator-test-"));
  contextDir = path.join(tempDir, "context");
  await mkdir(path.join(contextDir, "_task"), { recursive: true });
  await writeFile(
    path.join(contextDir, "_task", "run.json"),
    JSON.stringify({
      version: "1",
      task_id: "github:pull_request:owner/repo#45",
      run_id: "run-123",
    }, null, 2) + "\n",
  );
  await writeFile(
    path.join(contextDir, "_task", "task.json"),
    JSON.stringify({
      version: "1",
      task_id: "github:pull_request:owner/repo#45",
      source: {
        kind: "github_pull_request",
        system_id: "github",
        external_id: "owner/repo#45",
        url: "https://github.com/owner/repo/pull/45",
      },
      title: "Review PR #45",
      body: "Implements the fix",
      labels: ["review"],
      priority: "normal",
      repository: {
        id: "owner/repo",
        default_branch: "main",
      },
      requested_action: "review",
      requested_by: "octocat",
      timestamps: {
        created_at: 1000,
        updated_at: 2000,
      },
    }, null, 2) + "\n",
  );
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("applyGitHubPullRequestActuation", () => {
  it("creates a pull request from a materialized pr_open_request and marks the issue review_required", async () => {
    const calls: string[][] = [];
    await writeFile(
      path.join(contextDir, "_task", "run.json"),
      JSON.stringify({
        version: "1",
        task_id: "github:issue:owner/repo#45",
        run_id: "run-123",
      }, null, 2) + "\n",
    );
    await writeFile(
      path.join(contextDir, "_task", "task.json"),
      JSON.stringify({
        version: "1",
        task_id: "github:issue:owner/repo#45",
        source: {
          kind: "github_issue",
          system_id: "github",
          external_id: "owner/repo#45",
          url: "https://github.com/owner/repo/issues/45",
        },
        title: "Issue #45",
        body: "Fix it",
        labels: ["bug"],
        priority: "normal",
        repository: {
          id: "owner/repo",
          default_branch: "main",
        },
        requested_action: "implement",
        requested_by: "octocat",
        timestamps: {
          created_at: 1000,
          updated_at: 2000,
        },
      }, null, 2) + "\n",
    );
    await writeFile(
      path.join(contextDir, "_task", "pr-open-request.json"),
      JSON.stringify({
        version: "1",
        title: "Fix issue #45: tighten README",
        body: "Implements the requested README tweak.\n\nCloses #45",
        head_ref: "roboppi/issue-45-tighten-readme",
        base_ref: "main",
        labels: ["roboppi-live-e2e-pr"],
        member_id: "lead",
        ts: 101,
        source: "intent",
      }, null, 2) + "\n",
    );

    const result = await applyGitHubPullRequestOpen({
      contextDir,
      runCommand: async (args) => {
        calls.push(args);
        return "https://github.com/owner/repo/pull/91\n";
      },
    });

    expect(calls).toEqual([
      [
        "pr",
        "create",
        "--repo",
        "owner/repo",
        "--title",
        "Fix issue #45: tighten README",
        "--body",
        "Implements the requested README tweak.\n\nCloses #45",
        "--base",
        "main",
        "--head",
        "roboppi/issue-45-tighten-readme",
        "--label",
        "roboppi-live-e2e-pr",
      ],
    ]);
    expect(result).toMatchObject({
      pull_request: {
        repository: "owner/repo",
        number: 91,
        url: "https://github.com/owner/repo/pull/91",
      },
      landing_lifecycle: "review_required",
    });

    const landing = JSON.parse(
      await readFile(path.join(contextDir, "_task", "landing.json"), "utf-8"),
    );
    expect(landing).toEqual({
      version: "1",
      lifecycle: "review_required",
      rationale: "PR created and awaiting review",
      metadata: {
        pr_url: "https://github.com/owner/repo/pull/91",
        pr_number: 91,
      },
    });
  });

  it("submits approval, merges, verifies, and materializes landed state", async () => {
    const calls: string[][] = [];
    await writeFile(
      path.join(contextDir, "_task", "review-verdict.json"),
      JSON.stringify({
        version: "1",
        decision: "approve",
        rationale: "Looks good",
        member_id: "lead",
        ts: 100,
        source: "intent",
      }, null, 2) + "\n",
    );
    await writeFile(
      path.join(contextDir, "_task", "merge-request.json"),
      JSON.stringify({
        version: "1",
        strategy: "squash",
        rationale: "Ready to land",
        member_id: "lead",
        ts: 101,
        source: "intent",
      }, null, 2) + "\n",
    );

    const result = await applyGitHubPullRequestActuation({
      contextDir,
      runCommand: async (args) => {
        calls.push(args);
        if (args[0] === "pr" && args[1] === "view") {
          return JSON.stringify({
            state: "MERGED",
            reviews: [{ state: "APPROVED" }],
          });
        }
        return "";
      },
    });

    expect(calls).toEqual([
      ["pr", "review", "45", "--repo", "owner/repo", "--approve", "--body", "Looks good"],
      ["pr", "merge", "45", "--repo", "owner/repo", "--delete-branch", "--squash"],
      ["pr", "view", "45", "--repo", "owner/repo", "--json", "state,reviews"],
    ]);
    expect(result).toMatchObject({
      decision: "approve",
      merged: true,
      review_submitted: true,
      landing_lifecycle: "landed",
      merge_strategy: "squash",
    });

    const landing = JSON.parse(
      await readFile(path.join(contextDir, "_task", "landing.json"), "utf-8"),
    );
    expect(landing).toEqual({
      version: "1",
      lifecycle: "landed",
      rationale: "Looks good",
      metadata: {
        merge_strategy: "squash",
      },
    });
  });

  it("falls back to a review comment when GitHub rejects self-approval and still merges", async () => {
    const calls: string[][] = [];
    await writeFile(
      path.join(contextDir, "_task", "review-verdict.json"),
      JSON.stringify({
        version: "1",
        decision: "approve",
        rationale: "Reviewed the PR and found no blocking issues",
        member_id: "lead",
        ts: 110,
        source: "intent",
      }, null, 2) + "\n",
    );
    await writeFile(
      path.join(contextDir, "_task", "merge-request.json"),
      JSON.stringify({
        version: "1",
        strategy: "squash",
        rationale: "Ready to land",
        member_id: "lead",
        ts: 111,
        source: "intent",
      }, null, 2) + "\n",
    );

    const result = await applyGitHubPullRequestActuation({
      contextDir,
      runCommand: async (args) => {
        calls.push(args);
        if (args[0] === "pr" && args[1] === "review") {
          throw new Error(
            "gh command failed: failed to create review: GraphQL: Review Can not approve your own pull request (addPullRequestReview)",
          );
        }
        if (args[0] === "pr" && args[1] === "view") {
          return JSON.stringify({
            state: "MERGED",
            reviews: [],
          });
        }
        return "";
      },
    });

    expect(calls).toEqual([
      [
        "pr",
        "review",
        "45",
        "--repo",
        "owner/repo",
        "--approve",
        "--body",
        "Reviewed the PR and found no blocking issues",
      ],
      [
        "pr",
        "comment",
        "45",
        "--repo",
        "owner/repo",
        "--body",
        "<!-- roboppi:review-fallback kind=approve-self -->\nReviewed the PR and found no blocking issues\n\nGitHub rejected APPROVE because the reviewer is also the pull request author.",
      ],
      ["pr", "merge", "45", "--repo", "owner/repo", "--delete-branch", "--squash"],
      ["pr", "view", "45", "--repo", "owner/repo", "--json", "state,reviews"],
    ]);
    expect(result).toMatchObject({
      decision: "approve",
      merged: true,
      review_submitted: false,
      landing_lifecycle: "landed",
      merge_strategy: "squash",
    });
  });

  it("submits changes requested and materializes blocked state", async () => {
    const calls: string[][] = [];
    await writeFile(
      path.join(contextDir, "_task", "review-verdict.json"),
      JSON.stringify({
        version: "1",
        decision: "changes_requested",
        rationale: "Needs a test update",
        member_id: "lead",
        ts: 200,
        source: "intent",
      }, null, 2) + "\n",
    );

    const result = await applyGitHubPullRequestActuation({
      contextDir,
      runCommand: async (args) => {
        calls.push(args);
        return "";
      },
    });

    expect(calls).toEqual([
      [
        "pr",
        "review",
        "45",
        "--repo",
        "owner/repo",
        "--request-changes",
        "--body",
        "Needs a test update",
      ],
    ]);
    expect(result).toMatchObject({
      decision: "changes_requested",
      merged: false,
      landing_lifecycle: "blocked",
    });

    const landing = JSON.parse(
      await readFile(path.join(contextDir, "_task", "landing.json"), "utf-8"),
    );
    expect(landing).toEqual({
      version: "1",
      lifecycle: "blocked",
      rationale: "Needs a test update",
      metadata: {
        review_decision: "changes_requested",
      },
    });
  });

  it("rejects approval actuation without a merge request intent", async () => {
    await writeFile(
      path.join(contextDir, "_task", "review-verdict.json"),
      JSON.stringify({
        version: "1",
        decision: "approve",
        rationale: "Looks good",
        member_id: "lead",
        ts: 300,
        source: "intent",
      }, null, 2) + "\n",
    );

    await expect(
      applyGitHubPullRequestActuation({
        contextDir,
        runCommand: async () => "",
      }),
    ).rejects.toThrow(/requires merge-request\.json/);
  });
});
