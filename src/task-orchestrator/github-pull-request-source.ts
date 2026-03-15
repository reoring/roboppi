import { createHash } from "node:crypto";
import type {
  ExternalTaskRef,
  GitHubPullRequestTaskSourceConfig,
  TaskEnvelope,
  TaskPriority,
  TaskSource,
  TaskSourceUpdate,
} from "./types.js";
import { runGhApi } from "./github-issue-source.js";

interface GitHubPullRequestListItem {
  number?: unknown;
  html_url?: unknown;
  updated_at?: unknown;
}

interface GitHubPullRequestPayload {
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
  draft?: unknown;
  mergeable?: unknown;
  mergeable_state?: unknown;
  head?: unknown;
  base?: unknown;
}

type GitHubApiRunner = typeof runGhApi;

export class GitHubPullRequestSource implements TaskSource {
  constructor(
    private readonly sourceId: string,
    private readonly config: GitHubPullRequestTaskSourceConfig,
    private readonly runApi: GitHubApiRunner = runGhApi,
  ) {}

  async listCandidates(signal?: AbortSignal): Promise<ExternalTaskRef[]> {
    const response = await this.runApi(
      [
        "--paginate",
        "--slurp",
        `repos/${this.config.repo}/pulls?state=open&per_page=100`,
      ],
      signal,
    );
    const parsed = parseJson(response, `github pulls list for ${this.config.repo}`);
    const items = flattenArrayPayload(parsed);
    const candidates: ExternalTaskRef[] = [];

    for (const itemValue of items) {
      if (!isRecord(itemValue)) continue;
      const item = itemValue as GitHubPullRequestListItem;
      const prNumber = asNumber(item.number, "number");
      candidates.push({
        source_id: this.sourceId,
        external_id: `${this.config.repo}#${prNumber}`,
        revision: typeof item.updated_at === "string" ? item.updated_at : undefined,
        url: typeof item.html_url === "string" ? item.html_url : undefined,
      });
    }

    candidates.sort((a, b) => a.external_id.localeCompare(b.external_id));
    return candidates;
  }

  async fetchEnvelope(ref: ExternalTaskRef, signal?: AbortSignal): Promise<TaskEnvelope> {
    const prNumber = parseNumberFromExternalId(ref.external_id, this.config.repo);
    const response = await this.runApi(
      [`repos/${this.config.repo}/pulls/${prNumber}`],
      signal,
    );
    const parsed = parseJson(
      response,
      `github pull request ${this.config.repo}#${prNumber}`,
    );
    if (!isRecord(parsed)) {
      throw new Error(`GitHub pull request payload for ${this.config.repo}#${prNumber} must be an object`);
    }

    const pr = parsed as GitHubPullRequestPayload;
    const labels = parseLabels(pr.labels);
    const baseRef = parseNestedString(pr.base, "ref");
    if (this.config.base_branches && this.config.base_branches.length > 0) {
      if (!baseRef || !this.config.base_branches.includes(baseRef)) {
        throw new Error(
          `Pull request ${this.config.repo}#${prNumber} base ref "${baseRef ?? "(missing)"}" is not in allowed base_branches`,
        );
      }
    }
    const title = asNonEmptyString(pr.title, "title");
    const body = typeof pr.body === "string" ? pr.body : "";
    const requestedBy = parseUserLogin(pr.user);
    const assignees = parseAssignees(pr.assignees);
    const milestone = parseMilestone(pr.milestone);
    const state = typeof pr.state === "string" ? pr.state : "open";
    const headRef = parseNestedString(pr.head, "ref");
    const headSha = parseNestedString(pr.head, "sha");
    const draft = pr.draft === true;

    return {
      version: "1",
      task_id: `github:pull_request:${this.config.repo}#${prNumber}`,
      source: {
        kind: "github_pull_request",
        system_id: "github",
        external_id: `${this.config.repo}#${prNumber}`,
        url: typeof pr.html_url === "string" ? pr.html_url : ref.url,
        revision: computePullRequestRevision({
          repo: this.config.repo,
          pullRequestNumber: prNumber,
          title,
          body,
          labels,
          state,
          requestedBy,
          assignees,
          milestone,
          draft,
          baseRef,
          headRef,
          headSha,
        }),
      },
      title,
      body,
      labels,
      priority: inferPriority(labels),
      repository: {
        id: this.config.repo,
        local_path: this.config.local_path ?? this.config.workspace_path,
        default_branch: baseRef ?? undefined,
      },
      requested_action: "review",
      requested_by: requestedBy,
      metadata: {
        source_id: this.sourceId,
        state,
        draft,
        base_ref: baseRef,
        head_ref: headRef,
        head_sha: headSha,
        mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : undefined,
        mergeable_state:
          typeof pr.mergeable_state === "string" ? pr.mergeable_state : undefined,
        assignees,
        milestone,
        comments: typeof pr.comments === "number" ? pr.comments : undefined,
        author_association:
          typeof pr.author_association === "string"
            ? pr.author_association
            : undefined,
      },
      timestamps: {
        created_at: parseTimestamp(pr.created_at, "created_at"),
        updated_at: parseTimestamp(pr.updated_at, "updated_at"),
      },
    };
  }

  async ack(update: TaskSourceUpdate, signal?: AbortSignal): Promise<void> {
    const prNumber = parseNumberFromTaskId(update.task_id, this.config.repo);
    const body = buildAckComment(update);
    await this.runApi(
      [
        "-X",
        "POST",
        `repos/${this.config.repo}/issues/${prNumber}/comments`,
        "-f",
        `body=${body}`,
      ],
      signal,
    );
  }
}

function computePullRequestRevision(input: {
  repo: string;
  pullRequestNumber: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  requestedBy?: string;
  assignees?: string[];
  milestone?: string;
  draft: boolean;
  baseRef?: string;
  headRef?: string;
  headSha?: string;
}): string {
  const payload = JSON.stringify({
    repo: input.repo,
    pull_request_number: input.pullRequestNumber,
    title: input.title,
    body: input.body,
    labels: [...input.labels].sort(),
    state: input.state,
    requested_by: input.requestedBy ?? null,
    assignees: [...(input.assignees ?? [])].sort(),
    milestone: input.milestone ?? null,
    draft: input.draft,
    base_ref: input.baseRef ?? null,
    head_ref: input.headRef ?? null,
    head_sha: input.headSha ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error(`GitHub payload is missing valid numeric "${field}"`);
}

function parseNumberFromExternalId(externalId: string, expectedRepo: string): number {
  const [repo, issuePart] = externalId.split("#");
  if (repo !== expectedRepo || issuePart === undefined) {
    throw new Error(
      `External id "${externalId}" does not match configured repo "${expectedRepo}"`,
    );
  }
  return asNumber(Number(issuePart), "external_id");
}

function parseNumberFromTaskId(taskId: string, expectedRepo: string): number {
  const prefix = "github:pull_request:";
  if (!taskId.startsWith(prefix)) {
    throw new Error(`Task id "${taskId}" is not a GitHub pull request task id`);
  }
  return parseNumberFromExternalId(taskId.slice(prefix.length), expectedRepo);
}

function parseTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`GitHub payload is missing "${field}"`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`GitHub payload has invalid "${field}" timestamp: ${value}`);
  }
  return parsed;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`GitHub payload is missing non-empty "${field}"`);
  }
  return value;
}

function parseLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (isRecord(entry) && typeof entry["name"] === "string") {
        return [entry["name"]];
      }
      return [];
    })
    .filter((label) => label.trim() !== "");
}

function parseUserLogin(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value["login"] === "string" ? value["login"] : undefined;
}

function parseAssignees(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const assignees = value
    .flatMap((entry) => (isRecord(entry) && typeof entry["login"] === "string" ? [entry["login"]] : []))
    .filter((login) => login.trim() !== "");
  return assignees.length > 0 ? assignees : undefined;
}

function parseMilestone(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value["title"] === "string" ? value["title"] : undefined;
}

function parseNestedString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value[key] === "string" ? value[key] : undefined;
}

function inferPriority(labels: string[]): TaskPriority {
  if (labels.includes("priority:urgent")) return "urgent";
  if (labels.includes("priority:high")) return "high";
  if (labels.includes("priority:low")) return "low";
  return "normal";
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
      return "review completed and is waiting for human review";
    case "ready_to_land":
      return "pull request review completed and is ready to land";
    case "landed":
      return "pull request changes have been landed";
    case "closed_without_landing":
      return "pull request task closed without landing changes";
    case "failed":
      return "review workflow execution failed";
    case "blocked":
      return "review workflow execution is blocked";
    case "waiting_for_input":
      return "review workflow is waiting for input";
    case "running":
      return "review workflow is running";
    case "preparing":
      return "review workflow is preparing the run";
    case "queued":
    default:
      return "pull request accepted by Roboppi";
  }
}
