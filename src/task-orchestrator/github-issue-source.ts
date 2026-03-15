import { createHash } from "node:crypto";
import type {
  ExternalTaskRef,
  GitHubIssueTaskSourceConfig,
  TaskEnvelope,
  TaskPriority,
  TaskSource,
  TaskSourceUpdate,
} from "./types.js";

interface GitHubIssueListItem {
  number?: unknown;
  html_url?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
  title?: unknown;
  pull_request?: unknown;
}

interface GitHubIssuePayload {
  number?: unknown;
  html_url?: unknown;
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  user?: unknown;
  assignees?: unknown;
  milestone?: unknown;
  comments?: unknown;
  author_association?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  state?: unknown;
}

interface GitHubIssueCommentPayload {
  id?: unknown;
  body?: unknown;
  updated_at?: unknown;
  user?: unknown;
}

export type GitHubApiRunner = (
  args: string[],
  signal?: AbortSignal,
) => Promise<string>;

export class GitHubIssueSource implements TaskSource {
  constructor(
    private readonly sourceId: string,
    private readonly config: GitHubIssueTaskSourceConfig,
    private readonly runApi: GitHubApiRunner = runGhApi,
  ) {}

  async listCandidates(signal?: AbortSignal): Promise<ExternalTaskRef[]> {
    const response = await this.runApi(
      [
        "--paginate",
        "--slurp",
        `repos/${this.config.repo}/issues?state=open&per_page=100${labelsQuery(this.config.labels)}`,
      ],
      signal,
    );
    const parsed = parseJson(response, `github issues list for ${this.config.repo}`);
    const items = flattenArrayPayload(parsed);
    const candidates: ExternalTaskRef[] = [];

    for (const itemValue of items) {
      if (!isRecord(itemValue)) continue;
      const item = itemValue as GitHubIssueListItem;
      if (item.pull_request !== undefined) continue;
      const issueNumber = asIssueNumber(item.number);
      const externalId = `${this.config.repo}#${issueNumber}`;
      candidates.push({
        source_id: this.sourceId,
        external_id: externalId,
        revision: asRevision(item.updated_at, item.created_at),
        url: typeof item.html_url === "string" ? item.html_url : undefined,
      });
    }

    candidates.sort((a, b) => a.external_id.localeCompare(b.external_id));
    return candidates;
  }

  async fetchEnvelope(
    ref: ExternalTaskRef,
    signal?: AbortSignal,
  ): Promise<TaskEnvelope> {
    const issueNumber = parseIssueNumber(ref.external_id, this.config.repo);
    const response = await this.runApi(
      [`repos/${this.config.repo}/issues/${issueNumber}`],
      signal,
    );
    const parsed = parseJson(
      response,
      `github issue ${this.config.repo}#${issueNumber}`,
    );
    if (!isRecord(parsed)) {
      throw new Error(`GitHub issue payload for ${this.config.repo}#${issueNumber} must be an object`);
    }

    const issue = parsed as GitHubIssuePayload;
    const labels = parseLabels(issue.labels);
    const createdAt = parseTimestamp(issue.created_at, "created_at");
    const updatedAt = parseTimestamp(issue.updated_at, "updated_at");
    const commentSignal = await this.fetchHumanCommentSignal(issueNumber, signal);

    return {
      version: "1",
      task_id: `github:issue:${this.config.repo}#${issueNumber}`,
      source: {
        kind: "github_issue",
        system_id: "github",
        external_id: `${this.config.repo}#${issueNumber}`,
        url: typeof issue.html_url === "string" ? issue.html_url : ref.url,
        revision: computeIssueRevision({
          repo: this.config.repo,
          issueNumber,
          title: asNonEmptyString(issue.title, "title"),
          body: typeof issue.body === "string" ? issue.body : "",
          labels,
          state: typeof issue.state === "string" ? issue.state : "open",
          requestedBy: parseUserLogin(issue.user),
          assignees: parseAssignees(issue.assignees),
          milestone: parseMilestone(issue.milestone),
          lastHumanCommentId: commentSignal.lastCommentId,
          lastHumanCommentUpdatedAt: commentSignal.lastCommentUpdatedAt,
        }),
      },
      title: asNonEmptyString(issue.title, "title"),
      body: typeof issue.body === "string" ? issue.body : "",
      labels,
      priority: inferPriority(labels),
      repository: {
        id: this.config.repo,
        local_path: this.config.local_path ?? this.config.workspace_path,
      },
      requested_action: "implement",
      requested_by: parseUserLogin(issue.user),
      metadata: {
        source_id: this.sourceId,
        state: typeof issue.state === "string" ? issue.state : undefined,
        assignees: parseAssignees(issue.assignees),
        milestone: parseMilestone(issue.milestone),
        comments: typeof issue.comments === "number" ? issue.comments : undefined,
        last_human_comment_id: commentSignal.lastCommentId,
        last_human_comment_at: commentSignal.lastCommentUpdatedAt,
        author_association:
          typeof issue.author_association === "string"
            ? issue.author_association
            : undefined,
      },
      timestamps: {
        created_at: createdAt,
        updated_at: updatedAt,
      },
    };
  }

  async ack(update: TaskSourceUpdate, signal?: AbortSignal): Promise<void> {
    const issueNumber = parseIssueNumberFromTaskId(update.task_id, this.config.repo);
    const body = buildAckComment(update);
    await this.runApi(
      [
        "-X",
        "POST",
        `repos/${this.config.repo}/issues/${issueNumber}/comments`,
        "-f",
        `body=${body}`,
      ],
      signal,
    );
  }

  private async fetchHumanCommentSignal(
    issueNumber: number,
    signal?: AbortSignal,
  ): Promise<{
    lastCommentId?: number;
    lastCommentUpdatedAt?: string;
  }> {
    const response = await this.runApi(
      [`repos/${this.config.repo}/issues/${issueNumber}/comments?per_page=100`],
      signal,
    );
    const parsed = parseJson(
      response,
      `github issue comments ${this.config.repo}#${issueNumber}`,
    );
    if (!Array.isArray(parsed)) {
      throw new Error(
        `GitHub issue comments payload for ${this.config.repo}#${issueNumber} must be an array`,
      );
    }

    let lastCommentId: number | undefined;
    let lastCommentUpdatedAt: string | undefined;
    for (const commentValue of parsed) {
      if (!isRecord(commentValue)) continue;
      const comment = commentValue as GitHubIssueCommentPayload;
      if (!isHumanSignalComment(comment)) continue;
      const commentId = parseOptionalPositiveInteger(comment.id);
      const commentUpdatedAt = parseOptionalTimestampString(comment.updated_at);
      if (commentId === undefined || commentUpdatedAt === undefined) continue;
      if (
        lastCommentUpdatedAt === undefined
        || Date.parse(commentUpdatedAt) >= Date.parse(lastCommentUpdatedAt)
      ) {
        lastCommentId = commentId;
        lastCommentUpdatedAt = commentUpdatedAt;
      }
    }

    return {
      lastCommentId,
      lastCommentUpdatedAt,
    };
  }
}

function computeIssueRevision(input: {
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  requestedBy?: string;
  assignees?: string[];
  milestone?: string;
  lastHumanCommentId?: number;
  lastHumanCommentUpdatedAt?: string;
}): string {
  const payload = JSON.stringify({
    repo: input.repo,
    issue_number: input.issueNumber,
    title: input.title,
    body: input.body,
    labels: [...input.labels].sort(),
    state: input.state,
    requested_by: input.requestedBy ?? null,
    assignees: [...(input.assignees ?? [])].sort(),
    milestone: input.milestone ?? null,
    last_human_comment_id: input.lastHumanCommentId ?? null,
    last_human_comment_updated_at: input.lastHumanCommentUpdatedAt ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export async function runGhApi(args: string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    throw new Error("Aborted");
  }

  const proc = Bun.spawn(["gh", "api", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const onAbort = () => {
    try {
      proc.kill("SIGTERM");
    } catch {
      // best-effort
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `exit=${exitCode}`;
      throw new Error(`gh api failed: ${detail}`);
    }
    return stdout;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function labelsQuery(labels: string[] | undefined): string {
  if (!labels || labels.length === 0) return "";
  return `&labels=${encodeURIComponent(labels.join(","))}`;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `Invalid JSON from ${label}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function flattenArrayPayload(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected GitHub API response to be an array");
  }
  if (value.length === 0) return [];
  if (value.every((entry) => Array.isArray(entry))) {
    return (value as unknown[]).flatMap((entry) =>
      Array.isArray(entry) ? entry : [entry],
    );
  }
  return value;
}

function parseIssueNumber(externalId: string, expectedRepo: string): number {
  const [repo, issuePart] = externalId.split("#");
  if (repo !== expectedRepo || issuePart === undefined) {
    throw new Error(
      `External issue id "${externalId}" does not match configured repo "${expectedRepo}"`,
    );
  }
  const parsed = Number(issuePart);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid GitHub issue number in "${externalId}"`);
  }
  return parsed;
}

function parseIssueNumberFromTaskId(taskId: string, expectedRepo: string): number {
  const prefix = "github:issue:";
  if (!taskId.startsWith(prefix)) {
    throw new Error(`Task id "${taskId}" is not a GitHub issue task id`);
  }
  return parseIssueNumber(taskId.slice(prefix.length), expectedRepo);
}

function asIssueNumber(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error(`GitHub issue payload is missing a valid numeric "number"`);
}

function buildAckComment(update: TaskSourceUpdate): string {
  const state = update.state ?? "queued";
  const status = describeState(state);
  const lines = [
    `<!-- roboppi:task-ack task_id=${update.task_id}${update.run_id ? ` run_id=${update.run_id}` : ""} state=${state} -->`,
    `Roboppi task update: ${status}`,
    "",
    `- Task: \`${update.task_id}\``,
    `- State: \`${state}\``,
  ];

  if (update.run_id) {
    lines.push(`- Run: \`${update.run_id}\``);
  }
  if (update.note && update.note.trim() !== "") {
    lines.push(`- Note: ${update.note.trim()}`);
  }

  return lines.join("\n");
}

function describeState(state: TaskSourceUpdate["state"]): string {
  switch (state) {
    case "review_required":
      return "implementation completed and is waiting for human review";
    case "ready_to_land":
      return "implementation completed and is ready to land";
    case "landed":
      return "changes have been landed";
    case "closed_without_landing":
      return "task closed without landing changes";
    case "failed":
      return "workflow execution failed";
    case "blocked":
      return "workflow execution is blocked";
    case "waiting_for_input":
      return "workflow is waiting for input";
    case "running":
      return "workflow is running";
    case "preparing":
      return "workflow is preparing the run";
    case "queued":
    default:
      return "task accepted by Roboppi";
  }
}

function asRevision(updatedAt: unknown, createdAt: unknown): string {
  if (typeof updatedAt === "string" && updatedAt.length > 0) {
    return updatedAt;
  }
  if (typeof createdAt === "string" && createdAt.length > 0) {
    return createdAt;
  }
  return String(Date.now());
}

function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GitHub issue payload is missing "${field}"`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`GitHub issue payload has invalid "${field}" timestamp: ${value}`);
  }
  return parsed;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`GitHub issue payload is missing non-empty "${field}"`);
  }
  return value;
}

function parseLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      labels.push(item);
      continue;
    }
    if (isRecord(item) && typeof item.name === "string" && item.name.length > 0) {
      labels.push(item.name);
    }
  }
  return labels;
}

function inferPriority(labels: string[]): TaskPriority {
  const normalized = new Set(labels.map((label) => label.toLowerCase()));
  if (normalized.has("priority:urgent") || normalized.has("urgent")) return "urgent";
  if (normalized.has("priority:high") || normalized.has("high-priority")) return "high";
  if (normalized.has("priority:low") || normalized.has("low-priority")) return "low";
  return "normal";
}

function parseUserLogin(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.login === "string" && value.login.length > 0
    ? value.login
    : undefined;
}

function parseAssignees(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const assignees = value
    .map((entry) =>
      isRecord(entry) && typeof entry.login === "string" ? entry.login : undefined,
    )
    .filter((entry): entry is string => entry !== undefined);
  return assignees.length > 0 ? assignees : undefined;
}

function parseMilestone(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.title === "string" && value.title.length > 0) {
    return value.title;
  }
  return undefined;
}

function isHumanSignalComment(comment: GitHubIssueCommentPayload): boolean {
  const body = typeof comment.body === "string" ? comment.body : "";
  if (body.includes("<!-- roboppi:")) {
    return false;
  }
  return parseUserLogin(comment.user) !== undefined || body.trim() !== "";
}

function parseOptionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return undefined;
}

function parseOptionalTimestampString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
