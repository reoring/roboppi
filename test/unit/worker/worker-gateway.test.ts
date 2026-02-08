import { describe, test, expect } from "bun:test";
import { WorkerDelegationGateway } from "../../../src/worker/worker-gateway.js";
import { MockWorkerAdapter } from "../../../src/worker/adapters/mock-adapter.js";
import {
  WorkerKind,
  WorkerCapability,
  OutputMode,
  WorkerStatus,
  CircuitState,
  generateId,
} from "../../../src/types/index.js";
import type { WorkerTask, PermitHandle } from "../../../src/types/index.js";

function makeTask(overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    workerTaskId: generateId(),
    workerKind: WorkerKind.CODEX_CLI,
    workspaceRef: "/workspace/test",
    instructions: "test instruction",
    capabilities: [WorkerCapability.READ],
    outputMode: OutputMode.BATCH,
    budget: { deadlineAt: Date.now() + 60000 },
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

function makePermit(overrides: Partial<PermitHandle> = {}): PermitHandle {
  return {
    permitId: generateId(),
    jobId: generateId(),
    deadlineAt: Date.now() + 60000,
    attemptIndex: 0,
    abortController: new AbortController(),
    tokensGranted: { concurrency: 1, rps: 10 },
    circuitStateSnapshot: { default: CircuitState.CLOSED },
    ...overrides,
  };
}

describe("WorkerDelegationGateway", () => {
  test("dispatches to correct adapter by workerKind", async () => {
    const gateway = new WorkerDelegationGateway();
    const adapter = new MockWorkerAdapter(WorkerKind.CODEX_CLI, { delayMs: 5 });
    gateway.registerAdapter(WorkerKind.CODEX_CLI, adapter);

    const task = makeTask();
    const permit = makePermit();

    const result = await gateway.delegateTask(task, permit);
    expect(result.status).toBe(WorkerStatus.SUCCEEDED);
  });

  test("throws when no adapter registered for kind", async () => {
    const gateway = new WorkerDelegationGateway();
    const task = makeTask({ workerKind: WorkerKind.OPENCODE });
    const permit = makePermit();

    expect(gateway.delegateTask(task, permit)).rejects.toThrow(
      "No adapter registered for worker kind: OPENCODE"
    );
  });

  test("tracks active worker count", async () => {
    const gateway = new WorkerDelegationGateway();
    const adapter = new MockWorkerAdapter(WorkerKind.CODEX_CLI, { delayMs: 100 });
    gateway.registerAdapter(WorkerKind.CODEX_CLI, adapter);

    expect(gateway.getActiveWorkerCount()).toBe(0);

    const task = makeTask();
    const permit = makePermit();

    const resultPromise = gateway.delegateTask(task, permit);

    // Give the async function a tick to start
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(gateway.getActiveWorkerCount()).toBe(1);

    await resultPromise;
    expect(gateway.getActiveWorkerCount()).toBe(0);
  });

  test("permit abort cancels worker", async () => {
    const gateway = new WorkerDelegationGateway();
    const adapter = new MockWorkerAdapter(WorkerKind.CODEX_CLI, {
      delayMs: 10,
      shouldTimeout: true,
      shouldRespectCancel: true,
    });
    gateway.registerAdapter(WorkerKind.CODEX_CLI, adapter);

    const task = makeTask();
    const permit = makePermit();

    const resultPromise = gateway.delegateTask(task, permit);

    // Cancel via permit after a short delay
    await new Promise((resolve) => setTimeout(resolve, 30));
    permit.abortController.abort("test cancel");

    const result = await resultPromise;
    expect(result.status).toBe(WorkerStatus.CANCELLED);
  });

  test("cancelAll cancels all active workers", async () => {
    const gateway = new WorkerDelegationGateway();
    const adapter = new MockWorkerAdapter(WorkerKind.CODEX_CLI, {
      delayMs: 10,
      shouldTimeout: true,
      shouldRespectCancel: true,
    });
    gateway.registerAdapter(WorkerKind.CODEX_CLI, adapter);

    const promises = [
      gateway.delegateTask(makeTask(), makePermit()),
      gateway.delegateTask(makeTask(), makePermit()),
    ];

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateway.getActiveWorkerCount()).toBe(2);

    await gateway.cancelAll();
    expect(gateway.getActiveWorkerCount()).toBe(0);

    // Both promises should resolve with CANCELLED
    const results = await Promise.all(promises);
    for (const result of results) {
      expect(result.status).toBe(WorkerStatus.CANCELLED);
    }
  });

  test("registers multiple adapters for different kinds", async () => {
    const gateway = new WorkerDelegationGateway();
    const codexAdapter = new MockWorkerAdapter(WorkerKind.CODEX_CLI, { delayMs: 5 });
    const claudeAdapter = new MockWorkerAdapter(WorkerKind.CLAUDE_CODE, {
      delayMs: 5,
      shouldFail: true,
    });

    gateway.registerAdapter(WorkerKind.CODEX_CLI, codexAdapter);
    gateway.registerAdapter(WorkerKind.CLAUDE_CODE, claudeAdapter);

    const codexResult = await gateway.delegateTask(
      makeTask({ workerKind: WorkerKind.CODEX_CLI }),
      makePermit()
    );
    expect(codexResult.status).toBe(WorkerStatus.SUCCEEDED);

    const claudeResult = await gateway.delegateTask(
      makeTask({ workerKind: WorkerKind.CLAUDE_CODE }),
      makePermit()
    );
    expect(claudeResult.status).toBe(WorkerStatus.FAILED);
  });
});
