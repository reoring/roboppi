import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  TaskClarificationRequest,
  TaskExternalPublishRequest,
  TaskIntentKind,
  TaskIntentRecord,
  TaskLandingDirective,
  TaskLandingLifecycle,
  TaskMergeRequest,
  TaskPullRequestOpenRequest,
  TaskReviewDecision,
  TaskReviewVerdict,
  TaskRunId,
} from "./types.js";
import {
  authorizeTaskIntentMember,
  readTaskIntentPolicy,
} from "./intent-policy.js";

const VALID_REVIEW_DECISIONS = new Set<TaskReviewDecision>([
  "approve",
  "changes_requested",
]);

const VALID_LANDING_LIFECYCLES = new Set<TaskLandingLifecycle>([
  "waiting_for_input",
  "review_required",
  "blocked",
  "ready_to_land",
  "landed",
  "closed_without_landing",
]);

export interface EmitTaskIntentOptions {
  contextDir: string;
  kind: Exclude<TaskIntentKind, "activity">;
  memberId: string;
  payload: Record<string, unknown>;
  ts?: number;
}

interface TaskRunContextDoc {
  task_id?: unknown;
  run_id?: unknown;
}

export class TaskIntentAuthorizationError extends Error {
  readonly record: TaskIntentRecord;

  constructor(message: string, record: TaskIntentRecord) {
    super(message);
    this.name = "TaskIntentAuthorizationError";
    this.record = record;
  }
}

export async function emitTaskIntent(
  options: EmitTaskIntentOptions,
): Promise<TaskIntentRecord> {
  const runDoc = await readRunContext(options.contextDir);
  const policy = await readTaskIntentPolicy(options.contextDir);
  const authorization = authorizeTaskIntentMember(
    policy,
    options.kind,
    options.memberId,
  );

  const record: TaskIntentRecord = {
    version: "1",
    intent_id: randomUUID(),
    task_id: runDoc.task_id,
    run_id: runDoc.run_id,
    ts: options.ts ?? Date.now(),
    kind: options.kind,
    member_id: options.memberId,
    member_roles: authorization.memberRoles,
    payload: options.payload,
    accepted: authorization.accepted,
    rejection_reason: authorization.rejectionReason,
  };

  await appendIntentRecord(options.contextDir, record);

  if (!authorization.accepted) {
    throw new TaskIntentAuthorizationError(
      authorization.rejectionReason ?? "intent was rejected by task policy",
      record,
    );
  }

  await materializeAcceptedIntent(options.contextDir, record);
  return record;
}

export async function readTaskIntentRecords(
  contextDir: string,
): Promise<TaskIntentRecord[]> {
  const text = await Bun.file(intentsLogPath(contextDir)).text().catch(() => "");
  if (text.trim() === "") return [];

  const records: TaskIntentRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    records.push(JSON.parse(trimmed) as TaskIntentRecord);
  }
  return records.sort((a, b) => a.ts - b.ts);
}

export function intentsLogPath(contextDir: string): string {
  return path.join(contextDir, "_task", "intents.jsonl");
}

export function reviewVerdictPath(contextDir: string): string {
  return path.join(contextDir, "_task", "review-verdict.json");
}

export function mergeRequestPath(contextDir: string): string {
  return path.join(contextDir, "_task", "merge-request.json");
}

export function clarificationRequestPath(contextDir: string): string {
  return path.join(contextDir, "_task", "clarification-request.json");
}

export function pullRequestOpenRequestPath(contextDir: string): string {
  return path.join(contextDir, "_task", "pr-open-request.json");
}

export function externalPublishRequestPath(contextDir: string): string {
  return path.join(contextDir, "_task", "publish-summary.json");
}

async function appendIntentRecord(
  contextDir: string,
  record: TaskIntentRecord,
): Promise<void> {
  const filePath = intentsLogPath(contextDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(record) + "\n");
}

async function materializeAcceptedIntent(
  contextDir: string,
  record: TaskIntentRecord,
): Promise<void> {
  switch (record.kind) {
    case "review_verdict":
      await writeJson(
        reviewVerdictPath(contextDir),
        toReviewVerdict(record),
      );
      return;
    case "landing_decision":
      await writeJson(
        path.join(contextDir, "_task", "landing.json"),
        toLandingDirective(record),
      );
      return;
    case "clarification_request": {
      const clarificationRequest = toClarificationRequest(record);
      await writeJson(
        clarificationRequestPath(contextDir),
        clarificationRequest,
      );
      await writeJson(
        path.join(contextDir, "_task", "landing.json"),
        toClarificationLandingDirective(clarificationRequest),
      );
      return;
    }
    case "merge_request":
      await writeJson(
        mergeRequestPath(contextDir),
        toMergeRequest(record),
      );
      return;
    case "pr_open_request":
      await writeJson(
        pullRequestOpenRequestPath(contextDir),
        toPullRequestOpenRequest(record),
      );
      return;
    case "external_publish":
      await writeJson(
        externalPublishRequestPath(contextDir),
        toExternalPublishRequest(record),
      );
      return;
  }
}

function toReviewVerdict(record: TaskIntentRecord): TaskReviewVerdict {
  const decision = record.payload["decision"];
  if (typeof decision !== "string" || !VALID_REVIEW_DECISIONS.has(decision as TaskReviewDecision)) {
    throw new Error(
      `review_verdict intent must contain decision=${[...VALID_REVIEW_DECISIONS].join("|")}`,
    );
  }
  const rationale = optionalNonEmptyString(
    record.payload["rationale"] ?? record.payload["message"],
    "review_verdict.rationale",
  );
  const metadata = optionalObject(record.payload["metadata"], "review_verdict.metadata");

  return {
    version: "1",
    decision: decision as TaskReviewDecision,
    rationale,
    metadata,
    member_id: record.member_id,
    ts: record.ts,
    source: "intent",
  };
}

function toLandingDirective(record: TaskIntentRecord): TaskLandingDirective {
  const lifecycle = record.payload["lifecycle"];
  if (
    typeof lifecycle !== "string" ||
    !VALID_LANDING_LIFECYCLES.has(lifecycle as TaskLandingLifecycle)
  ) {
    throw new Error(
      `landing_decision intent must contain lifecycle=${[...VALID_LANDING_LIFECYCLES].join("|")}`,
    );
  }
  const rationale = optionalNonEmptyString(
    record.payload["rationale"],
    "landing_decision.rationale",
  );
  const metadata = optionalObject(record.payload["metadata"], "landing_decision.metadata");

  return {
    version: "1",
    lifecycle: lifecycle as TaskLandingLifecycle,
    rationale,
    metadata,
  };
}

function toMergeRequest(record: TaskIntentRecord): TaskMergeRequest {
  const strategy = optionalNonEmptyString(record.payload["strategy"], "merge_request.strategy");
  const rationale = optionalNonEmptyString(record.payload["rationale"], "merge_request.rationale");
  const metadata = optionalObject(record.payload["metadata"], "merge_request.metadata");
  return {
    version: "1",
    strategy,
    rationale,
    metadata,
    member_id: record.member_id,
    ts: record.ts,
    source: "intent",
  };
}

function toClarificationRequest(
  record: TaskIntentRecord,
): TaskClarificationRequest {
  const summary = optionalNonEmptyString(
    record.payload["summary"],
    "clarification_request.summary",
  );
  if (!summary) {
    throw new Error("clarification_request.summary must be a non-empty string");
  }
  const questions = optionalStringArray(
    record.payload["questions"],
    "clarification_request.questions",
  );
  const missingFields = optionalStringArray(
    record.payload["missing_fields"],
    "clarification_request.missing_fields",
  );
  const resumeHints = optionalStringArray(
    record.payload["resume_hints"],
    "clarification_request.resume_hints",
  );
  const severity = optionalClarificationSeverity(
    record.payload["severity"],
    "clarification_request.severity",
  );
  const metadata = optionalObject(
    record.payload["metadata"],
    "clarification_request.metadata",
  );

  return {
    version: "1",
    summary,
    questions,
    missing_fields: missingFields,
    resume_hints: resumeHints,
    severity,
    metadata,
    member_id: record.member_id,
    ts: record.ts,
    source: "intent",
  };
}

function toClarificationLandingDirective(
  request: TaskClarificationRequest,
): TaskLandingDirective {
  return {
    version: "1",
    lifecycle: "waiting_for_input",
    rationale: request.summary,
    metadata: {
      clarification_summary: request.summary,
      clarification_questions: request.questions,
      clarification_missing_fields: request.missing_fields,
      clarification_resume_hints: request.resume_hints,
      clarification_severity: request.severity,
      ...(request.metadata ?? {}),
    },
  };
}

function toPullRequestOpenRequest(record: TaskIntentRecord): TaskPullRequestOpenRequest {
  const title = optionalNonEmptyString(
    record.payload["title"] ?? record.payload["pr_title"],
    "pr_open_request.title",
  );
  if (!title) {
    throw new Error("pr_open_request.title must be a non-empty string");
  }
  const body = optionalString(
    record.payload["body"] ?? record.payload["pr_body"],
    "pr_open_request.body",
  );
  const baseRef = optionalString(record.payload["base_ref"], "pr_open_request.base_ref");
  const headRef = optionalString(record.payload["head_ref"], "pr_open_request.head_ref");
  const rationale = optionalString(record.payload["rationale"], "pr_open_request.rationale");
  const metadata = optionalObject(record.payload["metadata"], "pr_open_request.metadata");
  const labels = optionalStringArray(record.payload["labels"], "pr_open_request.labels");
  const draft = optionalBoolean(record.payload["draft"], "pr_open_request.draft");

  return {
    version: "1",
    title,
    body,
    base_ref: baseRef,
    head_ref: headRef,
    labels,
    draft,
    rationale,
    metadata,
    member_id: record.member_id,
    ts: record.ts,
    source: "intent",
  };
}

function toExternalPublishRequest(record: TaskIntentRecord): TaskExternalPublishRequest {
  const summary = optionalNonEmptyString(
    record.payload["summary"],
    "external_publish.summary",
  );
  const metadata = optionalObject(
    record.payload["metadata"],
    "external_publish.metadata",
  );
  return {
    version: "1",
    summary,
    metadata,
    member_id: record.member_id,
    ts: record.ts,
    source: "intent",
  };
}

function optionalNonEmptyString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string when present`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string when present`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be an array of strings when present`);
  }
  return [...value];
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean when present`);
  }
  return value;
}

function optionalClarificationSeverity(
  value: unknown,
  field: string,
): TaskClarificationRequest["severity"] {
  if (value === undefined || value === null) return undefined;
  if (value === "low" || value === "normal" || value === "high") {
    return value;
  }
  throw new Error(`${field} must be one of: low, normal, high`);
}

function optionalObject(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object when present`);
  }
  return value as Record<string, unknown>;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

async function readRunContext(
  contextDir: string,
): Promise<{ task_id: string; run_id: TaskRunId }> {
  const filePath = path.join(contextDir, "_task", "run.json");
  const parsed = JSON.parse(await Bun.file(filePath).text()) as TaskRunContextDoc;
  if (typeof parsed.task_id !== "string" || parsed.task_id.trim() === "") {
    throw new Error(`Invalid task context: missing task_id in ${filePath}`);
  }
  if (typeof parsed.run_id !== "string" || parsed.run_id.trim() === "") {
    throw new Error(`Invalid task context: missing run_id in ${filePath}`);
  }
  return {
    task_id: parsed.task_id,
    run_id: parsed.run_id,
  };
}
