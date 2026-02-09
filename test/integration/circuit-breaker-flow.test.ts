import { describe, test, expect, afterEach } from "bun:test";
import { PermitGate } from "../../src/core/permit-gate.js";
import { ExecutionBudget } from "../../src/core/execution-budget.js";
import { CircuitBreakerRegistry } from "../../src/core/circuit-breaker.js";
import { BackpressureController } from "../../src/core/backpressure.js";
import { WorkerDelegationGateway } from "../../src/worker/worker-gateway.js";
import { MockWorkerAdapter } from "../../src/worker/adapters/mock-adapter.js";
import {
  CircuitState,
  PermitRejectionReason,
  WorkerKind,
  WorkerCapability,
  OutputMode,
  WorkerStatus,
} from "../../src/types/index.js";
import type { PermitHandle, PermitRejection, WorkerTask } from "../../src/types/index.js";
import { createTestJob } from "../helpers/fixtures.js";

function isPermit(result: PermitHandle | PermitRejection): result is PermitHandle {
  return "permitId" in result;
}

function isRejection(result: PermitHandle | PermitRejection): result is PermitRejection {
  return "reason" in result;
}

function createComponents(cbConfig?: { failureThreshold?: number; resetTimeoutMs?: number; halfOpenMaxAttempts?: number }) {
  const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 100 });
  const cbRegistry = new CircuitBreakerRegistry({
    failureThreshold: cbConfig?.failureThreshold ?? 3,
    resetTimeoutMs: cbConfig?.resetTimeoutMs ?? 100,
    halfOpenMaxAttempts: cbConfig?.halfOpenMaxAttempts ?? 1,
  });
  const backpressure = new BackpressureController({
    rejectThreshold: 1.0,
    deferThreshold: 0.8,
    degradeThreshold: 0.5,
  });
  const permitGate = new PermitGate(budget, cbRegistry, backpressure);
  return { budget, cbRegistry, backpressure, permitGate };
}

function makeWorkerTask(permit: PermitHandle, overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    workerTaskId: crypto.randomUUID(),
    workerKind: WorkerKind.CLAUDE_CODE,
    workspaceRef: "/tmp/test-workspace",
    instructions: "test task",
    capabilities: [WorkerCapability.RUN_TESTS],
    outputMode: OutputMode.BATCH,
    budget: { deadlineAt: permit.deadlineAt },
    abortSignal: permit.abortController.signal,
    ...overrides,
  };
}

/**
 * Integration tests for Circuit Breaker flow:
 * Worker failures -> CB trips OPEN -> permit rejection -> reset -> recovery
 */
describe("Circuit breaker flow integration", () => {
  let permitGate: PermitGate;
  let cbRegistry: CircuitBreakerRegistry;

  afterEach(() => {
    permitGate?.dispose();
    cbRegistry?.dispose();
  });

  test("repeated worker failures trip circuit breaker to OPEN", () => {
    const components = createComponents({ failureThreshold: 3 });
    permitGate = components.permitGate;
    cbRegistry = components.cbRegistry;

    const cb = cbRegistry.getOrCreate("worker:claude-code");

    expect(cb.getState()).toBe(CircuitState.CLOSED);

    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.CLOSED);

    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.CLOSED);

    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.OPEN);
    expect(cb.isOpen()).toBe(true);
    expect(cb.getFailureCount()).toBe(3);
  });

  test("CB OPEN causes permit rejection with CIRCUIT_OPEN reason", () => {
    const components = createComponents({ failureThreshold: 3 });
    permitGate = components.permitGate;
    cbRegistry = components.cbRegistry;

    // Trip CB to OPEN for CLAUDE_CODE provider
    const cb = cbRegistry.getOrCreate("CLAUDE_CODE");
    for (let i = 0; i < 3; i++) {
      cb.recordFailure();
    }
    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Request permit with a WORKER_TASK job that has workerKind: CLAUDE_CODE
    const job = createTestJob({ payload: { workerKind: "CLAUDE_CODE" } });
    const result = permitGate.requestPermit(job, 0);

    expect(isRejection(result)).toBe(true);
    if (isRejection(result)) {
      expect(result.reason).toBe(PermitRejectionReason.CIRCUIT_OPEN);
      expect(result.detail).toContain("CLAUDE_CODE");
    }
  });

  test("CB auto-transitions from OPEN to HALF_OPEN after reset timeout", async () => {
    const resetTimeoutMs = 100;
    const components = createComponents({ failureThreshold: 3, resetTimeoutMs });
    permitGate = components.permitGate;
    cbRegistry = components.cbRegistry;

    const cb = cbRegistry.getOrCreate("worker:claude-code");
    for (let i = 0; i < 3; i++) {
      cb.recordFailure();
    }
    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Wait for the reset timeout to elapse
    await new Promise((resolve) => setTimeout(resolve, resetTimeoutMs + 50));

    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
  });

  test("successful probe in HALF_OPEN transitions CB back to CLOSED", async () => {
    const resetTimeoutMs = 100;
    const components = createComponents({ failureThreshold: 3, resetTimeoutMs });
    permitGate = components.permitGate;
    cbRegistry = components.cbRegistry;

    // Trip CB to OPEN
    const cb = cbRegistry.getOrCreate("worker:claude-code");
    for (let i = 0; i < 3; i++) {
      cb.recordFailure();
    }
    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Wait for HALF_OPEN
    await new Promise((resolve) => setTimeout(resolve, resetTimeoutMs + 50));
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);

    // Record success -> should transition back to CLOSED
    cb.recordSuccess();
    expect(cb.getState()).toBe(CircuitState.CLOSED);
    expect(cb.getFailureCount()).toBe(0);

    // Permits should be granted now
    const job = createTestJob();
    const result = permitGate.requestPermit(job, 0);
    expect(isPermit(result)).toBe(true);
    if (isPermit(result)) {
      permitGate.completePermit(result.permitId);
    }
  });

  test("worker failure in HALF_OPEN transitions CB back to OPEN", async () => {
    const resetTimeoutMs = 100;
    const components = createComponents({
      failureThreshold: 3,
      resetTimeoutMs,
      halfOpenMaxAttempts: 1,
    });
    permitGate = components.permitGate;
    cbRegistry = components.cbRegistry;

    // Trip CB to OPEN
    const cb = cbRegistry.getOrCreate("worker:claude-code");
    for (let i = 0; i < 3; i++) {
      cb.recordFailure();
    }
    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Wait for HALF_OPEN
    await new Promise((resolve) => setTimeout(resolve, resetTimeoutMs + 50));
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);

    // Record failure -> should transition back to OPEN
    cb.recordFailure();
    expect(cb.getState()).toBe(CircuitState.OPEN);
  });

  test("full flow: worker fails -> CB OPEN -> reject -> reset -> recover", async () => {
    const resetTimeoutMs = 150;
    const components = createComponents({
      failureThreshold: 3,
      resetTimeoutMs,
      halfOpenMaxAttempts: 1,
    });
    permitGate = components.permitGate;
    cbRegistry = components.cbRegistry;

    // Set up worker gateway with failing mock adapter
    const workerGateway = new WorkerDelegationGateway();
    const failingAdapter = new MockWorkerAdapter(WorkerKind.CLAUDE_CODE, {
      shouldFail: true,
      delayMs: 10,
    });
    workerGateway.registerAdapter(WorkerKind.CLAUDE_CODE, failingAdapter);

    const cb = cbRegistry.getOrCreate("CLAUDE_CODE");

    // Phase 1: Worker failures accumulate and trip the CB
    for (let i = 0; i < 3; i++) {
      const job = createTestJob({ jobId: `job-fail-${i}`, payload: { workerKind: "CLAUDE_CODE" } });
      const permitResult = permitGate.requestPermit(job, 0);
      expect(isPermit(permitResult)).toBe(true);
      if (!isPermit(permitResult)) continue;

      const task = makeWorkerTask(permitResult);
      const result = await workerGateway.delegateTask(task, permitResult);
      expect(result.status).toBe(WorkerStatus.FAILED);

      // Record failure on the CB (simulating what the core would do)
      cb.recordFailure();
      permitGate.completePermit(permitResult.permitId);
    }

    expect(cb.getState()).toBe(CircuitState.OPEN);

    // Phase 2: Subsequent permit requests are rejected (same workerKind)
    const rejectedJob = createTestJob({ jobId: "job-rejected", payload: { workerKind: "CLAUDE_CODE" } });
    const rejectedResult = permitGate.requestPermit(rejectedJob, 0);
    expect(isRejection(rejectedResult)).toBe(true);
    if (isRejection(rejectedResult)) {
      expect(rejectedResult.reason).toBe(PermitRejectionReason.CIRCUIT_OPEN);
    }

    // Phase 3: Wait for reset timeout -> HALF_OPEN
    await new Promise((resolve) => setTimeout(resolve, resetTimeoutMs + 50));
    expect(cb.getState()).toBe(CircuitState.HALF_OPEN);

    // Phase 4: Swap to succeeding adapter, probe succeeds -> CLOSED
    const succeedingAdapter = new MockWorkerAdapter(WorkerKind.CLAUDE_CODE, {
      shouldFail: false,
      delayMs: 10,
    });
    workerGateway.registerAdapter(WorkerKind.CLAUDE_CODE, succeedingAdapter);

    const probeJob = createTestJob({ jobId: "job-probe", payload: { workerKind: "CLAUDE_CODE" } });
    const probePermitResult = permitGate.requestPermit(probeJob, 0);
    expect(isPermit(probePermitResult)).toBe(true);
    if (!isPermit(probePermitResult)) return;

    const probeTask = makeWorkerTask(probePermitResult);
    const probeResult = await workerGateway.delegateTask(probeTask, probePermitResult);
    expect(probeResult.status).toBe(WorkerStatus.SUCCEEDED);

    // Record success on the CB
    cb.recordSuccess();
    permitGate.completePermit(probePermitResult.permitId);
    expect(cb.getState()).toBe(CircuitState.CLOSED);

    // Phase 5: New permits are granted normally
    const normalJob = createTestJob({ jobId: "job-normal" });
    const normalResult = permitGate.requestPermit(normalJob, 0);
    expect(isPermit(normalResult)).toBe(true);
    if (isPermit(normalResult)) {
      permitGate.completePermit(normalResult.permitId);
    }
  });

  test("fallback to different worker when one worker's CB is OPEN", () => {
    const components = createComponents({ failureThreshold: 3 });
    permitGate = components.permitGate;
    cbRegistry = components.cbRegistry;

    // Register two adapters
    const workerGateway = new WorkerDelegationGateway();
    workerGateway.registerAdapter(
      WorkerKind.CLAUDE_CODE,
      new MockWorkerAdapter(WorkerKind.CLAUDE_CODE),
    );
    workerGateway.registerAdapter(
      WorkerKind.CODEX_CLI,
      new MockWorkerAdapter(WorkerKind.CODEX_CLI),
    );

    // Trip CB for CLAUDE_CODE only
    const claudeCb = cbRegistry.getOrCreate("CLAUDE_CODE");
    for (let i = 0; i < 3; i++) {
      claudeCb.recordFailure();
    }
    expect(claudeCb.getState()).toBe(CircuitState.OPEN);

    // The codex CB should not exist or be CLOSED
    const codexCb = cbRegistry.get("CODEX_CLI");
    expect(codexCb).toBeUndefined();

    // Provider-specific CB: CLAUDE_CODE jobs are rejected
    const claudeJob = createTestJob({ jobId: "job-claude", payload: { workerKind: "CLAUDE_CODE" } });
    const claudeResult = permitGate.requestPermit(claudeJob, 0);
    expect(isRejection(claudeResult)).toBe(true);
    if (isRejection(claudeResult)) {
      expect(claudeResult.reason).toBe(PermitRejectionReason.CIRCUIT_OPEN);
      expect(claudeResult.detail).toContain("CLAUDE_CODE");
    }

    // But CODEX_CLI jobs are allowed — provider-specific isolation
    const codexJob = createTestJob({ jobId: "job-codex", payload: { workerKind: "CODEX_CLI" } });
    const codexResult = permitGate.requestPermit(codexJob, 0);
    expect(isPermit(codexResult)).toBe(true);
    if (isPermit(codexResult)) {
      permitGate.completePermit(codexResult.permitId);
    }

    // The CB for codex-cli is independently tracked and is not OPEN
    const codexCbCreated = cbRegistry.getOrCreate("CODEX_CLI");
    expect(codexCbCreated.getState()).toBe(CircuitState.CLOSED);
    expect(codexCbCreated.isOpen()).toBe(false);
  });
});
