import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  TaskEnvelope,
  TaskMergeRequest,
  TaskPullRequestOpenRequest,
  TaskReviewDecision,
  TaskReviewVerdict,
} from "./types.js";

export type GitHubCommandRunner = (
  args: string[],
  signal?: AbortSignal,
) => Promise<string>;

export interface ApplyGitHubPullRequestActuationOptions {
  contextDir: string;
  runCommand?: GitHubCommandRunner;
  abortSignal?: AbortSignal;
}

export interface GitHubPullRequestActuationResult {
  version: "1";
  provider: "github";
  task_id: string;
  run_id: string;
  pull_request: {
    repository: string;
    number: number;
    url?: string;
  };
  decision: TaskReviewDecision;
  merged: boolean;
  review_submitted: boolean;
  merge_strategy?: string;
  landing_lifecycle: "landed" | "blocked";
  rationale?: string;
  ts: number;
}

export interface GitHubPullRequestOpenResult {
  version: "1";
  provider: "github";
  task_id: string;
  run_id: string;
  issue: {
    repository: string;
    number: number;
    url?: string;
  };
  pull_request: {
    repository: string;
    number: number;
    url: string;
  };
  landing_lifecycle: "review_required";
  rationale?: string;
  ts: number;
}

interface TaskRunContextDoc {
  task_id?: unknown;
  run_id?: unknown;
}

interface TaskDocument extends TaskEnvelope {
  metadata?: Record<string, unknown>;
}

interface GitHubPullRequestViewResponse {
  state?: unknown;
  reviews?: unknown;
}

const SELF_REVIEW_ERROR_FRAGMENT = "Review Can not approve your own pull request";

export async function applyGitHubPullRequestActuation(
  options: ApplyGitHubPullRequestActuationOptions,
): Promise<GitHubPullRequestActuationResult> {
  const runCommand = options.runCommand ?? runGhCommand;
  const runDoc = await readRunContext(options.contextDir);
  const task = await readTaskDocument(options.contextDir);
  ensureGitHubPullRequestTask(task);

  const verdict = await readJsonFile<TaskReviewVerdict>(
    path.join(options.contextDir, "_task", "review-verdict.json"),
  );
  const mergeRequest = await readOptionalJsonFile<TaskMergeRequest>(
    path.join(options.contextDir, "_task", "merge-request.json"),
  );

  const repository = task.repository?.id;
  if (!repository) {
    throw new Error("GitHub pull request actuation requires task.repository.id");
  }
  const pullRequestNumber = parsePullRequestNumber(task.source.external_id);
  const rationale = normalizeOptionalString(verdict.rationale);
  const ts = Date.now();

  if (verdict.decision === "approve" && !mergeRequest) {
    throw new Error(
      "GitHub pull request actuation requires merge-request.json when review verdict is approve",
    );
  }

  if (verdict.decision === "approve") {
    let reviewSubmitted = true;
    let usedSelfReviewFallback = false;
    try {
      await runCommand(
        buildReviewArgs(pullRequestNumber, repository, "approve", rationale),
        options.abortSignal,
      );
    } catch (err) {
      if (!isSelfReviewUnsupportedError(err)) {
        throw err;
      }
      reviewSubmitted = false;
      usedSelfReviewFallback = true;
      await runCommand(
        buildReviewCommentArgs(pullRequestNumber, repository, rationale),
        options.abortSignal,
      );
    }
    const strategy = normalizeOptionalString(mergeRequest?.strategy) ?? "squash";
    await runCommand(
      buildMergeArgs(pullRequestNumber, repository, strategy),
      options.abortSignal,
    );
    const verification = await verifyMergedPullRequest(
      pullRequestNumber,
      repository,
      runCommand,
      options.abortSignal,
    );
    if (
      verification.state !== "MERGED"
      || (!verification.approved && !usedSelfReviewFallback)
    ) {
      throw new Error(
        `GitHub pull request actuation verification failed: state=${verification.state ?? "(missing)"} approved=${verification.approved}`,
      );
    }

    const result: GitHubPullRequestActuationResult = {
      version: "1",
      provider: "github",
      task_id: runDoc.task_id,
      run_id: runDoc.run_id,
      pull_request: {
        repository,
        number: pullRequestNumber,
        url: task.source.url,
      },
      decision: "approve",
      merged: true,
      review_submitted: reviewSubmitted,
      merge_strategy: strategy,
      landing_lifecycle: "landed",
      rationale:
        rationale ??
        normalizeOptionalString(mergeRequest?.rationale) ??
        "PR reviewed, approved, and merged",
      ts,
    };
    await persistActuationOutputs(options.contextDir, result);
    return result;
  }

  await runCommand(
    buildReviewArgs(pullRequestNumber, repository, "changes_requested", rationale),
    options.abortSignal,
  );
  const result: GitHubPullRequestActuationResult = {
    version: "1",
    provider: "github",
    task_id: runDoc.task_id,
    run_id: runDoc.run_id,
    pull_request: {
      repository,
      number: pullRequestNumber,
      url: task.source.url,
    },
    decision: "changes_requested",
    merged: false,
    review_submitted: true,
    landing_lifecycle: "blocked",
    rationale: rationale ?? "Review requested changes",
    ts,
  };
  await persistActuationOutputs(options.contextDir, result);
  return result;
}

export async function applyGitHubPullRequestOpen(
  options: ApplyGitHubPullRequestActuationOptions,
): Promise<GitHubPullRequestOpenResult> {
  const runCommand = options.runCommand ?? runGhCommand;
  const runDoc = await readRunContext(options.contextDir);
  const task = await readTaskDocument(options.contextDir);
  ensureGitHubIssueTask(task);

  const request = await readJsonFile<TaskPullRequestOpenRequest>(
    path.join(options.contextDir, "_task", "pr-open-request.json"),
  );

  const repository = task.repository?.id;
  if (!repository) {
    throw new Error("GitHub pull request open requires task.repository.id");
  }
  const issueNumber = parseIssueNumber(task.source.external_id);
  const createArgs = buildCreatePrArgs(repository, request);
  const createOutput = await runCommand(createArgs, options.abortSignal);
  const pullRequestUrl = parsePullRequestUrl(createOutput);
  const pullRequestNumber = parsePullRequestNumberFromUrl(pullRequestUrl);
  const result: GitHubPullRequestOpenResult = {
    version: "1",
    provider: "github",
    task_id: runDoc.task_id,
    run_id: runDoc.run_id,
    issue: {
      repository,
      number: issueNumber,
      url: task.source.url,
    },
    pull_request: {
      repository,
      number: pullRequestNumber,
      url: pullRequestUrl,
    },
    landing_lifecycle: "review_required",
    rationale:
      normalizeOptionalString(request.rationale) ??
      "PR created and awaiting review",
    ts: Date.now(),
  };
  await persistPullRequestOpenOutputs(options.contextDir, result);
  return result;
}

function buildReviewArgs(
  pullRequestNumber: number,
  repository: string,
  decision: TaskReviewDecision,
  rationale: string | undefined,
): string[] {
  const args = [
    "pr",
    "review",
    String(pullRequestNumber),
    "--repo",
    repository,
  ];
  if (decision === "approve") {
    args.push("--approve");
  } else {
    args.push("--request-changes");
  }
  if (rationale) {
    args.push("--body", rationale);
  }
  return args;
}

function buildMergeArgs(
  pullRequestNumber: number,
  repository: string,
  strategy: string,
): string[] {
  const args = [
    "pr",
    "merge",
    String(pullRequestNumber),
    "--repo",
    repository,
    "--delete-branch",
  ];
  switch (strategy) {
    case "merge":
      args.push("--merge");
      break;
    case "rebase":
      args.push("--rebase");
      break;
    case "squash":
    default:
      args.push("--squash");
      break;
  }
  return args;
}

function buildReviewCommentArgs(
  pullRequestNumber: number,
  repository: string,
  rationale: string | undefined,
): string[] {
  const body = [
    "<!-- roboppi:review-fallback kind=approve-self -->",
    rationale ?? "Approved by the review team.",
    "",
    "GitHub rejected APPROVE because the reviewer is also the pull request author.",
  ].join("\n");
  return [
    "pr",
    "comment",
    String(pullRequestNumber),
    "--repo",
    repository,
    "--body",
    body,
  ];
}

function buildCreatePrArgs(
  repository: string,
  request: TaskPullRequestOpenRequest,
): string[] {
  const args = [
    "pr",
    "create",
    "--repo",
    repository,
    "--title",
    request.title,
    "--body",
    request.body ?? "",
  ];
  if (request.base_ref) {
    args.push("--base", request.base_ref);
  }
  if (request.head_ref) {
    args.push("--head", request.head_ref);
  }
  if (request.draft === true) {
    args.push("--draft");
  }
  for (const label of request.labels ?? []) {
    args.push("--label", label);
  }
  return args;
}

async function verifyMergedPullRequest(
  pullRequestNumber: number,
  repository: string,
  runCommand: GitHubCommandRunner,
  signal?: AbortSignal,
): Promise<{ state?: string; approved: boolean }> {
  const raw = await runCommand(
    ["pr", "view", String(pullRequestNumber), "--repo", repository, "--json", "state,reviews"],
    signal,
  );
  const parsed = JSON.parse(raw) as GitHubPullRequestViewResponse;
  const state = typeof parsed.state === "string" ? parsed.state : undefined;
  const approved =
    Array.isArray(parsed.reviews) &&
    parsed.reviews.some((review) =>
      typeof review === "object" &&
      review !== null &&
      (review as Record<string, unknown>).state === "APPROVED",
    );
  return { state, approved };
}

async function persistActuationOutputs(
  contextDir: string,
  result: GitHubPullRequestActuationResult,
): Promise<void> {
  const taskDir = path.join(contextDir, "_task");
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    path.join(taskDir, "landing.json"),
    JSON.stringify(
      {
        version: "1",
        lifecycle: result.landing_lifecycle,
        rationale: result.rationale,
        metadata:
          result.landing_lifecycle === "landed"
            ? { merge_strategy: result.merge_strategy ?? "squash" }
            : { review_decision: result.decision },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  await appendFile(
    path.join(taskDir, "actuation-results.jsonl"),
    JSON.stringify(result) + "\n",
    "utf-8",
  );
}

async function persistPullRequestOpenOutputs(
  contextDir: string,
  result: GitHubPullRequestOpenResult,
): Promise<void> {
  const taskDir = path.join(contextDir, "_task");
  await mkdir(taskDir, { recursive: true });
  await writeFile(
    path.join(taskDir, "landing.json"),
    JSON.stringify(
      {
        version: "1",
        lifecycle: "review_required",
        rationale: result.rationale,
        metadata: {
          pr_url: result.pull_request.url,
          pr_number: result.pull_request.number,
        },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  await writeFile(
    path.join(taskDir, "pr-open-result.json"),
    JSON.stringify(result, null, 2) + "\n",
    "utf-8",
  );
  await appendFile(
    path.join(taskDir, "actuation-results.jsonl"),
    JSON.stringify(result) + "\n",
    "utf-8",
  );
}

async function readTaskDocument(contextDir: string): Promise<TaskDocument> {
  return readJsonFile<TaskDocument>(path.join(contextDir, "_task", "task.json"));
}

function ensureGitHubPullRequestTask(task: TaskDocument): void {
  if (task.source.kind !== "github_pull_request") {
    throw new Error(
      `GitHub pull request actuation only supports github_pull_request tasks (got "${task.source.kind}")`,
    );
  }
}

function ensureGitHubIssueTask(task: TaskDocument): void {
  if (task.source.kind !== "github_issue") {
    throw new Error(
      `GitHub pull request open only supports github_issue tasks (got "${task.source.kind}")`,
    );
  }
}

function parsePullRequestNumber(externalId: string): number {
  const hashIndex = externalId.lastIndexOf("#");
  if (hashIndex < 0 || hashIndex === externalId.length - 1) {
    throw new Error(`Invalid GitHub pull request external id "${externalId}"`);
  }
  const raw = externalId.slice(hashIndex + 1).trim();
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Invalid GitHub pull request number "${raw}"`);
  }
  return number;
}

function parseIssueNumber(externalId: string): number {
  const hashIndex = externalId.lastIndexOf("#");
  if (hashIndex < 0 || hashIndex === externalId.length - 1) {
    throw new Error(`Invalid GitHub issue external id "${externalId}"`);
  }
  const raw = externalId.slice(hashIndex + 1).trim();
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Invalid GitHub issue number "${raw}"`);
  }
  return number;
}

function parsePullRequestUrl(output: string): string {
  const match = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  if (!match) {
    throw new Error(`Could not parse pull request URL from gh output: ${output.trim()}`);
  }
  return match[0];
}

function parsePullRequestNumberFromUrl(url: string): number {
  const match = url.match(/\/pull\/(\d+)(?:\/)?$/);
  if (!match) {
    throw new Error(`Could not parse pull request number from URL "${url}"`);
  }
  return Number(match[1]);
}

async function readRunContext(
  contextDir: string,
): Promise<{ task_id: string; run_id: string }> {
  const parsed = await readJsonFile<TaskRunContextDoc>(path.join(contextDir, "_task", "run.json"));
  if (typeof parsed.task_id !== "string" || parsed.task_id.trim() === "") {
    throw new Error("GitHub pull request actuation requires _task/run.json task_id");
  }
  if (typeof parsed.run_id !== "string" || parsed.run_id.trim() === "") {
    throw new Error("GitHub pull request actuation requires _task/run.json run_id");
  }
  return {
    task_id: parsed.task_id,
    run_id: parsed.run_id,
  };
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await Bun.file(filePath).text()) as T;
}

async function readOptionalJsonFile<T>(filePath: string): Promise<T | null> {
  const text = await Bun.file(filePath).text().catch(() => "");
  if (text.trim() === "") return null;
  return JSON.parse(text) as T;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isSelfReviewUnsupportedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes(SELF_REVIEW_ERROR_FRAGMENT);
}

async function runGhCommand(args: string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    throw new Error("Aborted");
  }

  const proc = Bun.spawn(["gh", ...args], {
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
      throw new Error(`gh command failed: ${detail}`);
    }
    return stdout;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
