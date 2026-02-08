import { describe, test, expect, afterEach } from "bun:test";
import { JsonLinesTransport } from "../../src/ipc/json-lines-transport.js";
import { IpcProtocol } from "../../src/ipc/protocol.js";
import { AgentCore } from "../../src/core/agentcore.js";
import { MockWorkerAdapter } from "../../src/worker/adapters/mock-adapter.js";
import { WorkerKind, JobType, WorkerCapability, OutputMode } from "../../src/types/index.js";
import { createTestJob, createIpcStreamPair, TEST_IDS } from "../helpers/fixtures.js";

type Msg = Record<string, unknown>;

function collectMessages(transport: JsonLinesTransport): Msg[] {
  const messages: Msg[] = [];
  transport.on("message", (msg) => {
    messages.push(msg as Msg);
  });
  return messages;
}

function waitForMessages(
  messages: Msg[],
  count: number,
  timeoutMs = 5000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (messages.length >= count) {
      resolve();
      return;
    }
    const interval = setInterval(() => {
      if (messages.length >= count) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve();
      }
    }, 10);
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for ${count} messages, got ${messages.length}`));
    }, timeoutMs);
  });
}

function workerTaskPayload() {
  return {
    workerTaskId: TEST_IDS.WORKER_TASK_1,
    workerKind: WorkerKind.CLAUDE_CODE,
    workspaceRef: "/tmp/test-workspace",
    instructions: "Run the test suite",
    capabilities: [WorkerCapability.RUN_TESTS],
    outputMode: OutputMode.BATCH,
    budget: { deadlineAt: Date.now() + 10000 },
  };
}

describe("Scheduler-Core IPC integration", () => {
  let core: AgentCore;
  let schedulerTransport: JsonLinesTransport;

  afterEach(async () => {
    await core?.shutdown();
    await schedulerTransport?.close();
  });

  function setup(coreConfig?: ConstructorParameters<typeof AgentCore>[1], mockOptions?: { delayMs?: number }) {
    const streams = createIpcStreamPair();
    const coreTransport = new JsonLinesTransport(streams.coreInput, streams.coreOutput);
    const coreProtocol = new IpcProtocol(coreTransport);

    schedulerTransport = new JsonLinesTransport(streams.schedulerInput, streams.schedulerOutput);
    schedulerTransport.start();

    core = new AgentCore(coreProtocol, coreConfig);
    core.getWorkerGateway().registerAdapter(
      WorkerKind.CLAUDE_CODE,
      new MockWorkerAdapter(WorkerKind.CLAUDE_CODE, { delayMs: mockOptions?.delayMs ?? 10 }),
    );
    core.start();

    return { schedulerTransport };
  }

  test("submit_job receives ack and job_completed for WORKER_TASK", async () => {
    setup();
    const messages = collectMessages(schedulerTransport);

    const job = createTestJob({
      jobId: TEST_IDS.JOB_1,
      type: JobType.WORKER_TASK,
      payload: workerTaskPayload(),
    });

    // Scheduler sends submit_job
    await schedulerTransport.write({
      type: "submit_job",
      requestId: "req-001",
      job,
    });

    // Wait for ack
    await waitForMessages(messages, 1);
    const ack = messages.find((m) => m["type"] === "ack");
    expect(ack).toBeDefined();
    expect(ack!["requestId"]).toBe("req-001");
    expect(ack!["jobId"]).toBe(TEST_IDS.JOB_1);

    // Scheduler sends request_permit
    await schedulerTransport.write({
      type: "request_permit",
      requestId: "req-002",
      job,
      attemptIndex: 0,
    });

    // Wait for permit_granted + job_completed (total 3 messages: ack, permit_granted, job_completed)
    await waitForMessages(messages, 3);

    const permitGranted = messages.find((m) => m["type"] === "permit_granted");
    expect(permitGranted).toBeDefined();
    expect(permitGranted!["requestId"]).toBe("req-002");
    const permit = permitGranted!["permit"] as Msg;
    expect(permit["jobId"]).toBe(TEST_IDS.JOB_1);

    const completed = messages.find((m) => m["type"] === "job_completed");
    expect(completed).toBeDefined();
    expect(completed!["jobId"]).toBe(TEST_IDS.JOB_1);
    expect(completed!["outcome"]).toBe("succeeded");
  });

  test("submit_job for non-WORKER_TASK type receives ack and permit_granted only", async () => {
    setup();
    const messages = collectMessages(schedulerTransport);

    const job = createTestJob({
      jobId: TEST_IDS.JOB_1,
      type: JobType.LLM,
      payload: { prompt: "Hello" },
    });

    // Submit the job
    await schedulerTransport.write({
      type: "submit_job",
      requestId: "req-010",
      job,
    });

    await waitForMessages(messages, 1);
    expect(messages[0]!["type"]).toBe("ack");

    // Request permit for LLM job
    await schedulerTransport.write({
      type: "request_permit",
      requestId: "req-011",
      job,
      attemptIndex: 0,
    });

    await waitForMessages(messages, 2);

    const permitGranted = messages.find((m) => m["type"] === "permit_granted");
    expect(permitGranted).toBeDefined();
    expect(permitGranted!["requestId"]).toBe("req-011");

    // Wait a bit to ensure no job_completed arrives
    await new Promise((resolve) => setTimeout(resolve, 100));
    const completed = messages.find((m) => m["type"] === "job_completed");
    expect(completed).toBeUndefined();
  });

  test("multiple jobs processed concurrently via IPC", async () => {
    setup();
    const messages = collectMessages(schedulerTransport);

    const jobs = [
      createTestJob({ jobId: TEST_IDS.JOB_1, type: JobType.WORKER_TASK, payload: workerTaskPayload() }),
      createTestJob({ jobId: TEST_IDS.JOB_2, type: JobType.WORKER_TASK, payload: { ...workerTaskPayload(), workerTaskId: "wt-2" } }),
      createTestJob({ jobId: TEST_IDS.JOB_3, type: JobType.WORKER_TASK, payload: { ...workerTaskPayload(), workerTaskId: "wt-3" } }),
    ];

    // Submit all 3 jobs
    for (let i = 0; i < jobs.length; i++) {
      await schedulerTransport.write({
        type: "submit_job",
        requestId: `req-sub-${i}`,
        job: jobs[i],
      });
    }

    // Wait for 3 acks
    await waitForMessages(messages, 3);
    const acks = messages.filter((m) => m["type"] === "ack");
    expect(acks.length).toBe(3);

    // Request permits for all 3
    for (let i = 0; i < jobs.length; i++) {
      await schedulerTransport.write({
        type: "request_permit",
        requestId: `req-perm-${i}`,
        job: jobs[i],
        attemptIndex: 0,
      });
    }

    // Wait for 3 permit_granted + 3 job_completed = 9 total messages
    await waitForMessages(messages, 9);

    const permits = messages.filter((m) => m["type"] === "permit_granted");
    expect(permits.length).toBe(3);

    const completions = messages.filter((m) => m["type"] === "job_completed");
    expect(completions.length).toBe(3);

    for (const c of completions) {
      expect(c["outcome"]).toBe("succeeded");
    }

    // Verify all 3 job IDs are present in completions
    const completedJobIds = completions.map((c) => c["jobId"]).sort();
    expect(completedJobIds).toEqual(
      [TEST_IDS.JOB_1, TEST_IDS.JOB_2, TEST_IDS.JOB_3].sort(),
    );
  });

  test("request_permit rejected when budget exhausted", async () => {
    setup({ budget: { maxConcurrency: 1, maxRps: 100 } });
    const messages = collectMessages(schedulerTransport);

    const job1 = createTestJob({
      jobId: TEST_IDS.JOB_1,
      type: JobType.WORKER_TASK,
      payload: workerTaskPayload(),
    });
    const job2 = createTestJob({
      jobId: TEST_IDS.JOB_2,
      type: JobType.WORKER_TASK,
      payload: { ...workerTaskPayload(), workerTaskId: "wt-2" },
    });

    // Submit both jobs
    await schedulerTransport.write({ type: "submit_job", requestId: "req-s1", job: job1 });
    await schedulerTransport.write({ type: "submit_job", requestId: "req-s2", job: job2 });
    await waitForMessages(messages, 2);

    // Request permit for job1 — should succeed
    await schedulerTransport.write({
      type: "request_permit",
      requestId: "req-p1",
      job: job1,
      attemptIndex: 0,
    });

    await waitForMessages(messages, 3);
    const granted = messages.find(
      (m) => m["type"] === "permit_granted" && m["requestId"] === "req-p1",
    );
    expect(granted).toBeDefined();

    // Request permit for job2 immediately — should be rejected (concurrency=1, one permit active)
    await schedulerTransport.write({
      type: "request_permit",
      requestId: "req-p2",
      job: job2,
      attemptIndex: 0,
    });

    await waitForMessages(messages, 4);
    const rejected = messages.find(
      (m) => m["type"] === "permit_rejected" && m["requestId"] === "req-p2",
    );
    expect(rejected).toBeDefined();
    const rejection = rejected!["rejection"] as Msg;
    expect(rejection["reason"]).toBe("CONCURRENCY_LIMIT");
  });

  test("report_queue_metrics updates backpressure state", async () => {
    setup();
    const messages = collectMessages(schedulerTransport);

    // Send report_queue_metrics with high values to trigger REJECT threshold
    // Default rejectThreshold=100, so queueDepth=200 will exceed it
    await schedulerTransport.write({
      type: "report_queue_metrics",
      requestId: "req-metrics",
      queueDepth: 200,
      oldestJobAgeMs: 50000,
      backlogCount: 150,
    });

    // Give AgentCore time to process the metrics update
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now request_permit should be rejected due to backpressure
    const job = createTestJob({ jobId: TEST_IDS.JOB_1 });
    await schedulerTransport.write({ type: "submit_job", requestId: "req-sub", job });
    await waitForMessages(messages, 1);

    await schedulerTransport.write({
      type: "request_permit",
      requestId: "req-bp",
      job,
      attemptIndex: 0,
    });

    await waitForMessages(messages, 2);
    const rejected = messages.find(
      (m) => m["type"] === "permit_rejected" && m["requestId"] === "req-bp",
    );
    expect(rejected).toBeDefined();
    const rejection = rejected!["rejection"] as Msg;
    expect(rejection["reason"]).toBe("GLOBAL_SHED");
  });

  test("cancel_job via IPC sends job_cancelled and worker completes", async () => {
    setup(undefined, { delayMs: 500 });
    const messages = collectMessages(schedulerTransport);

    const job = createTestJob({
      jobId: TEST_IDS.JOB_1,
      type: JobType.WORKER_TASK,
      payload: workerTaskPayload(),
    });

    // Submit and request permit
    await schedulerTransport.write({ type: "submit_job", requestId: "req-c1", job });
    await waitForMessages(messages, 1);

    await schedulerTransport.write({
      type: "request_permit",
      requestId: "req-c2",
      job,
      attemptIndex: 0,
    });

    // Wait for permit_granted (the worker is now running with 500ms delay)
    await waitForMessages(messages, 2);
    const granted = messages.find((m) => m["type"] === "permit_granted");
    expect(granted).toBeDefined();

    // Cancel the job while worker is still running
    await schedulerTransport.write({
      type: "cancel_job",
      requestId: "req-c3",
      jobId: TEST_IDS.JOB_1,
      reason: "User requested cancellation",
    });

    // Expect: job_cancelled acknowledgement from cancel_job handler, and
    // eventually job_completed when the worker finishes
    await waitForMessages(messages, 4);

    const cancelled = messages.find((m) => m["type"] === "job_cancelled");
    expect(cancelled).toBeDefined();
    expect(cancelled!["jobId"]).toBe(TEST_IDS.JOB_1);
    expect(cancelled!["reason"]).toBe("User requested cancellation");
    expect(cancelled!["requestId"]).toBe("req-c3");

    const completed = messages.find((m) => m["type"] === "job_completed");
    expect(completed).toBeDefined();
    expect(completed!["jobId"]).toBe(TEST_IDS.JOB_1);
    // Worker task completes independently — the outcome reflects the worker's actual result
    expect(completed!["outcome"]).toBeDefined();
  });
});
