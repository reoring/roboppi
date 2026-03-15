import path from "node:path";
import { deliverMessage, readTeam } from "../agents/store.js";
import type { TaskRegistryStore } from "./state-store.js";
import { readTaskActivityEvents } from "./activity-log.js";
import { runGhApi, type GitHubApiRunner } from "./github-issue-source.js";
import { readTaskReportingPolicy, selectSinkActivities } from "./reporting-policy.js";
import type {
  TaskClarificationRequest,
  TaskActivityEvent,
  TaskEnvelope,
  TaskGitHubStatusBridgeState,
  TaskLandingDecision,
  TaskLifecycleState,
  TaskReportingPolicy,
  TaskRunRecord,
  TaskRunSummary,
  TaskWaitingState,
} from "./types.js";

interface IssueCommentResponse {
  id?: unknown;
}

interface GitHubIssueCommentPayload {
  id?: unknown;
  body?: unknown;
  html_url?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  author_association?: unknown;
  user?: unknown;
}

export interface GitHubIssueBridgeOptions {
  registry: TaskRegistryStore;
  runApi?: GitHubApiRunner;
  abortSignal?: AbortSignal;
}

export class GitHubIssueBridge {
  private readonly registry: TaskRegistryStore;
  private readonly runApi: GitHubApiRunner;
  private readonly abortSignal?: AbortSignal;

  constructor(options: GitHubIssueBridgeOptions) {
    this.registry = options.registry;
    this.runApi = options.runApi ?? runGhApi;
    this.abortSignal = options.abortSignal;
  }

  async syncTask(taskId: string): Promise<void> {
    const envelope = await this.registry.getEnvelope(taskId);
    const state = await this.registry.getTaskState(taskId);
    if (!envelope || !state) return;
    if (
      envelope.source.kind !== "github_issue" &&
      envelope.source.kind !== "github_pull_request"
    ) {
      return;
    }

    const runId = state.active_run_id ?? state.latest_run_id;
    if (!runId) return;

    const run = await this.registry.getRun(taskId, runId);
    if (!run) return;
    const summary = await this.registry.getRunSummary(taskId, runId);
    const contextDir = this.resolveContextDir(taskId, runId);
    const reportingPolicy = await readTaskReportingPolicy(contextDir).catch(() => null);
    if (reportingPolicy && !reportingPolicy.sinks.github) {
      return;
    }
    const activityEvents = await readTaskActivityEvents(contextDir).catch(() => []);
    const projectedActivities = selectSinkActivities(
      reportingPolicy,
      "github",
      activityEvents,
    );
    if (reportingPolicy?.sinks.github && !reportingPolicy.sinks.github.enabled) {
      return;
    }
    const body = buildStatusComment({
      envelope,
      lifecycle: state.lifecycle,
      run,
      summary,
      reportingPolicy,
      projectedActivities,
    });

    const bridgeState = await this.registry.getGitHubStatusBridgeState(taskId);
    if (bridgeState?.last_rendered_body === body) {
      await this.syncClarificationComment({
        envelope,
        lifecycle: state.lifecycle,
        contextDir,
        bridgeState,
      });
      await this.syncOperatorComments({
        envelope,
        contextDir,
        bridgeState: await this.registry.getGitHubStatusBridgeState(taskId),
        allowDelivery: state.active_run_id !== null,
      });
      return;
    }

    const { repo, issueNumber } = parseGitHubIssueRef(envelope.source.external_id);
    let commentId = bridgeState?.status_comment_id ?? null;
    if (commentId === null) {
      const response = await this.runApi(
        [
          "-X",
          "POST",
          `repos/${repo}/issues/${issueNumber}/comments`,
          "-f",
          `body=${body}`,
        ],
        this.abortSignal,
      );
      commentId = parseCommentId(response);
    } else {
      await this.runApi(
        [
          "-X",
          "PATCH",
          `repos/${repo}/issues/comments/${commentId}`,
          "-f",
          `body=${body}`,
        ],
        this.abortSignal,
      );
    }

    await this.registry.saveGitHubStatusBridgeState(taskId, {
      version: "1",
      task_id: taskId,
      status_comment_id: commentId,
      last_rendered_body: body,
      clarification_comment_id: bridgeState?.clarification_comment_id ?? null,
      last_clarification_body: bridgeState?.last_clarification_body ?? null,
      last_operator_comment_id: bridgeState?.last_operator_comment_id ?? null,
      updated_at: Date.now(),
    });

    await this.syncClarificationComment({
      envelope,
      lifecycle: state.lifecycle,
      contextDir,
      bridgeState: await this.registry.getGitHubStatusBridgeState(taskId),
    });
    await this.syncOperatorComments({
      envelope,
      contextDir,
      bridgeState: await this.registry.getGitHubStatusBridgeState(taskId),
      allowDelivery: state.active_run_id !== null,
    });

    await this.syncLinkedIssuesFromPullRequest({
      envelope,
      stateLifecycle: state.lifecycle,
      summary,
    });
  }

  async syncActiveTasks(): Promise<void> {
    const active = await this.registry.listActiveTasks();
    for (const entry of active) {
      await this.syncTask(entry.task_id);
    }
  }

  async syncTasksByLifecycle(lifecycles: TaskLifecycleState[]): Promise<void> {
    const states = await this.registry.listTaskStates();
    const allowed = new Set(lifecycles);
    for (const state of states) {
      if (!allowed.has(state.lifecycle)) continue;
      await this.syncTask(state.task_id);
    }
  }

  private resolveContextDir(taskId: string, runId: string): string {
    return this.registry.getRunDirectory(taskId, runId) + "/context";
  }

  private async syncClarificationComment(args: {
    envelope: TaskEnvelope;
    lifecycle: TaskLifecycleState;
    contextDir: string;
    bridgeState: TaskGitHubStatusBridgeState | null;
  }): Promise<void> {
    if (args.envelope.source.kind !== "github_issue") return;
    if (args.lifecycle !== "waiting_for_input") return;

    const clarification = await readClarificationRequest(args.contextDir);
    if (!clarification) return;
    const waitingState = await this.registry.getWaitingState(args.envelope.task_id);

    const body = buildClarificationComment({
      taskId: args.envelope.task_id,
      clarification,
      waitingState,
    });
    if (args.bridgeState?.last_clarification_body === body) {
      return;
    }

    const { repo, issueNumber } = parseGitHubIssueRef(args.envelope.source.external_id);
    let commentId = args.bridgeState?.clarification_comment_id ?? null;
    if (commentId === null) {
      const response = await this.runApi(
        [
          "-X",
          "POST",
          `repos/${repo}/issues/${issueNumber}/comments`,
          "-f",
          `body=${body}`,
        ],
        this.abortSignal,
      );
      commentId = parseCommentId(response);
    } else {
      await this.runApi(
        [
          "-X",
          "PATCH",
          `repos/${repo}/issues/comments/${commentId}`,
          "-f",
          `body=${body}`,
        ],
        this.abortSignal,
      );
    }

    await this.registry.saveGitHubStatusBridgeState(args.envelope.task_id, {
      version: "1",
      task_id: args.envelope.task_id,
      status_comment_id: args.bridgeState?.status_comment_id ?? null,
      last_rendered_body: args.bridgeState?.last_rendered_body ?? null,
      clarification_comment_id: commentId,
      last_clarification_body: body,
      last_operator_comment_id: args.bridgeState?.last_operator_comment_id ?? null,
      updated_at: Date.now(),
    });
  }

  private async syncOperatorComments(args: {
    envelope: TaskEnvelope;
    contextDir: string;
    bridgeState: TaskGitHubStatusBridgeState | null;
    allowDelivery: boolean;
  }): Promise<void> {
    if (!args.allowDelivery) {
      return;
    }
    const team = await readTeam(args.contextDir).catch(() => null);
    if (!team) return;

    const { repo, issueNumber } = parseGitHubIssueRef(args.envelope.source.external_id);
    const comments = await listHumanOperatorComments(
      this.runApi,
      repo,
      issueNumber,
      this.abortSignal,
    );
    if (comments.length === 0) return;

    const lastSeenId = args.bridgeState?.last_operator_comment_id ?? null;
    const nextComments = comments.filter((comment) =>
      lastSeenId === null ? true : comment.id > lastSeenId
    );
    if (nextComments.length === 0) return;

    for (const comment of nextComments) {
      await deliverMessage({
        contextDir: args.contextDir,
        teamId: team.team_id,
        fromMemberId: "github-operator",
        fromName: "GitHub operator bridge",
        toMemberId: team.lead_member_id,
        topic: "operator_comment",
        body: JSON.stringify({
          kind: "operator_comment",
          task_id: args.envelope.task_id,
          source_kind: args.envelope.source.kind,
          comment_id: comment.id,
          author: comment.author,
          author_association: comment.authorAssociation,
          body: comment.body,
          url: comment.url,
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
        }),
        metadata: {
          task_id: args.envelope.task_id,
          source_kind: args.envelope.source.kind,
          comment_id: comment.id,
          provider: "github",
        },
      });
    }

    const lastComment = nextComments[nextComments.length - 1]!;
    await this.registry.saveGitHubStatusBridgeState(args.envelope.task_id, {
      version: "1",
      task_id: args.envelope.task_id,
      status_comment_id: args.bridgeState?.status_comment_id ?? null,
      last_rendered_body: args.bridgeState?.last_rendered_body ?? null,
      clarification_comment_id: args.bridgeState?.clarification_comment_id ?? null,
      last_clarification_body: args.bridgeState?.last_clarification_body ?? null,
      last_operator_comment_id: lastComment.id,
      updated_at: Date.now(),
    });
  }

  private async syncLinkedIssuesFromPullRequest(args: {
    envelope: TaskEnvelope;
    stateLifecycle: TaskLifecycleState;
    summary: TaskRunSummary | null;
  }): Promise<void> {
    if (args.envelope.source.kind !== "github_pull_request") return;

    let linkedLifecycle: Extract<TaskLifecycleState, "landed" | "closed_without_landing"> | null =
      null;
    if (args.stateLifecycle === "landed") {
      linkedLifecycle = "landed";
    } else if (args.stateLifecycle === "closed_without_landing") {
      linkedLifecycle = "closed_without_landing";
    }
    if (!linkedLifecycle) return;

    const defaultRepo = args.envelope.repository?.id;
    if (!defaultRepo) return;
    const linkedIssues = extractLinkedGitHubIssuesFromBody(args.envelope.body, defaultRepo);
    if (linkedIssues.length === 0) return;

    for (const linkedIssue of linkedIssues) {
      const issueState = await this.registry.getTaskState(linkedIssue.taskId);
      if (!issueState || issueState.active_run_id) {
        if (linkedLifecycle === "landed") {
          await maybeCloseGitHubIssue(
            this.runApi,
            linkedIssue.repo,
            linkedIssue.issueNumber,
            this.abortSignal,
          );
        }
        continue;
      }
      const issueRunId = issueState.latest_run_id ?? issueState.last_completed_run_id;
      if (!issueRunId) continue;

      const rationale = buildLinkedIssueRationale(
        args.envelope,
        linkedLifecycle,
        args.summary,
      );
      const nextUpdatedAt = Date.now();
      const needsLifecycleUpdate = issueState.lifecycle !== linkedLifecycle;

      if (needsLifecycleUpdate) {
        await this.registry.saveTaskState({
          ...issueState,
          lifecycle: linkedLifecycle,
          updated_at: nextUpdatedAt,
          last_transition_at: nextUpdatedAt,
        });
        await this.registry.saveRunSummary(
          linkedIssue.taskId,
          issueRunId,
          buildLinkedIssueSummary(
            linkedIssue.taskId,
            issueRunId,
            linkedLifecycle,
            rationale,
            {
              taskId: args.envelope.task_id,
              url: args.envelope.source.url,
            },
          ),
        );
        await this.registry.saveLandingDecision(
          linkedIssue.taskId,
          issueRunId,
          buildLinkedIssueLandingDecision(linkedLifecycle, rationale, {
            taskId: args.envelope.task_id,
            url: args.envelope.source.url,
          }),
        );
        await this.runApi(
          [
            "-X",
            "POST",
            `repos/${linkedIssue.repo}/issues/${linkedIssue.issueNumber}/comments`,
            "-f",
            `body=${buildLinkedIssueComment({
              issueTaskId: linkedIssue.taskId,
              pullRequestTaskId: args.envelope.task_id,
              pullRequestUrl: args.envelope.source.url,
              lifecycle: linkedLifecycle,
              rationale,
            })}`,
          ],
          this.abortSignal,
        );
      }

      if (linkedLifecycle === "landed") {
        await maybeCloseGitHubIssue(
          this.runApi,
          linkedIssue.repo,
          linkedIssue.issueNumber,
          this.abortSignal,
        );
      }

      await this.syncTask(linkedIssue.taskId);
    }
  }
}

interface LinkedIssueRef {
  repo: string;
  issueNumber: number;
  taskId: string;
}

async function maybeCloseGitHubIssue(
  runApi: GitHubApiRunner,
  repo: string,
  issueNumber: number,
  signal?: AbortSignal,
): Promise<void> {
  await runApi(
    [
      "-X",
      "PATCH",
      `repos/${repo}/issues/${issueNumber}`,
      "-f",
      "state=closed",
      "-f",
      "state_reason=completed",
    ],
    signal,
  );
}

function buildLinkedIssueSummary(
  issueTaskId: string,
  issueRunId: string,
  lifecycle: Extract<TaskLifecycleState, "landed" | "closed_without_landing">,
  rationale: string,
  linkedPullRequest: {
    taskId: string;
    url?: string;
  },
): TaskRunSummary {
  return {
    version: "1",
    task_id: issueTaskId,
    run_id: issueRunId,
    generated_at: Date.now(),
    final_lifecycle: lifecycle,
    rationale,
    metadata: {
      linked_pull_request_task_id: linkedPullRequest.taskId,
      linked_pull_request_url: linkedPullRequest.url,
    },
  };
}

function buildLinkedIssueLandingDecision(
  lifecycle: Extract<TaskLifecycleState, "landed" | "closed_without_landing">,
  rationale: string,
  linkedPullRequest: {
    taskId: string;
    url?: string;
  },
): TaskLandingDecision {
  return {
    version: "1",
    lifecycle,
    rationale,
    source: "linked_task",
    metadata: {
      linked_pull_request_task_id: linkedPullRequest.taskId,
      linked_pull_request_url: linkedPullRequest.url,
    },
  };
}

function buildLinkedIssueComment(args: {
  issueTaskId: string;
  pullRequestTaskId: string;
  pullRequestUrl?: string;
  lifecycle: Extract<TaskLifecycleState, "landed" | "closed_without_landing">;
  rationale: string;
}): string {
  const stateText =
    args.lifecycle === "landed"
      ? "changes have been landed"
      : "linked pull request closed without landing changes";
  const lines = [
    `<!-- roboppi:linked-pr-sync issue_task_id=${args.issueTaskId} pr_task_id=${args.pullRequestTaskId} lifecycle=${args.lifecycle} -->`,
    `Roboppi linked pull request update: ${stateText}`,
    "",
    `- Issue task: \`${args.issueTaskId}\``,
    `- Pull request task: \`${args.pullRequestTaskId}\``,
    `- State: \`${args.lifecycle}\``,
    `- Summary: ${args.rationale}`,
  ];
  if (args.pullRequestUrl) {
    lines.push(`- Pull request: ${args.pullRequestUrl}`);
  }
  return lines.join("\n");
}

function buildLinkedIssueRationale(
  pullRequest: TaskEnvelope,
  linkedLifecycle: Extract<TaskLifecycleState, "landed" | "closed_without_landing">,
  summary: TaskRunSummary | null,
): string {
  if (summary?.rationale && summary.rationale.trim() !== "") {
    return summary.rationale.trim();
  }
  if (linkedLifecycle === "landed") {
    return `Linked pull request ${pullRequest.title} has been merged`;
  }
  return `Linked pull request ${pullRequest.title} closed without landing changes`;
}

export function extractLinkedGitHubIssuesFromBody(
  body: string,
  defaultRepo: string,
): LinkedIssueRef[] {
  const linked = new Map<string, LinkedIssueRef>();
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    if (!/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/i.test(line)) continue;
    const refPattern = /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)/g;
    for (const match of line.matchAll(refPattern)) {
      const repo = match[1] ?? defaultRepo;
      const issueNumber = Number(match[2]);
      if (!Number.isInteger(issueNumber) || issueNumber <= 0) continue;
      const taskId = `github:issue:${repo}#${issueNumber}`;
      linked.set(taskId, {
        repo,
        issueNumber,
        taskId,
      });
    }
  }
  return [...linked.values()];
}

function buildStatusComment(args: {
  envelope: TaskEnvelope;
  lifecycle: TaskLifecycleState;
  run: TaskRunRecord;
  summary: TaskRunSummary | null;
  reportingPolicy: TaskReportingPolicy | null;
  projectedActivities: TaskActivityEvent[];
}): string {
  const lines = [
    `<!-- roboppi:issue-status task_id=${args.envelope.task_id} run_id=${args.run.run_id} -->`,
    args.envelope.source.kind === "github_pull_request"
      ? "Roboppi pull request status"
      : "Roboppi issue status",
    "",
    `- Title: ${args.envelope.title}`,
    `- Lifecycle: \`${args.lifecycle}\``,
    `- Run: \`${args.run.run_id}\``,
    `- Run status: \`${args.run.status}\``,
  ];

  if (args.run.workflow_status) {
    lines.push(`- Workflow status: \`${args.run.workflow_status}\``);
  }
  const githubPolicy = args.reportingPolicy?.sinks.github;
  if (githubPolicy?.publisher_member) {
    lines.push(`- Publisher policy: \`${githubPolicy.publisher_member}\``);
  }
  if (args.projectedActivities.length > 0) {
    if (args.projectedActivities.length === 1) {
      const latestActivity = args.projectedActivities[0]!;
      lines.push(`- Latest activity: ${latestActivity.kind} - ${latestActivity.message}`);
      if (latestActivity.phase) {
        lines.push(`- Phase: \`${latestActivity.phase}\``);
      }
      if (latestActivity.member_id) {
        lines.push(`- Member: \`${latestActivity.member_id}\``);
      }
    } else {
      lines.push("- Recent activity:");
      for (const activity of args.projectedActivities) {
        const phaseLabel = activity.phase ? ` [${activity.phase}]` : "";
        const memberLabel = activity.member_id ? ` (${activity.member_id})` : "";
        lines.push(`  - ${activity.kind}${phaseLabel}: ${activity.message}${memberLabel}`);
      }
    }
  }
  if (args.summary?.rationale) {
    lines.push(`- Summary: ${args.summary.rationale}`);
  }
  lines.push(`- Updated: ${new Date().toISOString()}`);

  return lines.join("\n");
}

function buildClarificationComment(args: {
  taskId: string;
  clarification: TaskClarificationRequest;
  waitingState: TaskWaitingState | null;
}): string {
  const lines = [
    `<!-- roboppi:clarification-request task_id=${args.taskId} ts=${args.clarification.ts} -->`,
    "Roboppi needs more information before implementation can continue",
    "",
    `- Task: \`${args.taskId}\``,
    `- Summary: ${args.clarification.summary}`,
  ];

  if (args.clarification.questions && args.clarification.questions.length > 0) {
    lines.push("");
    lines.push("Questions:");
    for (const question of args.clarification.questions) {
      lines.push(`- ${question}`);
    }
  }

  if (
    args.clarification.missing_fields
    && args.clarification.missing_fields.length > 0
  ) {
    lines.push("");
    lines.push(`Missing fields: ${args.clarification.missing_fields.join(", ")}`);
  }

  if (args.clarification.resume_hints && args.clarification.resume_hints.length > 0) {
    lines.push("");
    lines.push("How to unblock:");
    for (const hint of args.clarification.resume_hints) {
      lines.push(`- ${hint}`);
    }
  }

  if (args.waitingState) {
    lines.push("");
    lines.push(`Clarification round trips: ${args.waitingState.round_trip_count}`);
    if (args.waitingState.reminder_sent_at !== null) {
      lines.push(
        `Reminder sent at: ${new Date(args.waitingState.reminder_sent_at).toISOString()}`,
      );
      lines.push("This task is still waiting on human input.");
    }
    if (args.waitingState.block_after_at !== null) {
      lines.push(
        `Auto-block after: ${new Date(args.waitingState.block_after_at).toISOString()}`,
      );
    }
  }

  return lines.join("\n");
}

async function readClarificationRequest(
  contextDir: string,
): Promise<TaskClarificationRequest | null> {
  const text = await Bun.file(path.join(contextDir, "_task", "clarification-request.json"))
    .text()
    .catch(() => "");
  if (text.trim() === "") return null;
  return JSON.parse(text) as TaskClarificationRequest;
}

interface OperatorComment {
  id: number;
  body: string;
  author?: string;
  authorAssociation?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

async function listHumanOperatorComments(
  runApi: GitHubApiRunner,
  repo: string,
  issueNumber: number,
  signal?: AbortSignal,
): Promise<OperatorComment[]> {
  const response = await runApi(
    [`repos/${repo}/issues/${issueNumber}/comments?per_page=100`],
    signal,
  );
  const parsed = JSON.parse(response) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`GitHub bridge expected comments array for ${repo}#${issueNumber}`);
  }

  const comments: OperatorComment[] = [];
  for (const value of parsed) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const comment = value as GitHubIssueCommentPayload;
    const id = parseOptionalPositiveInteger(comment.id);
    const body = typeof comment.body === "string" ? comment.body : "";
    if (id === undefined || body.trim() === "" || isRoboppiMarkerComment(body)) continue;
    comments.push({
      id,
      body,
      author: parseOptionalUserLogin(comment.user),
      authorAssociation:
        typeof comment.author_association === "string"
          ? comment.author_association
          : undefined,
      url: typeof comment.html_url === "string" ? comment.html_url : undefined,
      createdAt: parseOptionalTimestampString(comment.created_at),
      updatedAt: parseOptionalTimestampString(comment.updated_at),
    });
  }

  comments.sort((a, b) => a.id - b.id);
  return comments;
}

function parseOptionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function parseOptionalTimestampString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

function parseOptionalUserLogin(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return typeof (value as Record<string, unknown>)["login"] === "string"
    ? ((value as Record<string, unknown>)["login"] as string)
    : undefined;
}

function isRoboppiMarkerComment(body: string): boolean {
  return body.includes("<!-- roboppi:");
}

function parseGitHubIssueRef(externalId: string): { repo: string; issueNumber: number } {
  const [repo, issuePart] = externalId.split("#");
  if (!repo || issuePart === undefined) {
    throw new Error(`Invalid GitHub issue external id: ${externalId}`);
  }
  const issueNumber = Number(issuePart);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid GitHub issue number in external id: ${externalId}`);
  }
  return { repo, issueNumber };
}

function parseCommentId(responseText: string): number {
  const parsed = JSON.parse(responseText) as IssueCommentResponse;
  if (typeof parsed.id === "number" && Number.isInteger(parsed.id) && parsed.id > 0) {
    return parsed.id;
  }
  throw new Error("GitHub bridge expected issue comment response with numeric id");
}

export function buildExpectedGitHubBridgeState(
  taskId: string,
  statusCommentId: number,
  body: string,
  updatedAt: number,
): TaskGitHubStatusBridgeState {
  return {
    version: "1",
    task_id: taskId,
    status_comment_id: statusCommentId,
    last_rendered_body: body,
    updated_at: updatedAt,
  };
}
