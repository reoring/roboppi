import { generateId } from "../../types/index.js";
import { WorkerStatus } from "../../types/index.js";
import type { WorkerKind, WorkerTask } from "../../types/index.js";
import type { WorkerResult } from "../../types/index.js";
import type { WorkerAdapter, WorkerHandle, WorkerEvent } from "../worker-adapter.js";

export interface MockAdapterOptions {
  delayMs?: number;
  shouldFail?: boolean;
  shouldTimeout?: boolean;
  shouldRespectCancel?: boolean;
  events?: WorkerEvent[];
}

export class MockWorkerAdapter implements WorkerAdapter {
  readonly kind: WorkerKind;
  private options: Required<MockAdapterOptions>;
  private cancelledHandles = new Set<string>();
  private startTimes = new Map<string, number>();

  constructor(kind: WorkerKind, options: MockAdapterOptions = {}) {
    this.kind = kind;
    this.options = {
      delayMs: options.delayMs ?? 10,
      shouldFail: options.shouldFail ?? false,
      shouldTimeout: options.shouldTimeout ?? false,
      shouldRespectCancel: options.shouldRespectCancel ?? true,
      events: options.events ?? [],
    };
  }

  async startTask(task: WorkerTask): Promise<WorkerHandle> {
    const handle: WorkerHandle = {
      handleId: generateId(),
      workerKind: task.workerKind,
      abortSignal: task.abortSignal,
    };
    this.startTimes.set(handle.handleId, Date.now());
    return handle;
  }

  async *streamEvents(handle: WorkerHandle): AsyncIterable<WorkerEvent> {
    for (const event of this.options.events) {
      if (this.cancelledHandles.has(handle.handleId)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
      yield event;
    }
  }

  async cancel(handle: WorkerHandle): Promise<void> {
    if (this.options.shouldRespectCancel) {
      this.cancelledHandles.add(handle.handleId);
    }
  }

  async awaitResult(handle: WorkerHandle): Promise<WorkerResult> {
    const startTime = this.startTimes.get(handle.handleId) ?? Date.now();

    if (this.options.shouldTimeout) {
      // Never resolve - wait forever (caller should abort)
      return new Promise<WorkerResult>((resolve) => {
        if (this.options.shouldRespectCancel) {
          const checkInterval = setInterval(() => {
            if (this.cancelledHandles.has(handle.handleId)) {
              clearInterval(checkInterval);
              const durationMs = Date.now() - startTime;
              resolve({
                status: WorkerStatus.CANCELLED,
                artifacts: [],
                observations: [],
                cost: { wallTimeMs: 0 },
                durationMs,
              });
            }
          }, 10);
        }
        // Otherwise truly never resolves
      });
    }

    await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));

    const durationMs = Date.now() - startTime;

    if (this.cancelledHandles.has(handle.handleId)) {
      return {
        status: WorkerStatus.CANCELLED,
        artifacts: [],
        observations: [],
        cost: { wallTimeMs: this.options.delayMs },
        durationMs,
      };
    }

    if (this.options.shouldFail) {
      return {
        status: WorkerStatus.FAILED,
        artifacts: [],
        observations: [],
        cost: { wallTimeMs: this.options.delayMs },
        durationMs,
      };
    }

    return {
      status: WorkerStatus.SUCCEEDED,
      artifacts: [],
      observations: [],
      cost: { wallTimeMs: this.options.delayMs },
      durationMs,
    };
  }
}
