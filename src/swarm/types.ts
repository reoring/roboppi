/**
 * Swarm on-disk schema types.
 *
 * All persisted JSON objects carry a `version: "1"` field for forward
 * compatibility.  See `docs/features/swarm.md` §4.
 */
import type { UUID, Timestamp } from "../types/common.js";

// ---------------------------------------------------------------------------
// Team & Members
// ---------------------------------------------------------------------------

export interface CleanupPolicy {
  retain_mailbox: boolean;
  retain_tasks: boolean;
}

export interface TeamConfig {
  version: "1";
  team_id: UUID;
  name: string;
  created_at: Timestamp;
  context_dir: string;
  lead_member_id: string;
  cleanup_policy: CleanupPolicy;
}

export interface MemberWorkerRef {
  kind: string; // WorkerKind value
  model?: string;
}

export interface MemberEntry {
  member_id: string;
  name: string;
  role: string;
  worker?: MemberWorkerRef;
  capabilities?: string[];
  workspace?: string;
}

export interface MembersConfig {
  version: "1";
  members: MemberEntry[];
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type MessageTo =
  | { type: "member"; member_id: string }
  | { type: "broadcast" };

export type MessageKind =
  | "text"
  | "task_update"
  | "idle"
  | "shutdown_request"
  | "shutdown_ack"
  | "plan_request"
  | "plan_approved"
  | "plan_rejected";

export interface SwarmMessage {
  version: "1";
  team_id: UUID;
  message_id: UUID;
  ts: Timestamp;
  from: { member_id: string; name: string };
  to: MessageTo;
  kind: MessageKind;
  topic: string;
  body: string;
  correlation_id?: string | null;
  reply_to?: string | null;
  metadata?: Record<string, unknown>;
  /** Internal: incremented by housekeeping requeue. */
  delivery_attempt?: number;
  /** Internal: set by claimMessage(). */
  claimed_at?: Timestamp;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface SwarmTask {
  version: "1";
  task_id: UUID;
  title: string;
  description: string;
  status: TaskStatus;
  depends_on: UUID[];
  created_at: Timestamp;
  updated_at: Timestamp;
  assigned_to: string | null;
  claimed_by: string | null;
  claimed_at: Timestamp | null;
  completed_at: Timestamp | null;
  artifacts: string[];
  tags: string[];
  requires_plan_approval: boolean;
}

// ---------------------------------------------------------------------------
// Event log entries (metadata-only by default)
// ---------------------------------------------------------------------------

export type MailboxEventType =
  | "message_delivered"
  | "message_claimed"
  | "message_acked"
  | "message_requeued"
  | "message_dead";

export interface MailboxEvent {
  ts: Timestamp;
  type: MailboxEventType;
  message_id: UUID;
  from?: string;
  to?: string;
  topic?: string;
  by?: string;
  delivery_attempt?: number;
}

export type TaskEventType =
  | "task_added"
  | "task_claimed"
  | "task_completed"
  | "task_blocked";

export interface TaskEvent {
  ts: Timestamp;
  type: TaskEventType;
  task_id: UUID;
  title?: string;
  by?: string;
}
