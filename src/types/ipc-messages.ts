import type { UUID, ErrorClass, Timestamp } from "./common.js";
import type { Job } from "./job.js";
import type { Permit, PermitRejection } from "./permit.js";
import type { EscalationEvent } from "./escalation.js";
import type { WorkerResult } from "./worker-result.js";

// --- Scheduler → Core ---

export interface SubmitJobMessage {
  type: "submit_job";
  requestId: string;
  job: Job;
}

export interface CancelJobMessage {
  type: "cancel_job";
  requestId: string;
  jobId: UUID;
  reason: string;
}

export interface RequestPermitMessage {
  type: "request_permit";
  requestId: string;
  job: Job;
  attemptIndex: number;
}

export interface ReportQueueMetricsMessage {
  type: "report_queue_metrics";
  requestId: string;
  queueDepth: number;
  oldestJobAgeMs: number;
  backlogCount: number;
}

export type InboundMessage =
  | SubmitJobMessage
  | CancelJobMessage
  | RequestPermitMessage
  | ReportQueueMetricsMessage
  | HeartbeatMessage;

// --- Core → Scheduler ---

export interface AckMessage {
  type: "ack";
  requestId: string;
  jobId: UUID;
}

export interface PermitGrantedMessage {
  type: "permit_granted";
  requestId: string;
  permit: Permit; // Permit is serializable; PermitHandle (with AbortController) is used only at runtime
}

export interface PermitRejectedMessage {
  type: "permit_rejected";
  requestId: string;
  rejection: PermitRejection;
}

export interface JobCompletedMessage {
  type: "job_completed";
  requestId?: string;
  jobId: UUID;
  outcome: "succeeded" | "failed" | "cancelled";
  result?: WorkerResult;
  errorClass?: ErrorClass;
}

export interface JobCancelledMessage {
  type: "job_cancelled";
  requestId?: string;
  jobId: UUID;
  reason: string;
}

export interface EscalationMessage {
  type: "escalation";
  event: EscalationEvent;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  timestamp: Timestamp;
}

export interface HeartbeatAckMessage {
  type: "heartbeat_ack";
  timestamp: Timestamp;
}

export interface ErrorMessage {
  type: "error";
  requestId?: string;
  code: string;
  message: string;
}

export type OutboundMessage =
  | AckMessage
  | PermitGrantedMessage
  | PermitRejectedMessage
  | JobCompletedMessage
  | JobCancelledMessage
  | EscalationMessage
  | HeartbeatMessage
  | HeartbeatAckMessage
  | ErrorMessage;

export type IpcMessage = InboundMessage | OutboundMessage;
