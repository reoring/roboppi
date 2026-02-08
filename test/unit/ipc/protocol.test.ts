import { describe, test, expect } from "bun:test";
import { JsonLinesTransport } from "../../../src/ipc/json-lines-transport.js";
import { IpcProtocol } from "../../../src/ipc/protocol.js";
import { IpcTimeoutError } from "../../../src/ipc/errors.js";
import type {
  SubmitJobMessage,
  CancelJobMessage,
  RequestPermitMessage,
  ReportQueueMetricsMessage,
} from "../../../src/types/index.js";
import { JobType, PriorityClass, PermitRejectionReason, CircuitState, EscalationScope, EscalationAction } from "../../../src/types/index.js";

/** Create a test protocol backed by in-memory streams. */
function createTestProtocol(options?: { requestTimeoutMs?: number }) {
  const inputStream = new TransformStream<Uint8Array, Uint8Array>();
  const outputStream = new TransformStream<Uint8Array, Uint8Array>();

  const transport = new JsonLinesTransport(inputStream.readable, outputStream.writable);
  const protocol = new IpcProtocol(transport, options);

  const inputWriter = inputStream.writable.getWriter();
  const outputReader = outputStream.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    protocol,
    transport,
    async feedInput(text: string) {
      await inputWriter.write(encoder.encode(text));
    },
    async closeInput() {
      await inputWriter.close();
    },
    async readOutput(): Promise<unknown> {
      const { value } = await outputReader.read();
      if (!value) return null;
      return JSON.parse(decoder.decode(value).trim());
    },
  };
}

function makeTestJob() {
  return {
    jobId: "job-1",
    type: JobType.LLM,
    priority: { value: 10, class: PriorityClass.INTERACTIVE },
    payload: { prompt: "hello" },
    limits: { timeoutMs: 5000, maxAttempts: 3 },
    context: { traceId: "t1", correlationId: "c1" },
  };
}

describe("IpcProtocol", () => {
  describe("message routing", () => {
    test("routes submit_job messages to registered handler", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      let received: SubmitJobMessage | null = null;

      protocol.onMessage("submit_job", (msg) => {
        received = msg;
      });
      protocol.start();

      const msg = {
        type: "submit_job",
        requestId: "req-1",
        job: makeTestJob(),
      };
      await feedInput(JSON.stringify(msg) + "\n");
      await new Promise((r) => setTimeout(r, 50));

      expect(received).not.toBeNull();
      expect(received!.type).toBe("submit_job");
      expect(received!.requestId).toBe("req-1");
      expect(received!.job.jobId).toBe("job-1");

      await closeInput();
      await protocol.stop();
    });

    test("routes cancel_job messages to registered handler", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      let received: CancelJobMessage | null = null;

      protocol.onMessage("cancel_job", (msg) => {
        received = msg;
      });
      protocol.start();

      await feedInput(JSON.stringify({
        type: "cancel_job",
        requestId: "req-2",
        jobId: "job-1",
        reason: "user cancelled",
      }) + "\n");
      await new Promise((r) => setTimeout(r, 50));

      expect(received).not.toBeNull();
      expect(received!.jobId).toBe("job-1");
      expect(received!.reason).toBe("user cancelled");

      await closeInput();
      await protocol.stop();
    });

    test("routes request_permit messages to registered handler", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      let received: RequestPermitMessage | null = null;

      protocol.onMessage("request_permit", (msg) => {
        received = msg;
      });
      protocol.start();

      await feedInput(JSON.stringify({
        type: "request_permit",
        requestId: "req-3",
        job: makeTestJob(),
        attemptIndex: 0,
      }) + "\n");
      await new Promise((r) => setTimeout(r, 50));

      expect(received).not.toBeNull();
      expect(received!.attemptIndex).toBe(0);

      await closeInput();
      await protocol.stop();
    });

    test("routes report_queue_metrics messages to registered handler", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      let received: ReportQueueMetricsMessage | null = null;

      protocol.onMessage("report_queue_metrics", (msg) => {
        received = msg;
      });
      protocol.start();

      await feedInput(JSON.stringify({
        type: "report_queue_metrics",
        requestId: "req-4",
        queueDepth: 5,
        oldestJobAgeMs: 1200,
        backlogCount: 2,
      }) + "\n");
      await new Promise((r) => setTimeout(r, 50));

      expect(received).not.toBeNull();
      expect(received!.queueDepth).toBe(5);

      await closeInput();
      await protocol.stop();
    });

    test("ignores messages with no registered handler", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      protocol.start();

      // No handler registered for submit_job — should not throw
      await feedInput(JSON.stringify({
        type: "submit_job",
        requestId: "req-5",
        job: makeTestJob(),
      }) + "\n");
      await new Promise((r) => setTimeout(r, 50));

      await closeInput();
      await protocol.stop();
    });

    test("ignores messages without type field", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      protocol.start();

      await feedInput('{"data":"no type"}\n');
      await new Promise((r) => setTimeout(r, 50));

      await closeInput();
      await protocol.stop();
    });
  });

  describe("outbound helpers", () => {
    test("sendAck writes correct message", async () => {
      const { protocol, readOutput, closeInput } = createTestProtocol();

      const outputPromise = readOutput();
      await protocol.sendAck("req-1", "job-1");
      const output = await outputPromise;

      expect(output).toEqual({
        type: "ack",
        requestId: "req-1",
        jobId: "job-1",
      });

      await closeInput();
      await protocol.stop();
    });

    test("sendPermitGranted writes correct message", async () => {
      const { protocol, readOutput, closeInput } = createTestProtocol();
      const permit = {
        permitId: "p-1",
        jobId: "job-1",
        deadlineAt: 9999,
        attemptIndex: 0,
        tokensGranted: { concurrency: 1, rps: 10 },
        circuitStateSnapshot: { llm: CircuitState.CLOSED },
      };

      const outputPromise = readOutput();
      await protocol.sendPermitGranted("req-1", permit);
      const output = await outputPromise;

      expect(output).toEqual({
        type: "permit_granted",
        requestId: "req-1",
        permit,
      });

      await closeInput();
      await protocol.stop();
    });

    test("sendPermitRejected writes correct message", async () => {
      const { protocol, readOutput, closeInput } = createTestProtocol();

      const outputPromise = readOutput();
      await protocol.sendPermitRejected("req-1", {
        reason: PermitRejectionReason.CIRCUIT_OPEN,
        detail: "LLM circuit is open",
      });
      const output = await outputPromise;

      expect(output).toEqual({
        type: "permit_rejected",
        requestId: "req-1",
        rejection: {
          reason: "CIRCUIT_OPEN",
          detail: "LLM circuit is open",
        },
      });

      await closeInput();
      await protocol.stop();
    });

    test("sendJobCompleted writes correct message", async () => {
      const { protocol, readOutput, closeInput } = createTestProtocol();

      const outputPromise = readOutput();
      await protocol.sendJobCompleted("job-1", "succeeded");
      const output = await outputPromise;

      expect(output).toEqual({
        type: "job_completed",
        jobId: "job-1",
        outcome: "succeeded",
      });

      await closeInput();
      await protocol.stop();
    });

    test("sendJobCancelled writes correct message", async () => {
      const { protocol, readOutput, closeInput } = createTestProtocol();

      const outputPromise = readOutput();
      await protocol.sendJobCancelled("job-1", "timed out", "req-1");
      const output = await outputPromise;

      expect(output).toEqual({
        type: "job_cancelled",
        requestId: "req-1",
        jobId: "job-1",
        reason: "timed out",
      });

      await closeInput();
      await protocol.stop();
    });

    test("sendEscalation writes correct message", async () => {
      const { protocol, readOutput, closeInput } = createTestProtocol();

      const outputPromise = readOutput();
      await protocol.sendEscalation({
        scope: EscalationScope.GLOBAL,
        action: EscalationAction.STOP,
        target: "all",
        reason: "fatal error",
        timestamp: 12345,
        severity: "fatal",
      });
      const output = await outputPromise;

      expect(output).toEqual({
        type: "escalation",
        event: {
          scope: "GLOBAL",
          action: "STOP",
          target: "all",
          reason: "fatal error",
          timestamp: 12345,
          severity: "fatal",
        },
      });

      await closeInput();
      await protocol.stop();
    });

    test("sendHeartbeat writes correct message", async () => {
      const { protocol, readOutput, closeInput } = createTestProtocol();

      const outputPromise = readOutput();
      await protocol.sendHeartbeat(12345);
      const output = await outputPromise;

      expect(output).toEqual({
        type: "heartbeat",
        timestamp: 12345,
      });

      await closeInput();
      await protocol.stop();
    });

    test("sendError writes correct message", async () => {
      const { protocol, readOutput, closeInput } = createTestProtocol();

      const outputPromise = readOutput();
      await protocol.sendError("INVALID_JOB", "Missing payload", "req-1");
      const output = await outputPromise;

      expect(output).toEqual({
        type: "error",
        requestId: "req-1",
        code: "INVALID_JOB",
        message: "Missing payload",
      });

      await closeInput();
      await protocol.stop();
    });

    test("sendError without requestId omits it", async () => {
      const { protocol, readOutput, closeInput } = createTestProtocol();

      const outputPromise = readOutput();
      await protocol.sendError("INTERNAL", "Something broke");
      const output = await outputPromise;

      expect(output).toEqual({
        type: "error",
        code: "INTERNAL",
        message: "Something broke",
      });

      await closeInput();
      await protocol.stop();
    });
  });

  describe("request/response correlation", () => {
    test("waitForResponse resolves when matching response arrives", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      protocol.start();

      const responsePromise = protocol.waitForResponse("req-10");

      await feedInput(JSON.stringify({
        type: "ack",
        requestId: "req-10",
        jobId: "job-1",
      }) + "\n");

      const result = await responsePromise;
      expect(result).toEqual({
        type: "ack",
        requestId: "req-10",
        jobId: "job-1",
      });

      await closeInput();
      await protocol.stop();
    });

    test("waitForResponse rejects on timeout", async () => {
      const { protocol, closeInput } = createTestProtocol({ requestTimeoutMs: 100 });
      protocol.start();

      const responsePromise = protocol.waitForResponse("req-11");

      await expect(responsePromise).rejects.toThrow(IpcTimeoutError);

      await closeInput();
      await protocol.stop();
    });

    test("correlated responses are not dispatched to handlers", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      let handlerCalled = false;

      protocol.onMessage("submit_job", () => {
        handlerCalled = true;
      });
      protocol.start();

      // Set up a pending request for req-20
      const responsePromise = protocol.waitForResponse("req-20");

      // Feed a submit_job that matches the pending request
      await feedInput(JSON.stringify({
        type: "submit_job",
        requestId: "req-20",
        job: makeTestJob(),
      }) + "\n");

      await responsePromise;
      await new Promise((r) => setTimeout(r, 50));

      // Handler should NOT be called since the message was consumed by correlation
      expect(handlerCalled).toBe(false);

      await closeInput();
      await protocol.stop();
    });
  });

  describe("Scheduler → Core send helpers", () => {
    test("sendSubmitJob writes correct message", async () => {
      const { protocol, readOutput, closeInput } = createTestProtocol();
      const job = makeTestJob();

      const outputPromise = readOutput();
      await protocol.sendSubmitJob("req-100", job);
      const output = await outputPromise;

      expect(output).toEqual({
        type: "submit_job",
        requestId: "req-100",
        job,
      });

      await closeInput();
      await protocol.stop();
    });

    test("sendRequestPermit writes correct message", async () => {
      const { protocol, readOutput, closeInput } = createTestProtocol();
      const job = makeTestJob();

      const outputPromise = readOutput();
      await protocol.sendRequestPermit("req-101", job, 2);
      const output = await outputPromise;

      expect(output).toEqual({
        type: "request_permit",
        requestId: "req-101",
        job,
        attemptIndex: 2,
      });

      await closeInput();
      await protocol.stop();
    });

    test("sendCancelJob writes correct message", async () => {
      const { protocol, readOutput, closeInput } = createTestProtocol();

      const outputPromise = readOutput();
      await protocol.sendCancelJob("req-102", "job-1", "no longer needed");
      const output = await outputPromise;

      expect(output).toEqual({
        type: "cancel_job",
        requestId: "req-102",
        jobId: "job-1",
        reason: "no longer needed",
      });

      await closeInput();
      await protocol.stop();
    });

    test("sendReportQueueMetrics writes correct message", async () => {
      const { protocol, readOutput, closeInput } = createTestProtocol();

      const outputPromise = readOutput();
      await protocol.sendReportQueueMetrics("req-103", 42, 5000, 10);
      const output = await outputPromise;

      expect(output).toEqual({
        type: "report_queue_metrics",
        requestId: "req-103",
        queueDepth: 42,
        oldestJobAgeMs: 5000,
        backlogCount: 10,
      });

      await closeInput();
      await protocol.stop();
    });
  });

  describe("handler error isolation", () => {
    test("handler throwing an exception does not crash dispatch", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      let secondHandlerCalled = false;

      protocol.onMessage("submit_job", () => {
        throw new Error("Handler exploded");
      });
      protocol.start();

      // The throwing handler should not crash the protocol
      await feedInput(JSON.stringify({
        type: "submit_job",
        requestId: "req-err",
        job: makeTestJob(),
      }) + "\n");
      await new Promise((r) => setTimeout(r, 50));

      // Verify protocol still works after the error
      protocol.onMessage("cancel_job", () => {
        secondHandlerCalled = true;
      });

      await feedInput(JSON.stringify({
        type: "cancel_job",
        requestId: "req-err2",
        jobId: "job-1",
        reason: "test",
      }) + "\n");
      await new Promise((r) => setTimeout(r, 50));

      expect(secondHandlerCalled).toBe(true);

      await closeInput();
      await protocol.stop();
    });
  });

  describe("Scheduler-direction message handling", () => {
    test("routes outbound-type messages (permit_granted) to handlers on Scheduler side", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      let received: unknown = null;

      // Scheduler registers handlers for Core→Scheduler messages
      protocol.onMessage("permit_granted", (msg) => {
        received = msg;
      });
      protocol.start();

      await feedInput(JSON.stringify({
        type: "permit_granted",
        requestId: "req-pg",
        permit: {
          permitId: "p-1",
          jobId: "job-1",
          deadlineAt: 9999,
          attemptIndex: 0,
          tokensGranted: { concurrency: 1, rps: 1 },
          circuitStateSnapshot: {},
        },
      }) + "\n");
      await new Promise((r) => setTimeout(r, 50));

      expect(received).not.toBeNull();
      const msg = received as Record<string, unknown>;
      expect(msg["type"]).toBe("permit_granted");

      await closeInput();
      await protocol.stop();
    });

    test("routes job_completed messages to handlers on Scheduler side", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      let received: unknown = null;

      protocol.onMessage("job_completed", (msg) => {
        received = msg;
      });
      protocol.start();

      await feedInput(JSON.stringify({
        type: "job_completed",
        jobId: "job-1",
        outcome: "succeeded",
      }) + "\n");
      await new Promise((r) => setTimeout(r, 50));

      expect(received).not.toBeNull();
      const msg = received as Record<string, unknown>;
      expect(msg["outcome"]).toBe("succeeded");

      await closeInput();
      await protocol.stop();
    });
  });

  describe("malformed message handling", () => {
    test("message with missing type field does not crash protocol", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      let handlerCalled = false;
      protocol.onMessage("submit_job", () => {
        handlerCalled = true;
      });
      protocol.start();

      // Send message without "type" field
      await feedInput('{"data":"no type field"}\n');
      await new Promise((r) => setTimeout(r, 50));

      // Should not have called any handler
      expect(handlerCalled).toBe(false);

      // Protocol should still work after malformed message
      await feedInput(JSON.stringify({
        type: "submit_job",
        requestId: "req-valid",
        job: makeTestJob(),
      }) + "\n");
      await new Promise((r) => setTimeout(r, 50));

      expect(handlerCalled).toBe(true);

      await closeInput();
      await protocol.stop();
    });

    test("message with invalid type value is silently ignored", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      let handlerCalled = false;
      protocol.onMessage("submit_job", () => {
        handlerCalled = true;
      });
      protocol.start();

      // Send message with unknown type
      await feedInput('{"type":"completely_invalid_type","data":"test"}\n');
      await new Promise((r) => setTimeout(r, 50));

      // No handler registered for this type — should be ignored
      expect(handlerCalled).toBe(false);

      await closeInput();
      await protocol.stop();
    });

    test("message that is not an object (string) does not crash protocol", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      protocol.start();

      // JSON string value — valid JSON but not an object
      await feedInput('"just a string"\n');
      await new Promise((r) => setTimeout(r, 50));

      // Protocol should survive
      await closeInput();
      await protocol.stop();
    });

    test("message that is not an object (number) does not crash protocol", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      protocol.start();

      await feedInput("42\n");
      await new Promise((r) => setTimeout(r, 50));

      await closeInput();
      await protocol.stop();
    });

    test("message that is null does not crash protocol", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      protocol.start();

      await feedInput("null\n");
      await new Promise((r) => setTimeout(r, 50));

      await closeInput();
      await protocol.stop();
    });

    test("empty line is silently ignored", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      let handlerCalled = false;
      protocol.onMessage("submit_job", () => {
        handlerCalled = true;
      });
      protocol.start();

      // Send empty lines
      await feedInput("\n\n\n");
      await new Promise((r) => setTimeout(r, 50));

      expect(handlerCalled).toBe(false);

      // Valid message should still work after empty lines
      await feedInput(JSON.stringify({
        type: "submit_job",
        requestId: "req-after-empty",
        job: makeTestJob(),
      }) + "\n");
      await new Promise((r) => setTimeout(r, 50));

      expect(handlerCalled).toBe(true);

      await closeInput();
      await protocol.stop();
    });

    test("message with type field that is not a string does not crash protocol", async () => {
      const { protocol, feedInput, closeInput } = createTestProtocol();
      protocol.start();

      // type is a number, not a string
      await feedInput('{"type":123,"data":"test"}\n');
      await new Promise((r) => setTimeout(r, 50));

      await closeInput();
      await protocol.stop();
    });
  });

  describe("lifecycle", () => {
    test("start() is idempotent", async () => {
      const { protocol, closeInput } = createTestProtocol();
      protocol.start();
      protocol.start(); // should not throw
      await closeInput();
      await protocol.stop();
    });

    test("stop() rejects pending requests", async () => {
      const { protocol, closeInput } = createTestProtocol();
      protocol.start();

      const responsePromise = protocol.waitForResponse("req-30");

      await closeInput();
      await protocol.stop();

      await expect(responsePromise).rejects.toThrow(IpcTimeoutError);
    });

    test("stop() is idempotent", async () => {
      const { protocol, closeInput } = createTestProtocol();
      protocol.start();
      await closeInput();
      await protocol.stop();
      await protocol.stop(); // should not throw
    });
  });
});
