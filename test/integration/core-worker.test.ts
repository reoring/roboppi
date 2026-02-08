import { describe, test, expect, afterEach } from "bun:test";
import { JsonLinesTransport } from "../../src/ipc/json-lines-transport.js";
import { IpcProtocol } from "../../src/ipc/protocol.js";
import { PermitGate } from "../../src/core/permit-gate.js";
import { ExecutionBudget } from "../../src/core/execution-budget.js";
import { CircuitBreakerRegistry } from "../../src/core/circuit-breaker.js";
import { BackpressureController } from "../../src/core/backpressure.js";
import { CancellationManager } from "../../src/core/cancellation.js";
import { WorkerDelegationGateway } from "../../src/worker/worker-gateway.js";
import { MockWorkerAdapter } from "../../src/worker/adapters/mock-adapter.js";
import { WorkerKind, WorkerCapability, OutputMode, WorkerStatus, PermitRejectionReason } from "../../src/types/index.js";
import type { PermitHandle, PermitRejection, WorkerTask } from "../../src/types/index.js";
import { createTestJob, createIpcStreamPair, TEST_IDS } from "../helpers/fixtures.js";

function isPermit(result: PermitHandle | PermitRejection): result is PermitHandle {
  return "permitId" in result;
}

/**
 * Integration test: verifies that a WORKER_TASK job flows through the full
 * pipeline: IPC transport -> permit gate -> worker gateway -> mock adapter -> IPC response.
 *
 * This wires together real components (no AgentCore orchestrator needed).
 */
describe("Core-Worker integration", () => {
  let permitGate: PermitGate;
  let cbRegistry: CircuitBreakerRegistry;
  let coreProtocol: IpcProtocol;
  let schedulerProtocol: IpcProtocol;

  function setup(mockOptions?: { delayMs?: number; shouldFail?: boolean }) {
    const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100 });
    cbRegistry = new CircuitBreakerRegistry();
    const backpressure = new BackpressureController({
      rejectThreshold: 1.0,
      deferThreshold: 0.8,
      degradeThreshold: 0.5,
    });
    permitGate = new PermitGate(budget, cbRegistry, backpressure);

    const cancellation = new CancellationManager();
    const workerGateway = new WorkerDelegationGateway();
    const mockAdapter = new MockWorkerAdapter(WorkerKind.CLAUDE_CODE, {
      delayMs: mockOptions?.delayMs ?? 10,
      shouldFail: mockOptions?.shouldFail ?? false,
    });
    workerGateway.registerAdapter(WorkerKind.CLAUDE_CODE, mockAdapter);

    // Set up in-memory IPC stream pair
    const streams = createIpcStreamPair();
    const coreTransport = new JsonLinesTransport(streams.coreInput, streams.coreOutput);
    const schedulerTransport = new JsonLinesTransport(streams.schedulerInput, streams.schedulerOutput);

    coreProtocol = new IpcProtocol(coreTransport);
    schedulerProtocol = new IpcProtocol(schedulerTransport);

    return { budget, cancellation, workerGateway, mockAdapter, permitGate };
  }

  afterEach(async () => {
    permitGate?.dispose();
    cbRegistry?.dispose();
    await coreProtocol?.stop();
    await schedulerProtocol?.stop();
  });

  test("job flows through permit gate and gets delegated to mock worker", async () => {
    const { workerGateway } = setup();
    const job = createTestJob();

    // 1. Request a permit from the gate
    const permitResult = permitGate.requestPermit(job, 0);
    expect(isPermit(permitResult)).toBe(true);
    if (!isPermit(permitResult)) return;

    const permit = permitResult;
    expect(permit.jobId).toBe(job.jobId);
    expect(permit.attemptIndex).toBe(0);
    expect(permit.abortController.signal.aborted).toBe(false);

    // 2. Create a WorkerTask and delegate through the gateway
    const workerTask: WorkerTask = {
      workerTaskId: TEST_IDS.WORKER_TASK_1,
      workerKind: WorkerKind.CLAUDE_CODE,
      workspaceRef: "/tmp/test-workspace",
      instructions: "Run the test suite",
      capabilities: [WorkerCapability.RUN_TESTS],
      outputMode: OutputMode.BATCH,
      budget: { deadlineAt: permit.deadlineAt },
      abortSignal: permit.abortController.signal,
    };

    const result = await workerGateway.delegateTask(workerTask, permit);

    // 3. Verify result
    expect(result.status).toBe(WorkerStatus.SUCCEEDED);
    expect(workerGateway.getActiveWorkerCount()).toBe(0);

    // 4. Complete the permit
    permitGate.completePermit(permit.permitId);
    expect(permitGate.getActivePermitCount()).toBe(0);
  });

  test("failed worker returns FAILED status through the pipeline", async () => {
    const { workerGateway } = setup({ shouldFail: true });
    const job = createTestJob();

    const permitResult = permitGate.requestPermit(job, 0);
    expect(isPermit(permitResult)).toBe(true);
    if (!isPermit(permitResult)) return;

    const permit = permitResult;

    const workerTask: WorkerTask = {
      workerTaskId: TEST_IDS.WORKER_TASK_1,
      workerKind: WorkerKind.CLAUDE_CODE,
      workspaceRef: "/tmp/test-workspace",
      instructions: "Run failing task",
      capabilities: [WorkerCapability.RUN_TESTS],
      outputMode: OutputMode.BATCH,
      budget: { deadlineAt: permit.deadlineAt },
      abortSignal: permit.abortController.signal,
    };

    const result = await workerGateway.delegateTask(workerTask, permit);
    expect(result.status).toBe(WorkerStatus.FAILED);

    permitGate.completePermit(permit.permitId);
  });

  test("IPC round-trip: scheduler sends submit_job, receives job_completed", async () => {
    const { workerGateway } = setup();

    const streams = createIpcStreamPair();
    const coreTransport = new JsonLinesTransport(streams.coreInput, streams.coreOutput);
    const schedulerTransport = new JsonLinesTransport(streams.schedulerInput, streams.schedulerOutput);

    // Scheduler side: collect messages from core
    const receivedMessages: unknown[] = [];
    const messageReceived = new Promise<void>((resolve) => {
      schedulerTransport.on("message", (msg) => {
        receivedMessages.push(msg);
        if (receivedMessages.length >= 2) resolve(); // ack + job_completed
      });
    });
    schedulerTransport.start();

    // Core side: handle submit_job
    const coreProto = new IpcProtocol(coreTransport);
    coreProto.onMessage("submit_job", async (msg) => {
      const job = msg.job;

      // Send ack
      await coreProto.sendAck(msg.requestId, job.jobId);

      // Issue permit
      const permitResult = permitGate.requestPermit(job, 0);
      if (!isPermit(permitResult)) {
        await coreProto.sendJobCompleted(job.jobId, "failed");
        return;
      }

      const permit = permitResult;

      // Delegate to worker
      const workerTask: WorkerTask = {
        workerTaskId: crypto.randomUUID(),
        workerKind: WorkerKind.CLAUDE_CODE,
        workspaceRef: "/tmp/test-workspace",
        instructions: "Test task",
        capabilities: [WorkerCapability.RUN_TESTS],
        outputMode: OutputMode.BATCH,
        budget: { deadlineAt: permit.deadlineAt },
        abortSignal: permit.abortController.signal,
      };

      const result = await workerGateway.delegateTask(workerTask, permit);
      permitGate.completePermit(permit.permitId);

      const outcome = result.status === WorkerStatus.SUCCEEDED ? "succeeded" : "failed";
      await coreProto.sendJobCompleted(job.jobId, outcome, result);
    });
    coreProto.start();

    // Scheduler sends a submit_job
    const job = createTestJob();
    await schedulerTransport.write({
      type: "submit_job",
      requestId: "req-001",
      job,
    });

    // Wait for core to process and respond
    await messageReceived;

    // Verify messages
    expect(receivedMessages.length).toBe(2);

    const ack = receivedMessages[0] as Record<string, unknown>;
    expect(ack["type"]).toBe("ack");
    expect(ack["requestId"]).toBe("req-001");
    expect(ack["jobId"]).toBe(TEST_IDS.JOB_1);

    const completed = receivedMessages[1] as Record<string, unknown>;
    expect(completed["type"]).toBe("job_completed");
    expect(completed["jobId"]).toBe(TEST_IDS.JOB_1);
    expect(completed["outcome"]).toBe("succeeded");
    expect(completed["result"]).toBeDefined();

    const workerResult = completed["result"] as Record<string, unknown>;
    expect(workerResult["status"]).toBe(WorkerStatus.SUCCEEDED);

    // Cleanup
    await coreProto.stop();
    await schedulerTransport.close();
  });

  test("multiple jobs can be processed concurrently", async () => {
    const { workerGateway } = setup({ delayMs: 20 });
    const jobs = [
      createTestJob({ jobId: TEST_IDS.JOB_1 }),
      createTestJob({ jobId: TEST_IDS.JOB_2 }),
      createTestJob({ jobId: TEST_IDS.JOB_3 }),
    ];

    const permits: PermitHandle[] = [];
    for (const job of jobs) {
      const result = permitGate.requestPermit(job, 0);
      expect(isPermit(result)).toBe(true);
      if (isPermit(result)) permits.push(result);
    }

    expect(permitGate.getActivePermitCount()).toBe(3);

    // Delegate all concurrently
    const resultPromises = permits.map((permit, i) => {
      const task: WorkerTask = {
        workerTaskId: crypto.randomUUID(),
        workerKind: WorkerKind.CLAUDE_CODE,
        workspaceRef: "/tmp/test-workspace",
        instructions: `Task ${i}`,
        capabilities: [WorkerCapability.RUN_TESTS],
        outputMode: OutputMode.BATCH,
        budget: { deadlineAt: permit.deadlineAt },
        abortSignal: permit.abortController.signal,
      };
      return workerGateway.delegateTask(task, permit);
    });

    const results = await Promise.all(resultPromises);
    for (const result of results) {
      expect(result.status).toBe(WorkerStatus.SUCCEEDED);
    }

    // Complete all permits
    for (const permit of permits) {
      permitGate.completePermit(permit.permitId);
    }
    expect(permitGate.getActivePermitCount()).toBe(0);
    expect(workerGateway.getActiveWorkerCount()).toBe(0);
  });

  test("permit rejection prevents worker delegation", async () => {
    // Set maxConcurrency to 0 so all permits are rejected
    const budget = new ExecutionBudget({ maxConcurrency: 0, maxRps: 100 });
    const localCbRegistry = new CircuitBreakerRegistry();
    const backpressure = new BackpressureController({
      rejectThreshold: 1.0,
      deferThreshold: 0.8,
      degradeThreshold: 0.5,
    });
    const localGate = new PermitGate(budget, localCbRegistry, backpressure);

    const job = createTestJob();
    const result = localGate.requestPermit(job, 0);
    expect(isPermit(result)).toBe(false);
    if (!isPermit(result)) {
      expect(result.reason).toBe(PermitRejectionReason.CONCURRENCY_LIMIT);
    }

    localGate.dispose();
    localCbRegistry.dispose();
  });
});
