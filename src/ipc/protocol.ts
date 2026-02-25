import type {
  UUID,
  Timestamp,
  ErrorClass,
  InboundMessage,
  OutboundMessage,
  AckMessage,
  PermitGrantedMessage,
  PermitRejectedMessage,
  JobCompletedMessage,
  JobCancelledMessage,
  JobEventMessage,
  EscalationMessage,
  HeartbeatMessage,
  HeartbeatAckMessage,
  ErrorMessage,
  SubmitJobMessage,
  RequestPermitMessage,
  CancelJobMessage,
  ReportQueueMetricsMessage,
  PermitRejection,
  EscalationEvent,
  WorkerResult,
  Permit,
  Job,
} from "../types/index.js";
import type { WorkerEvent } from "../worker/worker-adapter.js";
import { JsonLinesTransport } from "./json-lines-transport.js";
import { IpcDisconnectError, IpcStoppedError, IpcTimeoutError } from "./errors.js";

type InboundType = InboundMessage["type"];
type OutboundType = OutboundMessage["type"];
type AllMessageType = InboundType | OutboundType;
type AllHandlerMap = {
  [K in InboundType]?: (msg: Extract<InboundMessage, { type: K }>) => void;
} & {
  [K in OutboundType]?: (msg: Extract<OutboundMessage, { type: K }>) => void;
};

// Keep the old type alias for backward compatibility
type HandlerMap = AllHandlerMap;

export interface IpcProtocolOptions {
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class IpcProtocol {
  private readonly transport: JsonLinesTransport;
  private readonly handlers: HandlerMap = {};
  private readonly requestTimeoutMs: number;
  private readonly pendingRequests = new Map<
    string,
    {
      resolve: (msg: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private running = false;

  constructor(transport: JsonLinesTransport, options?: IpcProtocolOptions) {
    this.transport = transport;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** Register a handler for a specific message type (inbound or outbound direction). */
  onMessage<K extends AllMessageType>(
    type: K,
    handler: (msg: Extract<InboundMessage | OutboundMessage, { type: K }>) => void,
  ): this {
    (this.handlers as Record<string, unknown>)[type] = handler;
    return this;
  }

  /** Start processing incoming messages. */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.transport.on("message", (raw: unknown) => {
      this.dispatch(raw);
    });

    // Surface transport-level issues (parse errors, disconnects, buffer overflows).
    // This is especially important because IPC runs over stdout/stderr pipes and
    // any non-JSON output can break request/response correlation.
    this.transport.on("error", (err: Error) => {
      try {
        // Avoid throwing from error handler.
        console.error("[IPC] Transport error:", err);
      } catch {
        // ignore
      }
    });

    this.transport.on("close", () => {
      // Reject all pending requests immediately; callers shouldn't wait for
      // requestTimeoutMs when the stream is already closed.
      for (const [requestId, pending] of this.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new IpcDisconnectError(`IPC transport closed (requestId=${requestId})`));
      }
      this.pendingRequests.clear();
    });

    this.transport.start();
  }

  /** Stop processing and close the transport. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Reject all pending requests
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new IpcStoppedError(requestId));
    }
    this.pendingRequests.clear();

    await this.transport.close();
  }

  // --- Scheduler → Core send methods ---

  /** Send a submit_job request to Core. */
  async sendSubmitJob(requestId: string, job: Job): Promise<void> {
    const msg: SubmitJobMessage = { type: "submit_job", requestId, job };
    await this.transport.write(msg);
  }

  /** Send a request_permit request to Core. */
  async sendRequestPermit(requestId: string, job: Job, attemptIndex: number): Promise<void> {
    const msg: RequestPermitMessage = { type: "request_permit", requestId, job, attemptIndex };
    await this.transport.write(msg);
  }

  /** Send a cancel_job request to Core. */
  async sendCancelJob(requestId: string, jobId: UUID, reason: string): Promise<void> {
    const msg: CancelJobMessage = { type: "cancel_job", requestId, jobId, reason };
    await this.transport.write(msg);
  }

  /** Send queue metrics report to Core. */
  async sendReportQueueMetrics(
    requestId: string,
    queueDepth: number,
    oldestJobAgeMs: number,
    backlogCount: number,
  ): Promise<void> {
    const msg: ReportQueueMetricsMessage = {
      type: "report_queue_metrics",
      requestId,
      queueDepth,
      oldestJobAgeMs,
      backlogCount,
    };
    await this.transport.write(msg);
  }

  // --- Core → Scheduler send methods ---

  /** Send an ack for a submitted job. */
  async sendAck(requestId: string, jobId: UUID): Promise<void> {
    const msg: AckMessage = { type: "ack", requestId, jobId };
    await this.transport.write(msg);
  }

  /** Send a permit granted response. */
  async sendPermitGranted(
    requestId: string,
    permit: Omit<Permit, "abortController">,
  ): Promise<void> {
    const msg: PermitGrantedMessage = { type: "permit_granted", requestId, permit };
    await this.transport.write(msg);
  }

  /** Send a permit rejected response. */
  async sendPermitRejected(requestId: string, rejection: PermitRejection): Promise<void> {
    const msg: PermitRejectedMessage = { type: "permit_rejected", requestId, rejection };
    await this.transport.write(msg);
  }

  /** Send a job completed notification. */
  async sendJobCompleted(
    jobId: UUID,
    outcome: "succeeded" | "failed" | "cancelled",
    result?: WorkerResult,
    errorClass?: ErrorClass,
    requestId?: string,
  ): Promise<void> {
    const msg: JobCompletedMessage = { type: "job_completed", jobId, outcome };
    if (requestId !== undefined) msg.requestId = requestId;
    if (result !== undefined) msg.result = result;
    if (errorClass !== undefined) msg.errorClass = errorClass;
    await this.transport.write(msg);
  }

  /** Send a job cancelled notification. */
  async sendJobCancelled(jobId: UUID, reason: string, requestId?: string): Promise<void> {
    const msg: JobCancelledMessage = { type: "job_cancelled", jobId, reason };
    if (requestId !== undefined) msg.requestId = requestId;
    await this.transport.write(msg);
  }

  /** Send an escalation event. */
  async sendEscalation(event: EscalationEvent): Promise<void> {
    const msg: EscalationMessage = { type: "escalation", event };
    await this.transport.write(msg);
  }

  /** Send a heartbeat. */
  async sendHeartbeat(timestamp: Timestamp): Promise<void> {
    const msg: HeartbeatMessage = { type: "heartbeat", timestamp };
    await this.transport.write(msg);
  }

  /** Send a heartbeat acknowledgement. */
  async sendHeartbeatAck(timestamp: Timestamp): Promise<void> {
    const msg: HeartbeatAckMessage = { type: "heartbeat_ack", timestamp };
    await this.transport.write(msg);
  }

  /** Send an error message. */
  async sendError(code: string, message: string, requestId?: string): Promise<void> {
    const msg: ErrorMessage = { type: "error", code, message };
    if (requestId !== undefined) msg.requestId = requestId;
    await this.transport.write(msg);
  }

  /** Send a job event (async streaming, no requestId — fire-and-forget). */
  async sendJobEvent(jobId: UUID, ts: number, seq: number, event: WorkerEvent): Promise<void> {
    const msg: JobEventMessage = { type: "job_event", jobId, ts, seq, event };
    await this.transport.write(msg);
  }

  /** Wait for a response message with a matching requestId (for request/response correlation). */
  waitForResponse(requestId: string, timeoutMs?: number): Promise<unknown> {
    const timeout = timeoutMs ?? this.requestTimeoutMs;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new IpcTimeoutError(requestId, timeout));
      }, timeout);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
    });

    // Prevent unhandled rejection crashes if callers create a waiter but never await it.
    // (We still return the original promise so callers can observe the rejection.)
    p.catch(() => {});
    return p;
  }

  private dispatch(raw: unknown): void {
    // Validate message structure
    if (typeof raw !== "object" || raw === null || typeof (raw as Record<string, unknown>)["type"] !== "string") {
      console.error("[IPC] Invalid message: expected object with string 'type', got:", raw);
      return;
    }
    const msg = raw as Record<string, unknown>;

    // Validate required fields for known message types
    const validationError = validateMessage(msg);
    if (validationError) {
      console.error(`[IPC] Invalid ${msg["type"]} message: ${validationError}`);
      return;
    }

    // Check for request/response correlation
    if (typeof msg["requestId"] === "string") {
      const pending = this.pendingRequests.get(msg["requestId"]);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg["requestId"]);
        pending.resolve(raw);
        return;
      }
    }

    // Route to registered handler
    const type = msg["type"] as string;

    const handler = (this.handlers as Record<string, ((msg: unknown) => void) | undefined>)[type];
    if (handler) {
      try {
        handler(raw);
      } catch (err) {
        // Prevent uncaught exceptions from crashing the IPC loop.
        // Log for visibility.
        console.error("[IPC] Handler error:", err);
      }
    }
  }
}

/**
 * Validates that a message has the required fields for its type.
 * Returns an error string if invalid, or null if valid.
 * Unknown message types pass validation (no required fields to check).
 */
export function validateMessage(msg: Record<string, unknown>): string | null {
  const type = msg["type"] as string;

  switch (type) {
    // --- Scheduler → Core (Inbound) ---
    case "submit_job":
      if (typeof msg["requestId"] !== "string") return "missing required field 'requestId'";
      if (typeof msg["job"] !== "object" || msg["job"] === null) return "missing required field 'job'";
      return null;

    case "cancel_job":
      if (typeof msg["requestId"] !== "string") return "missing required field 'requestId'";
      if (typeof msg["jobId"] !== "string") return "missing required field 'jobId'";
      if (typeof msg["reason"] !== "string") return "missing required field 'reason'";
      return null;

    case "request_permit":
      if (typeof msg["requestId"] !== "string") return "missing required field 'requestId'";
      if (typeof msg["job"] !== "object" || msg["job"] === null) return "missing required field 'job'";
      if (typeof msg["attemptIndex"] !== "number") return "missing required field 'attemptIndex'";
      return null;

    case "report_queue_metrics":
      if (typeof msg["requestId"] !== "string") return "missing required field 'requestId'";
      if (typeof msg["queueDepth"] !== "number") return "missing required field 'queueDepth'";
      if (typeof msg["oldestJobAgeMs"] !== "number") return "missing required field 'oldestJobAgeMs'";
      if (typeof msg["backlogCount"] !== "number") return "missing required field 'backlogCount'";
      return null;

    // --- Core → Scheduler (Outbound) ---
    case "ack":
      if (typeof msg["requestId"] !== "string") return "missing required field 'requestId'";
      if (typeof msg["jobId"] !== "string") return "missing required field 'jobId'";
      return null;

    case "permit_granted":
      if (typeof msg["requestId"] !== "string") return "missing required field 'requestId'";
      if (typeof msg["permit"] !== "object" || msg["permit"] === null) return "missing required field 'permit'";
      return null;

    case "permit_rejected":
      if (typeof msg["requestId"] !== "string") return "missing required field 'requestId'";
      if (typeof msg["rejection"] !== "object" || msg["rejection"] === null) return "missing required field 'rejection'";
      return null;

    case "job_completed":
      if (typeof msg["jobId"] !== "string") return "missing required field 'jobId'";
      if (typeof msg["outcome"] !== "string") return "missing required field 'outcome'";
      return null;

    case "job_event":
      if (typeof msg["jobId"] !== "string") return "missing required field 'jobId'";
      if (typeof msg["ts"] !== "number") return "missing required field 'ts'";
      if (typeof msg["seq"] !== "number") return "missing required field 'seq'";
      if (typeof msg["event"] !== "object" || msg["event"] === null) return "missing required field 'event'";
      return null;

    case "job_cancelled":
      if (typeof msg["jobId"] !== "string") return "missing required field 'jobId'";
      if (typeof msg["reason"] !== "string") return "missing required field 'reason'";
      return null;

    case "escalation":
      if (typeof msg["event"] !== "object" || msg["event"] === null) return "missing required field 'event'";
      return null;

    case "heartbeat":
      if (typeof msg["timestamp"] !== "number") return "missing required field 'timestamp'";
      return null;

    case "heartbeat_ack":
      if (typeof msg["timestamp"] !== "number") return "missing required field 'timestamp'";
      return null;

    case "error":
      if (typeof msg["code"] !== "string") return "missing required field 'code'";
      if (typeof msg["message"] !== "string") return "missing required field 'message'";
      return null;

    default:
      // Unknown message types pass validation
      return null;
  }
}
