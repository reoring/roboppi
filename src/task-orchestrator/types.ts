import type { Timestamp, UUID } from "../types/index.js";

export type TaskId = string;
export type TaskRunId = UUID;
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type TaskLifecycleState =
  | "queued"
  | "preparing"
  | "running"
  | "waiting_for_input"
  | "review_required"
  | "blocked"
  | "failed"
  | "ready_to_land"
  | "landed"
  | "closed_without_landing";
export type TaskRunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type TaskWorkspaceMode = "shared" | "worktree";
export type TaskExecutionPriorityClass = "interactive" | "normal" | "background";
export type TaskLandingMode = "disabled" | "manual";
export type TaskLandingLifecycle =
  | "waiting_for_input"
  | "review_required"
  | "blocked"
  | "ready_to_land"
  | "landed"
  | "closed_without_landing";

export interface ExternalTaskRef {
  source_id: string;
  external_id: string;
  revision?: string;
  url?: string;
}

export interface TaskSourceRef {
  kind: string;
  system_id: string;
  external_id: string;
  url?: string;
  revision?: string;
}

export interface TaskSourceUpdate {
  task_id: TaskId;
  run_id?: TaskRunId;
  state?: TaskLifecycleState;
  note?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskSource {
  listCandidates(signal?: AbortSignal): Promise<ExternalTaskRef[]>;
  fetchEnvelope(ref: ExternalTaskRef, signal?: AbortSignal): Promise<TaskEnvelope>;
  ack?(update: TaskSourceUpdate, signal?: AbortSignal): Promise<void>;
}

export interface TaskRepositoryRef {
  id: string;
  default_branch?: string;
  local_path?: string;
}

export interface TaskEnvelope {
  version: "1";
  task_id: TaskId;
  source: TaskSourceRef;
  title: string;
  body: string;
  labels: string[];
  priority: TaskPriority;
  repository?: TaskRepositoryRef;
  requested_action: string;
  requested_by?: string;
  metadata?: Record<string, unknown>;
  timestamps: {
    created_at: Timestamp;
    updated_at: Timestamp;
  };
}

export interface TaskExecutionPlan {
  workflow: string;
  agentsFiles?: string[];
  workspaceMode: TaskWorkspaceMode;
  worktree?: {
    baseRef?: string;
    branchNameTemplate: string;
  };
  env: Record<string, string>;
  priorityClass: TaskExecutionPriorityClass;
  managementEnabled?: boolean;
}

export interface TaskRoutingDecision {
  version: "1";
  task_id: TaskId;
  route_id: string;
  decided_at: Timestamp;
  matched_on: string[];
  plan: TaskExecutionPlan;
}

export interface GitHubIssueTaskSourceConfig {
  type: "github_issue";
  repo: string;
  labels?: string[];
  local_path?: string;
  workspace_path?: string;
  poll_every?: string;
}

export interface GitHubPullRequestTaskSourceConfig {
  type: "github_pull_request";
  repo: string;
  labels?: string[];
  base_branches?: string[];
  local_path?: string;
  workspace_path?: string;
  poll_every?: string;
}

export interface FileInboxTaskSourceConfig {
  type: "file_inbox";
  path: string;
  pattern?: string;
  poll_every?: string;
}

export type TaskSourceConfig =
  | GitHubIssueTaskSourceConfig
  | GitHubPullRequestTaskSourceConfig
  | FileInboxTaskSourceConfig;

export interface TaskRouteMatch {
  source?: string;
  repository?: string;
  requested_action?: string;
  labels_any?: string[];
  labels_all?: string[];
}

export interface TaskRouteDef {
  when?: TaskRouteMatch;
  workflow: string;
  agents_files?: string[];
  workspace_mode: TaskWorkspaceMode;
  branch_name?: string;
  base_ref?: string;
  env?: Record<string, string>;
  priority_class?: TaskExecutionPriorityClass;
  management?: {
    enabled?: boolean;
  };
}

export interface TaskLandingConfig {
  mode: TaskLandingMode;
}

export interface TaskClarificationConfig {
  enabled: boolean;
  max_round_trips: number;
  reminder_after?: string;
  block_after?: string;
}

export interface TaskOrchestratorRuntimeConfig {
  poll_every: string;
  max_active_instances?: number;
}

export interface TaskOrchestratorGitHubActivityConfig {
  enabled: boolean;
}

export interface TaskOrchestratorActivityConfig {
  github: TaskOrchestratorGitHubActivityConfig;
}

export interface TaskOrchestratorConfig {
  name: string;
  version: "1";
  state_dir: string;
  runtime: TaskOrchestratorRuntimeConfig;
  clarification: TaskClarificationConfig;
  activity: TaskOrchestratorActivityConfig;
  sources: Record<string, TaskSourceConfig>;
  routes: Record<string, TaskRouteDef>;
  landing: TaskLandingConfig;
}

export interface TaskRecordState {
  version: "1";
  task_id: TaskId;
  lifecycle: TaskLifecycleState;
  created_at: Timestamp;
  updated_at: Timestamp;
  last_transition_at: Timestamp;
  active_run_id: TaskRunId | null;
  latest_run_id: TaskRunId | null;
  last_completed_run_id: TaskRunId | null;
  run_count: number;
  source_revision: string | null;
}

export interface TaskWaitingState {
  version: "1";
  task_id: TaskId;
  status: "waiting" | "resumed" | "blocked";
  round_trip_count: number;
  waiting_started_at: Timestamp;
  updated_at: Timestamp;
  last_source_revision: string | null;
  last_human_signal_at: Timestamp | null;
  reminder_due_at: Timestamp | null;
  reminder_sent_at: Timestamp | null;
  block_after_at: Timestamp | null;
  resumed_at: Timestamp | null;
  blocked_at: Timestamp | null;
}

export interface TaskRunArtifacts {
  plan?: string;
  summary?: string;
  workflow_result?: string;
  landing?: string;
  links?: string;
}

export interface TaskLandingDirective {
  version: "1";
  lifecycle: TaskLandingLifecycle;
  rationale?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskLandingDecision {
  version: "1";
  lifecycle: TaskLifecycleState;
  rationale?: string;
  metadata?: Record<string, unknown>;
  source: "default" | "workflow" | "ignored" | "invalid" | "linked_task";
}

export interface TaskRunRecord {
  version: "1";
  task_id: TaskId;
  run_id: TaskRunId;
  attempt: number;
  status: TaskRunStatus;
  workflow?: string;
  workflow_id: string | null;
  workflow_status: string | null;
  error: string | null;
  source_revision: string | null;
  artifacts: TaskRunArtifacts;
  created_at: Timestamp;
  updated_at: Timestamp;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
}

export interface TaskRunSummary {
  version: "1";
  task_id: TaskId;
  run_id: TaskRunId;
  generated_at: Timestamp;
  final_lifecycle: TaskLifecycleState;
  workflow_status?: string;
  rationale?: string;
  metadata?: Record<string, unknown>;
}

export interface ActiveTaskEntry {
  task_id: TaskId;
  run_id: TaskRunId;
  lifecycle: TaskLifecycleState;
  updated_at: Timestamp;
}

export type TaskActivityKind =
  | "progress"
  | "blocker"
  | "waiting_for_input"
  | "review_required"
  | "ready_to_land"
  | "landed"
  | "commit_created"
  | "push_completed";

export type TaskIntentKind =
  | "activity"
  | "review_verdict"
  | "landing_decision"
  | "clarification_request"
  | "pr_open_request"
  | "merge_request"
  | "external_publish";

export interface TaskActivityEvent {
  version: "1";
  ts: Timestamp;
  task_id: TaskId;
  run_id: TaskRunId;
  kind: TaskActivityKind;
  message: string;
  phase?: string;
  member_id?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskIntentMemberPolicy {
  roles: string[];
}

export interface TaskIntentRulePolicy {
  allowed_members: string[];
  allowed_roles: string[];
}

export interface TaskIntentPolicy {
  version: "1";
  members: Record<string, TaskIntentMemberPolicy>;
  intents: Partial<Record<TaskIntentKind, TaskIntentRulePolicy>>;
}

export interface TaskIntentRecord {
  version: "1";
  intent_id: UUID;
  task_id: TaskId;
  run_id: TaskRunId;
  ts: Timestamp;
  kind: TaskIntentKind;
  member_id: string;
  member_roles: string[];
  payload: Record<string, unknown>;
  accepted: boolean;
  rejection_reason?: string;
}

export type TaskReviewDecision = "approve" | "changes_requested";

export interface TaskReviewVerdict {
  version: "1";
  decision: TaskReviewDecision;
  rationale?: string;
  metadata?: Record<string, unknown>;
  member_id: string;
  ts: Timestamp;
  source: "intent";
}

export interface TaskMergeRequest {
  version: "1";
  strategy?: string;
  rationale?: string;
  metadata?: Record<string, unknown>;
  member_id: string;
  ts: Timestamp;
  source: "intent";
}

export interface TaskClarificationRequest {
  version: "1";
  summary: string;
  questions?: string[];
  missing_fields?: string[];
  resume_hints?: string[];
  severity?: "low" | "normal" | "high";
  metadata?: Record<string, unknown>;
  member_id: string;
  ts: Timestamp;
  source: "intent";
}

export interface TaskPullRequestOpenRequest {
  version: "1";
  title: string;
  body?: string;
  base_ref?: string;
  head_ref?: string;
  labels?: string[];
  draft?: boolean;
  rationale?: string;
  metadata?: Record<string, unknown>;
  member_id: string;
  ts: Timestamp;
  source: "intent";
}

export interface TaskExternalPublishRequest {
  version: "1";
  summary?: string;
  metadata?: Record<string, unknown>;
  member_id: string;
  ts: Timestamp;
  source: "intent";
}

export type TaskReportingSinkId = "github" | "linear";
export type TaskReportingProjection = "status_comment" | "comment";
export type TaskReportingAggregate = "latest" | "latest_per_phase" | "summary";

export interface TaskReportingMemberPolicy {
  roles: string[];
}

export interface TaskReportingSinkPolicy {
  enabled: boolean;
  publisher_member: string | null;
  allowed_members: string[];
  allowed_roles: string[];
  events: TaskActivityKind[];
  projection: TaskReportingProjection;
  aggregate: TaskReportingAggregate;
}

export interface TaskReportingPolicy {
  version: "1";
  default_publisher: string | null;
  members: Record<string, TaskReportingMemberPolicy>;
  sinks: Partial<Record<TaskReportingSinkId, TaskReportingSinkPolicy>>;
}

export interface TaskGitHubStatusBridgeState {
  version: "1";
  task_id: TaskId;
  status_comment_id: number | null;
  last_rendered_body: string | null;
  clarification_comment_id?: number | null;
  last_clarification_body?: string | null;
  last_operator_comment_id?: number | null;
  updated_at: Timestamp;
}

export function buildTaskSourceKey(source: Pick<TaskSourceRef, "system_id" | "kind" | "external_id">): string {
  return `${source.system_id}:${source.kind}:${source.external_id}`;
}

export function isTerminalTaskRunStatus(status: TaskRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
