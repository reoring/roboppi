/**
 * TestScheduler
 *
 * A minimal scheduler that speaks the IPC protocol for testing AgentCore in isolation.
 * Can submit jobs, request permits, cancel jobs, and collect responses for assertions.
 */

import type {
  Job,
  UUID,
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
} from "../../src/types/index.js";
import { generateId } from "../../src/types/index.js";
import { JsonLinesTransport } from "../../src/ipc/json-lines-transport.js";

type OutboundType = OutboundMessage["type"];

interface PendingRequest {
  resolve: (msg: OutboundMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TestScheduler {
  private transport: JsonLinesTransport;
  private pendingRequests = new Map<string, PendingRequest>();
  private collectedMessages: OutboundMessage[] = [];
  private defaultTimeoutMs: number;

  constructor(
    input: ReadableStream<Uint8Array>,
    output: WritableStream<Uint8Array>,
    options?: { timeoutMs?: number },
  ) {
    this.transport = new JsonLinesTransport(input, output);
    this.defaultTimeoutMs = options?.timeoutMs ?? 5000;

    this.transport.on("message", (raw: unknown) => {
      const msg = raw as OutboundMessage;
      this.collectedMessages.push(msg);

      // Resolve pending requests by requestId
      const requestId = (msg as unknown as Record<string, unknown>)["requestId"];
      if (typeof requestId === "string") {
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(requestId);
          pending.resolve(msg);
        }
      }
    });
  }

  start(): void {
    this.transport.start();
  }

  async close(): Promise<void> {
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("TestScheduler closed"));
    }
    this.pendingRequests.clear();
    await this.transport.close();
  }

  /** Submit a job and wait for ack. */
  async submitJob(job: Job): Promise<AckMessage> {
    const requestId = generateId();
    const promise = this.waitForResponse(requestId);
    await this.transport.write({
      type: "submit_job",
      requestId,
      job,
    } satisfies InboundMessage);
    return promise as Promise<AckMessage>;
  }

  /** Request a permit for a job. */
  async requestPermit(
    job: Job,
    attemptIndex: number = 0,
  ): Promise<PermitGrantedMessage | PermitRejectedMessage> {
    const requestId = generateId();
    const promise = this.waitForResponse(requestId);
    await this.transport.write({
      type: "request_permit",
      requestId,
      job,
      attemptIndex,
    } satisfies InboundMessage);
    return promise as Promise<PermitGrantedMessage | PermitRejectedMessage>;
  }

  /** Cancel a job. */
  async cancelJob(jobId: UUID, reason: string): Promise<JobCancelledMessage> {
    const requestId = generateId();
    const promise = this.waitForResponse(requestId);
    await this.transport.write({
      type: "cancel_job",
      requestId,
      jobId,
      reason,
    } satisfies InboundMessage);
    return promise as Promise<JobCancelledMessage>;
  }

  /** Report queue metrics. */
  async reportMetrics(
    queueDepth: number,
    oldestJobAgeMs: number,
    backlogCount: number,
  ): Promise<void> {
    const requestId = generateId();
    await this.transport.write({
      type: "report_queue_metrics",
      requestId,
      queueDepth,
      oldestJobAgeMs,
      backlogCount,
    } satisfies InboundMessage);
  }

  /** Get all collected messages. */
  getMessages(): OutboundMessage[] {
    return [...this.collectedMessages];
  }

  /** Get collected messages of a specific type. */
  getMessagesByType<T extends OutboundType>(
    type: T,
  ): Extract<OutboundMessage, { type: T }>[] {
    return this.collectedMessages.filter(
      (m): m is Extract<OutboundMessage, { type: T }> => m.type === type,
    );
  }

  /** Get ack messages. */
  getAcks(): AckMessage[] {
    return this.getMessagesByType("ack");
  }

  /** Get permit granted messages. */
  getPermitGrants(): PermitGrantedMessage[] {
    return this.getMessagesByType("permit_granted");
  }

  /** Get permit rejected messages. */
  getPermitRejections(): PermitRejectedMessage[] {
    return this.getMessagesByType("permit_rejected");
  }

  /** Get job completed messages. */
  getCompletions(): JobCompletedMessage[] {
    return this.getMessagesByType("job_completed");
  }

  /** Get job cancelled messages. */
  getCancellations(): JobCancelledMessage[] {
    return this.getMessagesByType("job_cancelled");
  }

  /** Get escalation messages. */
  getEscalations(): EscalationMessage[] {
    return this.getMessagesByType("escalation");
  }

  /** Get heartbeat messages. */
  getHeartbeats(): HeartbeatMessage[] {
    return this.getMessagesByType("heartbeat");
  }

  /** Get error messages. */
  getErrors(): ErrorMessage[] {
    return this.getMessagesByType("error");
  }

  /** Clear collected messages. */
  clearMessages(): void {
    this.collectedMessages.length = 0;
  }

  /** Wait for a message with a specific requestId. */
  private waitForResponse(
    requestId: string,
    timeoutMs?: number,
  ): Promise<OutboundMessage> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`TestScheduler: request ${requestId} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
    });
  }
}
