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
import { WorkerKind, WorkerCapability, OutputMode, WorkerStatus } from "../../src/types/index.js";
import type { PermitHandle, PermitRejection, WorkerTask } from "../../src/types/index.js";
import { createTestJob, createIpcStreamPair, TEST_IDS } from "../helpers/fixtures.js";

function isPermit(result: PermitHandle | PermitRejection): result is PermitHandle {
  return "permitId" in result;
}

/**
 * Integration tests for the full cancellation flow:
 * Job cancel -> Permit abort -> Worker cancel -> WorkerResult CANCELLED -> IPC response
 */
describe("Cancellation flow integration", () => {
  let permitGate: PermitGate;
  let cbRegistry: CircuitBreakerRegistry;

  function setup(mockOptions?: { delayMs?: number; shouldTimeout?: boolean }) {
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
      delayMs: mockOptions?.delayMs ?? 200,
      shouldTimeout: mockOptions?.shouldTimeout ?? false,
      shouldRespectCancel: true,
    });
    workerGateway.registerAdapter(WorkerKind.CLAUDE_CODE, mockAdapter);

    return { budget, cancellation, workerGateway, mockAdapter };
  }

  afterEach(() => {
    permitGate?.dispose();
    cbRegistry?.dispose();
  });

  test("cancel propagates: permit abort -> worker cancel -> CANCELLED result", async () => {
    const { workerGateway } = setup({ delayMs: 500 });
    const job = createTestJob();

    // Issue permit
    const permitResult = permitGate.requestPermit(job, 0);
    expect(isPermit(permitResult)).toBe(true);
    if (!isPermit(permitResult)) return;
    const permit = permitResult;

    // Start worker task
    const workerTask: WorkerTask = {
      workerTaskId: TEST_IDS.WORKER_TASK_1,
      workerKind: WorkerKind.CLAUDE_CODE,
      workspaceRef: "/tmp/test-workspace",
      instructions: "Long running task",
      capabilities: [WorkerCapability.RUN_TESTS],
      outputMode: OutputMode.BATCH,
      budget: { deadlineAt: permit.deadlineAt },
      abortSignal: permit.abortController.signal,
    };

    // Delegate in background, then cancel
    const resultPromise = workerGateway.delegateTask(workerTask, permit);

    // Cancel the permit mid-execution
    await new Promise((resolve) => setTimeout(resolve, 50));
    permitGate.revokePermit(permit.permitId, "User requested cancellation");

    // The permit's abort should have fired
    expect(permit.abortController.signal.aborted).toBe(true);

    // The worker should return CANCELLED
    const result = await resultPromise;
    expect(result.status).toBe(WorkerStatus.CANCELLED);

    // No active workers remain
    expect(workerGateway.getActiveWorkerCount()).toBe(0);
    expect(permitGate.getActivePermitCount()).toBe(0);
  });

  test("CancellationManager.cancelByJobId propagates through permit to worker", async () => {
    const { cancellation, workerGateway } = setup({ delayMs: 500 });
    const job = createTestJob();

    // Issue permit and register with CancellationManager
    const permitResult = permitGate.requestPermit(job, 0);
    expect(isPermit(permitResult)).toBe(true);
    if (!isPermit(permitResult)) return;
    const permit = permitResult;

    // Register the permit's controller with the cancellation manager
    cancellation.createController(permit.permitId, job.jobId);
    // Wire the cancellation manager's controller to the permit's abort
    cancellation.onAbort(permit.permitId, () => {
      permitGate.revokePermit(permit.permitId, "Cancelled via CancellationManager");
    });

    // Start worker task
    const workerTask: WorkerTask = {
      workerTaskId: TEST_IDS.WORKER_TASK_1,
      workerKind: WorkerKind.CLAUDE_CODE,
      workspaceRef: "/tmp/test-workspace",
      instructions: "Task to be cancelled by jobId",
      capabilities: [WorkerCapability.RUN_TESTS],
      outputMode: OutputMode.BATCH,
      budget: { deadlineAt: permit.deadlineAt },
      abortSignal: permit.abortController.signal,
    };

    const resultPromise = workerGateway.delegateTask(workerTask, permit);

    // Cancel via jobId
    await new Promise((resolve) => setTimeout(resolve, 50));
    cancellation.cancelByJobId(job.jobId, "Job cancelled by scheduler");

    expect(cancellation.isAborted(permit.permitId)).toBe(true);

    const result = await resultPromise;
    expect(result.status).toBe(WorkerStatus.CANCELLED);
    expect(workerGateway.getActiveWorkerCount()).toBe(0);

    cancellation.removeController(permit.permitId);
  });

  test("cancellation with shouldTimeout mock: worker respects cancel and returns", async () => {
    const { workerGateway } = setup({ shouldTimeout: true });
    const job = createTestJob();

    const permitResult = permitGate.requestPermit(job, 0);
    expect(isPermit(permitResult)).toBe(true);
    if (!isPermit(permitResult)) return;
    const permit = permitResult;

    const workerTask: WorkerTask = {
      workerTaskId: TEST_IDS.WORKER_TASK_1,
      workerKind: WorkerKind.CLAUDE_CODE,
      workspaceRef: "/tmp/test-workspace",
      instructions: "This task will hang until cancelled",
      capabilities: [WorkerCapability.RUN_TESTS],
      outputMode: OutputMode.BATCH,
      budget: { deadlineAt: permit.deadlineAt },
      abortSignal: permit.abortController.signal,
    };

    const resultPromise = workerGateway.delegateTask(workerTask, permit);

    // Cancel after a short delay
    await new Promise((resolve) => setTimeout(resolve, 50));
    permitGate.revokePermit(permit.permitId, "Timeout abort");

    // The mock will detect cancellation and resolve with CANCELLED
    const result = await resultPromise;
    expect(result.status).toBe(WorkerStatus.CANCELLED);
    expect(workerGateway.getActiveWorkerCount()).toBe(0);
  });

  test("no ghost worker handles remain after cancellation", async () => {
    const { workerGateway } = setup({ delayMs: 300 });

    // Submit 3 jobs, cancel them all
    const permits: PermitHandle[] = [];
    for (let i = 0; i < 3; i++) {
      const job = createTestJob({ jobId: `job-cancel-${i}` });
      const result = permitGate.requestPermit(job, 0);
      expect(isPermit(result)).toBe(true);
      if (isPermit(result)) permits.push(result);
    }

    // Start all worker tasks
    const resultPromises = permits.map((permit, i) => {
      const task: WorkerTask = {
        workerTaskId: crypto.randomUUID(),
        workerKind: WorkerKind.CLAUDE_CODE,
        workspaceRef: "/tmp/test-workspace",
        instructions: `Cancellable task ${i}`,
        capabilities: [WorkerCapability.RUN_TESTS],
        outputMode: OutputMode.BATCH,
        budget: { deadlineAt: permit.deadlineAt },
        abortSignal: permit.abortController.signal,
      };
      return workerGateway.delegateTask(task, permit);
    });

    // Cancel all permits
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const permit of permits) {
      permitGate.revokePermit(permit.permitId, "Batch cancellation");
    }

    // Wait for all workers to settle
    const results = await Promise.all(resultPromises);
    for (const result of results) {
      expect(result.status).toBe(WorkerStatus.CANCELLED);
    }

    // Verify no ghost handles
    expect(workerGateway.getActiveWorkerCount()).toBe(0);
    expect(permitGate.getActivePermitCount()).toBe(0);
  });

  test("worker not responding to cancel still gets cleaned up via abort", async () => {
    // Use a mock adapter that does NOT respect cancel (shouldRespectCancel: false)
    // but the abort signal timeout should still clean up
    const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100 });
    const localCbRegistry = new CircuitBreakerRegistry();
    const backpressure = new BackpressureController({
      rejectThreshold: 1.0,
      deferThreshold: 0.8,
      degradeThreshold: 0.5,
    });
    const localPermitGate = new PermitGate(budget, localCbRegistry, backpressure);
    const localGateway = new WorkerDelegationGateway();
    // Mock adapter that ignores cancel but still resolves after delay
    const stubAdapter = new MockWorkerAdapter(WorkerKind.CLAUDE_CODE, {
      delayMs: 100,
      shouldRespectCancel: false,
    });
    localGateway.registerAdapter(WorkerKind.CLAUDE_CODE, stubAdapter);

    const job = createTestJob();
    const permitResult = localPermitGate.requestPermit(job, 0);
    expect(isPermit(permitResult)).toBe(true);
    if (!isPermit(permitResult)) return;
    const permit = permitResult;

    const workerTask: WorkerTask = {
      workerTaskId: TEST_IDS.WORKER_TASK_1,
      workerKind: WorkerKind.CLAUDE_CODE,
      workspaceRef: "/tmp/test-workspace",
      instructions: "Unresponsive task",
      capabilities: [WorkerCapability.RUN_TESTS],
      outputMode: OutputMode.BATCH,
      budget: { deadlineAt: permit.deadlineAt },
      abortSignal: permit.abortController.signal,
    };

    const resultPromise = localGateway.delegateTask(workerTask, permit);

    // Revoke permit immediately — the adapter ignores cancel but should still complete
    await new Promise((resolve) => setTimeout(resolve, 10));
    localPermitGate.revokePermit(permit.permitId, "Force cleanup");
    expect(permit.abortController.signal.aborted).toBe(true);

    // The worker should eventually complete (it finishes its delay regardless)
    const result = await resultPromise;
    // Status could be SUCCEEDED (since it doesn't respect cancel) or FAILED
    expect(result.status).toBeDefined();
    expect(localGateway.getActiveWorkerCount()).toBe(0);
    expect(localPermitGate.getActivePermitCount()).toBe(0);

    localPermitGate.dispose();
    localCbRegistry.dispose();
  });

  test("full IPC round-trip: scheduler sends cancel_job, core cancels worker", async () => {
    const { workerGateway, cancellation } = setup({ delayMs: 500 });

    // Set up IPC stream pair
    const streams = createIpcStreamPair();
    const coreTransport = new JsonLinesTransport(streams.coreInput, streams.coreOutput);
    const schedulerTransport = new JsonLinesTransport(streams.schedulerInput, streams.schedulerOutput);

    const receivedMessages: unknown[] = [];
    const allMessagesReceived = new Promise<void>((resolve) => {
      schedulerTransport.on("message", (msg) => {
        receivedMessages.push(msg);
        // Expect: ack, job_cancelled, job_completed
        if (receivedMessages.length >= 3) resolve();
      });
      // Also resolve after timeout to avoid hanging
      setTimeout(resolve, 3000);
    });
    schedulerTransport.start();

    // Track active permits by jobId for cancel routing
    const jobPermitMap = new Map<string, PermitHandle>();

    const coreProto = new IpcProtocol(coreTransport);

    coreProto.onMessage("submit_job", async (msg) => {
      const job = msg.job;
      await coreProto.sendAck(msg.requestId, job.jobId);

      const permitResult = permitGate.requestPermit(job, 0);
      if (!isPermit(permitResult)) {
        await coreProto.sendJobCompleted(job.jobId, "failed");
        return;
      }
      const permit = permitResult;
      jobPermitMap.set(job.jobId, permit);

      // Register with cancellation manager
      cancellation.createController(permit.permitId, job.jobId);
      cancellation.onAbort(permit.permitId, () => {
        permitGate.revokePermit(permit.permitId, "Cancelled");
      });

      const workerTask: WorkerTask = {
        workerTaskId: crypto.randomUUID(),
        workerKind: WorkerKind.CLAUDE_CODE,
        workspaceRef: "/tmp/test-workspace",
        instructions: "Long task",
        capabilities: [WorkerCapability.RUN_TESTS],
        outputMode: OutputMode.BATCH,
        budget: { deadlineAt: permit.deadlineAt },
        abortSignal: permit.abortController.signal,
      };

      const result = await workerGateway.delegateTask(workerTask, permit);
      permitGate.completePermit(permit.permitId);
      jobPermitMap.delete(job.jobId);
      cancellation.removeController(permit.permitId);

      const outcome = result.status === WorkerStatus.SUCCEEDED
        ? "succeeded"
        : result.status === WorkerStatus.CANCELLED
          ? "cancelled"
          : "failed";
      await coreProto.sendJobCompleted(job.jobId, outcome, result);
    });

    coreProto.onMessage("cancel_job", async (msg) => {
      // Cancel the job via cancellation manager
      cancellation.cancelByJobId(msg.jobId, msg.reason);
      await coreProto.sendJobCancelled(msg.jobId, msg.reason, msg.requestId);
    });

    coreProto.start();

    // Scheduler submits a job
    const job = createTestJob();
    await schedulerTransport.write({
      type: "submit_job",
      requestId: "req-submit",
      job,
    });

    // Wait a bit for the job to start processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Scheduler sends cancel
    await schedulerTransport.write({
      type: "cancel_job",
      requestId: "req-cancel",
      jobId: job.jobId,
      reason: "User cancelled the task",
    });

    // Wait for all messages
    await allMessagesReceived;

    // Verify we got an ack
    const ack = receivedMessages.find(
      (m) => (m as Record<string, unknown>)["type"] === "ack",
    ) as Record<string, unknown> | undefined;
    expect(ack).toBeDefined();
    expect(ack!["jobId"]).toBe(TEST_IDS.JOB_1);

    // Verify we got a job_cancelled
    const cancelled = receivedMessages.find(
      (m) => (m as Record<string, unknown>)["type"] === "job_cancelled",
    ) as Record<string, unknown> | undefined;
    expect(cancelled).toBeDefined();
    expect(cancelled!["jobId"]).toBe(TEST_IDS.JOB_1);
    expect(cancelled!["reason"]).toBe("User cancelled the task");

    // Verify we got a job_completed with cancelled outcome
    const completed = receivedMessages.find(
      (m) => (m as Record<string, unknown>)["type"] === "job_completed",
    ) as Record<string, unknown> | undefined;
    expect(completed).toBeDefined();
    expect(completed!["jobId"]).toBe(TEST_IDS.JOB_1);
    expect(completed!["outcome"]).toBe("cancelled");

    const resultPayload = completed!["result"] as Record<string, unknown> | undefined;
    expect(resultPayload).toBeDefined();
    expect(resultPayload!["status"]).toBe(WorkerStatus.CANCELLED);

    // Verify no ghost workers
    expect(workerGateway.getActiveWorkerCount()).toBe(0);

    // Cleanup
    await coreProto.stop();
    await schedulerTransport.close();
  });
});
