import type { WorkerKind, WorkerTask } from "../types/index.js";
import type { PermitHandle } from "../types/index.js";
import type { WorkerResult } from "../types/index.js";
import type { WorkerAdapter, WorkerHandle } from "./worker-adapter.js";

export class WorkerDelegationGateway {
  private adapters = new Map<WorkerKind, WorkerAdapter>();
  private activeHandles = new Map<string, { handle: WorkerHandle; adapter: WorkerAdapter }>();

  registerAdapter(kind: WorkerKind, adapter: WorkerAdapter): void {
    this.adapters.set(kind, adapter);
  }

  async delegateTask(task: WorkerTask, permit: PermitHandle): Promise<WorkerResult> {
    const adapter = this.adapters.get(task.workerKind);
    if (!adapter) {
      throw new Error(`No adapter registered for worker kind: ${task.workerKind}`);
    }

    let handle: WorkerHandle;
    try {
      handle = await adapter.startTask(task);
    } catch (err) {
      // startTask failed — no handle to clean up
      throw err;
    }

    this.activeHandles.set(handle.handleId, { handle, adapter });

    // Wire permit's abort signal to cancel the worker handle
    const onAbort = () => {
      adapter.cancel(handle).catch(() => {});
    };

    if (permit.abortController.signal.aborted) {
      await adapter.cancel(handle);
    } else {
      permit.abortController.signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      const result = await adapter.awaitResult(handle);
      return result;
    } catch (err) {
      // awaitResult failed — cancel the worker to avoid leaving it running
      await adapter.cancel(handle).catch(() => {});
      throw err;
    } finally {
      this.activeHandles.delete(handle.handleId);
      permit.abortController.signal.removeEventListener("abort", onAbort);
    }
  }

  getActiveWorkerCount(): number {
    return this.activeHandles.size;
  }

  async cancelAll(): Promise<void> {
    const cancelPromises: Promise<void>[] = [];
    for (const { handle, adapter } of this.activeHandles.values()) {
      cancelPromises.push(adapter.cancel(handle));
    }
    await Promise.allSettled(cancelPromises);
    this.activeHandles.clear();
  }
}
