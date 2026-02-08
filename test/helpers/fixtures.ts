import type { Job, PermitHandle, WorkerTask } from "../../src/types/index.js";
import { JobType, PriorityClass, CircuitState, WorkerKind, WorkerCapability, OutputMode } from "../../src/types/index.js";

// Deterministic UUIDs for reproducible tests
export const TEST_IDS = {
  JOB_1: "00000000-0000-4000-a000-000000000001",
  JOB_2: "00000000-0000-4000-a000-000000000002",
  JOB_3: "00000000-0000-4000-a000-000000000003",
  PERMIT_1: "00000000-0000-4000-b000-000000000001",
  PERMIT_2: "00000000-0000-4000-b000-000000000002",
  WORKER_TASK_1: "00000000-0000-4000-c000-000000000001",
  TRACE_1: "00000000-0000-4000-d000-000000000001",
  CORRELATION_1: "00000000-0000-4000-e000-000000000001",
} as const;

export function createTestJob(overrides: Partial<Job> = {}): Job {
  return {
    jobId: TEST_IDS.JOB_1,
    type: JobType.WORKER_TASK,
    priority: { value: 1, class: PriorityClass.INTERACTIVE },
    payload: { task: "test task" },
    limits: { timeoutMs: 5000, maxAttempts: 3 },
    context: { traceId: TEST_IDS.TRACE_1, correlationId: TEST_IDS.CORRELATION_1 },
    ...overrides,
  };
}

export function createTestWorkerTask(overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    workerTaskId: TEST_IDS.WORKER_TASK_1,
    workerKind: WorkerKind.CLAUDE_CODE,
    workspaceRef: "/tmp/test-workspace",
    instructions: "Run the test suite",
    capabilities: [WorkerCapability.RUN_TESTS],
    outputMode: OutputMode.BATCH,
    budget: { deadlineAt: Date.now() + 5000 },
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

export function createTestPermit(overrides: Partial<PermitHandle> = {}): PermitHandle {
  return {
    permitId: TEST_IDS.PERMIT_1,
    jobId: TEST_IDS.JOB_1,
    deadlineAt: Date.now() + 5000,
    attemptIndex: 0,
    abortController: new AbortController(),
    tokensGranted: { concurrency: 1, rps: 1 },
    circuitStateSnapshot: {} as Record<string, CircuitState>,
    ...overrides,
  };
}

/**
 * Creates a pair of TransformStreams that simulate IPC between
 * a "scheduler" (writer side) and "core" (reader side).
 *
 * Returns:
 * - schedulerToCore: scheduler writes here, core reads from here
 * - coreToScheduler: core writes here, scheduler reads from here
 */
export function createIpcStreamPair() {
  const schedulerToCore = new TransformStream<Uint8Array, Uint8Array>();
  const coreToScheduler = new TransformStream<Uint8Array, Uint8Array>();

  return {
    // Core's perspective: reads from schedulerToCore, writes to coreToScheduler
    coreInput: schedulerToCore.readable,
    coreOutput: coreToScheduler.writable,
    // Scheduler's perspective: writes to schedulerToCore, reads from coreToScheduler
    schedulerOutput: schedulerToCore.writable,
    schedulerInput: coreToScheduler.readable,
  };
}
