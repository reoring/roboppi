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
  EscalationMessage,
  HeartbeatMessage,
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
import { JsonLinesTransport } from "./json-lines-transport.js";
import { IpcTimeoutError } from "./errors.js";

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

    this.transport.start();
  }

  /** Stop processing and close the transport. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Reject all pending requests
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new IpcTimeoutError(requestId, 0));
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

  /** Send an error message. */
  async sendError(code: string, message: string, requestId?: string): Promise<void> {
    const msg: ErrorMessage = { type: "error", code, message };
    if (requestId !== undefined) msg.requestId = requestId;
    await this.transport.write(msg);
  }

  /** Wait for a response message with a matching requestId (for request/response correlation). */
  waitForResponse(requestId: string, timeoutMs?: number): Promise<unknown> {
    const timeout = timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new IpcTimeoutError(requestId, timeout));
      }, timeout);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
    });
  }

  private dispatch(raw: unknown): void {
    // Validate message structure
    if (typeof raw !== "object" || raw === null || typeof (raw as Record<string, unknown>)["type"] !== "string") {
      console.error("[IPC] Invalid message: expected object with string 'type', got:", raw);
      return;
    }
    const msg = raw as Record<string, unknown>;

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
