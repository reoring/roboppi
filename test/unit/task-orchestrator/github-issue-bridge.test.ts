import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GitHubIssueBridge,
  TaskRegistryStore,
  extractLinkedGitHubIssuesFromBody,
  emitTaskActivity,
} from "../../../src/task-orchestrator/index.js";
import { initAgentsContext, recvMessages } from "../../../src/agents/store.js";

describe("GitHubIssueBridge", () => {
  let stateDir: string;
  let registry: TaskRegistryStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "roboppi-github-bridge-"));
    registry = new TaskRegistryStore(stateDir);
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("creates and then updates a status comment for a GitHub issue task", async () => {
    const taskId = "github:issue:owner/repo#12";
    await registry.upsertEnvelope({
      version: "1",
      task_id: taskId,
      source: {
        kind: "github_issue",
        system_id: "github",
        external_id: "owner/repo#12",
      },
      title: "Fix flaky test",
      body: "",
      labels: ["bug"],
      priority: "normal",
      repository: {
        id: "owner/repo",
      },
      requested_action: "implement",
      timestamps: {
        created_at: 1000,
        updated_at: 1000,
      },
    });
    await registry.createRun(taskId, {
      runId: "run-1",
      workflow: "workflows/task.yaml",
      createdAt: 2000,
    });
    await registry.markRunRunning(taskId, "run-1", { startedAt: 3000 });

    const contextDir = path.join(registry.getRunDirectory(taskId, "run-1"), "context");
    await mkdir(path.join(contextDir, "_task"), { recursive: true });
    await writeFile(
      path.join(contextDir, "_task", "run.json"),
      JSON.stringify({
        version: "1",
        task_id: taskId,
        run_id: "run-1",
      }),
    );
    await writeFile(
      path.join(contextDir, "_task", "reporting.json"),
      JSON.stringify({
        version: "1",
        default_publisher: "lead",
        members: {
          lead: { roles: ["lead"] },
          reporter: { roles: ["publisher", "github_reporter"] },
        },
        sinks: {
          github: {
            enabled: true,
            publisher_member: "reporter",
            allowed_members: [],
            allowed_roles: ["publisher"],
            events: ["progress", "blocker"],
            projection: "status_comment",
            aggregate: "latest",
          },
        },
      }),
    );
    await emitTaskActivity({
      contextDir,
      kind: "progress",
      message: "Investigating the flaky test",
      memberId: "reporter",
      ts: 4000,
    });

    const calls: string[][] = [];
    const bridge = new GitHubIssueBridge({
      registry,
      runApi: async (args) => {
        calls.push(args);
        if (args[1] === "POST") {
          return JSON.stringify({ id: 12345 });
        }
        if (args[1] === "PATCH") {
          return JSON.stringify({ id: 12345 });
        }
        throw new Error(`unexpected gh args: ${args.join(" ")}`);
      },
    });

    await bridge.syncTask(taskId);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 4)).toEqual([
      "-X",
      "POST",
      "repos/owner/repo/issues/12/comments",
      "-f",
    ]);
    expect(calls[0]?.[4]).toContain("Roboppi issue status");
    expect(calls[0]?.[4]).toContain("Investigating the flaky test");
    expect(calls[0]?.[4]).toContain("Publisher policy: `reporter`");

    const bridgeState = await registry.getGitHubStatusBridgeState(taskId);
    expect(bridgeState).toMatchObject({
      status_comment_id: 12345,
    });

    await emitTaskActivity({
      contextDir,
      kind: "blocker",
      message: "Need a reproduction from CI",
      memberId: "reporter",
      ts: 5000,
    });
    await bridge.syncTask(taskId);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.slice(0, 4)).toEqual([
      "-X",
      "PATCH",
      "repos/owner/repo/issues/comments/12345",
      "-f",
    ]);
    expect(calls[1]?.[4]).toContain("Need a reproduction from CI");
  });

  it("ignores activities from members that are not allowed by reporting policy", async () => {
    const taskId = "github:issue:owner/repo#13";
    await registry.upsertEnvelope({
      version: "1",
      task_id: taskId,
      source: {
        kind: "github_issue",
        system_id: "github",
        external_id: "owner/repo#13",
      },
      title: "Tighten reporting policy",
      body: "",
      labels: ["bug"],
      priority: "normal",
      repository: {
        id: "owner/repo",
      },
      requested_action: "implement",
      timestamps: {
        created_at: 1000,
        updated_at: 1000,
      },
    });
    await registry.createRun(taskId, {
      runId: "run-1",
      workflow: "workflows/task.yaml",
      createdAt: 2000,
    });
    await registry.markRunRunning(taskId, "run-1", { startedAt: 3000 });

    const contextDir = path.join(registry.getRunDirectory(taskId, "run-1"), "context");
    await mkdir(path.join(contextDir, "_task"), { recursive: true });
    await writeFile(
      path.join(contextDir, "_task", "run.json"),
      JSON.stringify({
        version: "1",
        task_id: taskId,
        run_id: "run-1",
      }),
    );
    await writeFile(
      path.join(contextDir, "_task", "reporting.json"),
      JSON.stringify({
        version: "1",
        default_publisher: "lead",
        members: {
          lead: { roles: ["lead"] },
          reporter: { roles: ["publisher"] },
          implementer: { roles: ["emitter"] },
        },
        sinks: {
          github: {
            enabled: true,
            publisher_member: "lead",
            allowed_members: ["lead"],
            allowed_roles: ["publisher"],
            events: ["progress"],
            projection: "status_comment",
            aggregate: "latest",
          },
        },
      }),
    );
    await emitTaskActivity({
      contextDir,
      kind: "progress",
      message: "Internal implementation detail",
      memberId: "implementer",
      ts: 4000,
    });
    await emitTaskActivity({
      contextDir,
      kind: "progress",
      message: "Public milestone reached",
      memberId: "reporter",
      ts: 5000,
    });

    const calls: string[][] = [];
    const bridge = new GitHubIssueBridge({
      registry,
      runApi: async (args) => {
        calls.push(args);
        return JSON.stringify({ id: 67890 });
      },
    });

    await bridge.syncTask(taskId);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[4]).toContain("Public milestone reached");
    expect(calls[0]?.[4]).not.toContain("Internal implementation detail");
  });

  it("updates linked GitHub issue state when a pull request task lands", async () => {
    const issueTaskId = "github:issue:owner/repo#12";
    const pullRequestTaskId = "github:pull_request:owner/repo#34";

    await registry.upsertEnvelope({
      version: "1",
      task_id: issueTaskId,
      source: {
        kind: "github_issue",
        system_id: "github",
        external_id: "owner/repo#12",
        url: "https://github.com/owner/repo/issues/12",
      },
      title: "Track linked issue landing",
      body: "",
      labels: ["bug"],
      priority: "normal",
      repository: {
        id: "owner/repo",
      },
      requested_action: "implement",
      timestamps: {
        created_at: 1000,
        updated_at: 1000,
      },
    });
    await registry.createRun(issueTaskId, {
      runId: "issue-run",
      workflow: "workflows/issue.yaml",
      createdAt: 2000,
    });
    await registry.markRunRunning(issueTaskId, "issue-run", { startedAt: 3000 });
    await registry.finishRun(issueTaskId, "issue-run", {
      status: "completed",
      lifecycle: "review_required",
      workflowStatus: "SUCCEEDED",
      completedAt: 4000,
    });
    await registry.saveRunSummary(issueTaskId, "issue-run", {
      version: "1",
      task_id: issueTaskId,
      run_id: "issue-run",
      generated_at: 4000,
      final_lifecycle: "review_required",
      workflow_status: "SUCCEEDED",
      rationale: "PR created and awaiting review",
    });
    await registry.saveGitHubStatusBridgeState(issueTaskId, {
      version: "1",
      task_id: issueTaskId,
      status_comment_id: 111,
      last_rendered_body: "old-body",
      updated_at: 4500,
    });

    await registry.upsertEnvelope({
      version: "1",
      task_id: pullRequestTaskId,
      source: {
        kind: "github_pull_request",
        system_id: "github",
        external_id: "owner/repo#34",
        url: "https://github.com/owner/repo/pull/34",
      },
      title: "Fix README for issue #12",
      body: "Closes #12",
      labels: ["roboppi"],
      priority: "normal",
      repository: {
        id: "owner/repo",
      },
      requested_action: "review",
      timestamps: {
        created_at: 5000,
        updated_at: 5000,
      },
    });
    await registry.createRun(pullRequestTaskId, {
      runId: "pr-run",
      workflow: "workflows/pr.yaml",
      createdAt: 6000,
    });
    await registry.markRunRunning(pullRequestTaskId, "pr-run", { startedAt: 7000 });
    await registry.finishRun(pullRequestTaskId, "pr-run", {
      status: "completed",
      lifecycle: "landed",
      workflowStatus: "SUCCEEDED",
      completedAt: 8000,
    });
    await registry.saveRunSummary(pullRequestTaskId, "pr-run", {
      version: "1",
      task_id: pullRequestTaskId,
      run_id: "pr-run",
      generated_at: 8000,
      final_lifecycle: "landed",
      workflow_status: "SUCCEEDED",
      rationale: "PR reviewed, approved, and merged",
    });

    const calls: string[][] = [];
    const bridge = new GitHubIssueBridge({
      registry,
      runApi: async (args) => {
        calls.push(args);
        if (args[1] === "POST" && args[2] === "repos/owner/repo/issues/34/comments") {
          return JSON.stringify({ id: 34001 });
        }
        if (args[1] === "POST" && args[2] === "repos/owner/repo/issues/12/comments") {
          return JSON.stringify({ id: 12001 });
        }
        if (args[1] === "PATCH" && args[2] === "repos/owner/repo/issues/comments/111") {
          return JSON.stringify({ id: 111 });
        }
        if (args[1] === "PATCH" && args[2] === "repos/owner/repo/issues/12") {
          return JSON.stringify({ ok: true });
        }
        throw new Error(`unexpected gh args: ${args.join(" ")}`);
      },
    });

    await bridge.syncTask(pullRequestTaskId);

    expect(calls.some((args) => args[2] === "repos/owner/repo/issues/34/comments")).toBe(true);
    expect(calls.some((args) => args[2] === "repos/owner/repo/issues/12")).toBe(true);
    expect(calls.some((args) => args[2] === "repos/owner/repo/issues/12/comments")).toBe(true);
    expect(calls.some((args) => args[2] === "repos/owner/repo/issues/comments/111")).toBe(true);

    const nextIssueState = await registry.getTaskState(issueTaskId);
    expect(nextIssueState?.lifecycle).toBe("landed");

    const nextSummary = await registry.getRunSummary(issueTaskId, "issue-run");
    expect(nextSummary?.final_lifecycle).toBe("landed");
    expect(nextSummary?.rationale).toContain("merged");

    const nextLanding = await registry.getLandingDecision(issueTaskId, "issue-run");
    expect(nextLanding).toMatchObject({
      lifecycle: "landed",
      source: "linked_task",
    });
  });

  it("extracts same-repo and explicit-repo closing references from a pull request body", () => {
    expect(
      extractLinkedGitHubIssuesFromBody(
        "Closes #12\nFixes owner/repo#14 and resolves #15",
        "owner/repo",
      ),
    ).toEqual([
      {
        repo: "owner/repo",
        issueNumber: 12,
        taskId: "github:issue:owner/repo#12",
      },
      {
        repo: "owner/repo",
        issueNumber: 14,
        taskId: "github:issue:owner/repo#14",
      },
      {
        repo: "owner/repo",
        issueNumber: 15,
        taskId: "github:issue:owner/repo#15",
      },
    ]);
  });

  it("publishes a clarification comment when an issue is waiting for input", async () => {
    const taskId = "github:issue:owner/repo#55";
    await registry.upsertEnvelope({
      version: "1",
      task_id: taskId,
      source: {
        kind: "github_issue",
        system_id: "github",
        external_id: "owner/repo#55",
      },
      title: "Clarify README request",
      body: "",
      labels: ["bug"],
      priority: "normal",
      repository: {
        id: "owner/repo",
      },
      requested_action: "implement",
      timestamps: {
        created_at: 1000,
        updated_at: 1000,
      },
    });
    await registry.createRun(taskId, {
      runId: "run-clarify",
      workflow: "workflows/task.yaml",
      createdAt: 2000,
    });
    await registry.markRunRunning(taskId, "run-clarify", { startedAt: 3000 });
    await registry.finishRun(taskId, "run-clarify", {
      status: "completed",
      lifecycle: "waiting_for_input",
      workflowStatus: "SUCCEEDED",
      completedAt: 4000,
    });
    await registry.saveRunSummary(taskId, "run-clarify", {
      version: "1",
      task_id: taskId,
      run_id: "run-clarify",
      generated_at: 4000,
      final_lifecycle: "waiting_for_input",
      workflow_status: "SUCCEEDED",
      rationale: "Need the expected README text before editing docs",
    });

    const contextDir = path.join(registry.getRunDirectory(taskId, "run-clarify"), "context");
    await mkdir(path.join(contextDir, "_task"), { recursive: true });
    await writeFile(
      path.join(contextDir, "_task", "clarification-request.json"),
      JSON.stringify({
        version: "1",
        summary: "Need the expected README text before editing docs",
        questions: ["What exact sentence should be added to README.md?"],
        missing_fields: ["expected_text"],
        resume_hints: ["Reply on this issue with the desired sentence"],
        severity: "normal",
        member_id: "lead",
        ts: 4500,
        source: "intent",
      }),
    );
    await registry.saveWaitingState({
      version: "1",
      task_id: taskId,
      status: "waiting",
      round_trip_count: 1,
      waiting_started_at: 4000,
      updated_at: 4000,
      last_source_revision: null,
      last_human_signal_at: 1000,
      reminder_due_at: null,
      reminder_sent_at: null,
      block_after_at: 9000,
      resumed_at: null,
      blocked_at: null,
    });

    const calls: string[][] = [];
    const bridge = new GitHubIssueBridge({
      registry,
      runApi: async (args) => {
        calls.push(args);
        if (args[1] === "POST" && args[2] === "repos/owner/repo/issues/55/comments") {
          return JSON.stringify({ id: calls.length === 1 ? 55001 : 55002 });
        }
        throw new Error(`unexpected gh args: ${args.join(" ")}`);
      },
    });

    await bridge.syncTask(taskId);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.[4]).toContain("Roboppi issue status");
    expect(calls[1]?.[4]).toContain("<!-- roboppi:clarification-request task_id=github:issue:owner/repo#55 ts=4500 -->");
    expect(calls[1]?.[4]).toContain("Need the expected README text before editing docs");
    expect(calls[1]?.[4]).toContain("What exact sentence should be added to README.md?");
    expect(calls[1]?.[4]).toContain("Missing fields: expected_text");
    expect(calls[1]?.[4]).toContain("Clarification round trips: 1");
    expect(calls[1]?.[4]).toContain("Auto-block after:");

    const bridgeState = await registry.getGitHubStatusBridgeState(taskId);
    expect(bridgeState).toMatchObject({
      status_comment_id: 55001,
      clarification_comment_id: 55002,
    });
  });

  it("updates the clarification comment when a reminder has been sent", async () => {
    const taskId = "github:issue:owner/repo#56";
    await registry.upsertEnvelope({
      version: "1",
      task_id: taskId,
      source: {
        kind: "github_issue",
        system_id: "github",
        external_id: "owner/repo#56",
      },
      title: "Clarify behavior",
      body: "",
      labels: ["bug"],
      priority: "normal",
      repository: {
        id: "owner/repo",
      },
      requested_action: "implement",
      timestamps: {
        created_at: 1000,
        updated_at: 1000,
      },
    });
    await registry.createRun(taskId, {
      runId: "run-clarify-reminder",
      workflow: "workflows/task.yaml",
      createdAt: 2000,
    });
    await registry.markRunRunning(taskId, "run-clarify-reminder", { startedAt: 3000 });
    await registry.finishRun(taskId, "run-clarify-reminder", {
      status: "completed",
      lifecycle: "waiting_for_input",
      workflowStatus: "SUCCEEDED",
      completedAt: 4000,
    });
    await registry.saveRunSummary(taskId, "run-clarify-reminder", {
      version: "1",
      task_id: taskId,
      run_id: "run-clarify-reminder",
      generated_at: 4000,
      final_lifecycle: "waiting_for_input",
      workflow_status: "SUCCEEDED",
      rationale: "Still waiting on clarification",
    });

    const contextDir = path.join(
      registry.getRunDirectory(taskId, "run-clarify-reminder"),
      "context",
    );
    await mkdir(path.join(contextDir, "_task"), { recursive: true });
    await writeFile(
      path.join(contextDir, "_task", "clarification-request.json"),
      JSON.stringify({
        version: "1",
        summary: "Still waiting on clarification",
        questions: ["What exact behavior is expected?"],
        member_id: "lead",
        ts: 4500,
        source: "intent",
      }),
    );
    await registry.saveWaitingState({
      version: "1",
      task_id: taskId,
      status: "waiting",
      round_trip_count: 2,
      waiting_started_at: 4000,
      updated_at: 5000,
      last_source_revision: "rev-2",
      last_human_signal_at: 1000,
      reminder_due_at: 4800,
      reminder_sent_at: 5000,
      block_after_at: 9000,
      resumed_at: null,
      blocked_at: null,
    });
    await registry.saveGitHubStatusBridgeState(taskId, {
      version: "1",
      task_id: taskId,
      status_comment_id: 56001,
      last_rendered_body: "status-body",
      clarification_comment_id: 56002,
      last_clarification_body: "old clarification body",
      updated_at: 5000,
    });

    const calls: string[][] = [];
    const bridge = new GitHubIssueBridge({
      registry,
      runApi: async (args) => {
        calls.push(args);
        if (args[1] === "PATCH" && args[2] === "repos/owner/repo/issues/comments/56001") {
          return JSON.stringify({ id: 56001 });
        }
        if (args[1] === "PATCH" && args[2] === "repos/owner/repo/issues/comments/56002") {
          return JSON.stringify({ id: 56002 });
        }
        throw new Error(`unexpected gh args: ${args.join(" ")}`);
      },
    });

    await bridge.syncTask(taskId);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.slice(0, 4)).toEqual([
      "-X",
      "PATCH",
      "repos/owner/repo/issues/comments/56002",
      "-f",
    ]);
    expect(calls[1]?.[4]).toContain("Reminder sent at: 1970-01-01T00:00:05.000Z");
    expect(calls[1]?.[4]).toContain("This task is still waiting on human input.");
    expect(calls[1]?.[4]).toContain("Clarification round trips: 2");
  });

  it("delivers new operator comments to the lead inbox without duplicating them", async () => {
    const taskId = "github:issue:owner/repo#57";
    await registry.upsertEnvelope({
      version: "1",
      task_id: taskId,
      source: {
        kind: "github_issue",
        system_id: "github",
        external_id: "owner/repo#57",
      },
      title: "Operator feedback loop",
      body: "",
      labels: ["bug"],
      priority: "normal",
      repository: {
        id: "owner/repo",
      },
      requested_action: "implement",
      timestamps: {
        created_at: 1000,
        updated_at: 1000,
      },
    });
    await registry.createRun(taskId, {
      runId: "run-operator-comments",
      workflow: "workflows/task.yaml",
      createdAt: 2000,
    });
    await registry.markRunRunning(taskId, "run-operator-comments", { startedAt: 3000 });

    const contextDir = path.join(
      registry.getRunDirectory(taskId, "run-operator-comments"),
      "context",
    );
    await mkdir(path.join(contextDir, "_task"), { recursive: true });
    await writeFile(
      path.join(contextDir, "_task", "run.json"),
      JSON.stringify({
        version: "1",
        task_id: taskId,
        run_id: "run-operator-comments",
      }),
    );
    await initAgentsContext({
      contextDir,
      teamName: "issue-team",
      leadMemberId: "lead",
      members: [
        { member_id: "lead", name: "Lead", role: "lead" },
        { member_id: "implementer", name: "Implementer", role: "implementer" },
      ],
    });

    const calls: string[][] = [];
    const bridge = new GitHubIssueBridge({
      registry,
      runApi: async (args) => {
        calls.push(args);
        if (args[1] === "POST" && args[2] === "repos/owner/repo/issues/57/comments") {
          return JSON.stringify({ id: 57001 });
        }
        if (args[1] === "PATCH" && args[2] === "repos/owner/repo/issues/comments/57001") {
          return JSON.stringify({ id: 57001 });
        }
        if (args[0] === "repos/owner/repo/issues/57/comments?per_page=100") {
          return JSON.stringify([
            {
              id: 9001,
              body: "Can you also cover the failure case?",
              html_url: "https://github.com/owner/repo/issues/57#issuecomment-9001",
              created_at: "2026-03-10T01:00:00Z",
              updated_at: "2026-03-10T01:00:00Z",
              author_association: "OWNER",
              user: { login: "octocat" },
            },
            {
              id: 9002,
              body: "<!-- roboppi:task-ack task_id=github:issue:owner/repo#57 -->",
              created_at: "2026-03-10T01:01:00Z",
              updated_at: "2026-03-10T01:01:00Z",
              user: { login: "roboppi-bot" },
            },
          ]);
        }
        throw new Error(`unexpected gh args: ${args.join(" ")}`);
      },
    });

    await bridge.syncTask(taskId);

    const leadMessages = await recvMessages({
      contextDir,
      memberId: "lead",
      claim: false,
    });
    expect(leadMessages).toHaveLength(1);
    const operatorMessage = JSON.parse(leadMessages[0]!.message.body) as Record<string, unknown>;
    expect(operatorMessage).toMatchObject({
      kind: "operator_comment",
      task_id: taskId,
      source_kind: "github_issue",
      comment_id: 9001,
      author: "octocat",
      author_association: "OWNER",
      body: "Can you also cover the failure case?",
    });
    expect((await registry.getGitHubStatusBridgeState(taskId))?.last_operator_comment_id).toBe(9001);

    await bridge.syncTask(taskId);
    const leadMessagesAfterSecondSync = await recvMessages({
      contextDir,
      memberId: "lead",
      claim: false,
    });
    expect(leadMessagesAfterSecondSync).toHaveLength(1);
  });
});
