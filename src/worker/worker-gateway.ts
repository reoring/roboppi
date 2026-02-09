import type { WorkerKind, WorkerTask } from "../types/index.js";
import type { PermitHandle } from "../types/index.js";
import type { WorkerResult } from "../types/index.js";
import type { WorkerAdapter, WorkerHandle } from "./worker-adapter.js";
import type { WorkspaceLock } from "./workspace-lock.js";

export interface DelegateTaskOptions {
  acquireTimeoutMs?: number;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30000;

export class WorkerDelegationGateway {
  private adapters = new Map<WorkerKind, WorkerAdapter>();
  private activeHandles = new Map<string, { handle: WorkerHandle; adapter: WorkerAdapter }>();
  private readonly workspaceLock: WorkspaceLock | undefined;

  constructor(workspaceLock?: WorkspaceLock) {
    this.workspaceLock = workspaceLock;
  }

  registerAdapter(kind: WorkerKind, adapter: WorkerAdapter): void {
    this.adapters.set(kind, adapter);
  }

  async delegateTask(
    task: WorkerTask,
    permit: PermitHandle,
    options?: DelegateTaskOptions,
  ): Promise<WorkerResult> {
    const adapter = this.adapters.get(task.workerKind);
    if (!adapter) {
      throw new Error(`No adapter registered for worker kind: ${task.workerKind}`);
    }

    // Acquire workspace lock if WorkspaceLock is configured
    const lockId = permit.permitId;
    if (this.workspaceLock) {
      const acquireTimeoutMs = options?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
      const acquired = await this.workspaceLock.waitForLock(
        task.workspaceRef,
        lockId,
        acquireTimeoutMs,
      );
      if (!acquired) {
        throw new Error(
          `Failed to acquire workspace lock for "${task.workspaceRef}" within ${acquireTimeoutMs}ms`,
        );
      }
    }

    let handle: WorkerHandle;
    try {
      handle = await adapter.startTask(task);
    } catch (err) {
      // startTask failed — release lock and re-throw
      if (this.workspaceLock) {
        this.workspaceLock.release(task.workspaceRef, lockId);
      }
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

    // Set up deadline timeout — cancel the worker if permit deadline passes
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const remainingMs = permit.deadlineAt - Date.now();
    if (remainingMs > 0) {
      deadlineTimer = setTimeout(() => {
        adapter.cancel(handle).catch(() => {});
      }, remainingMs);
    } else if (!permit.abortController.signal.aborted) {
      // Deadline already passed — cancel immediately
      await adapter.cancel(handle);
    }

    try {
      const result = await adapter.awaitResult(handle);
      return result;
    } catch (err) {
      // awaitResult failed — cancel the worker to avoid leaving it running
      await adapter.cancel(handle).catch(() => {});
      throw err;
    } finally {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      this.activeHandles.delete(handle.handleId);
      permit.abortController.signal.removeEventListener("abort", onAbort);
      if (this.workspaceLock) {
        this.workspaceLock.release(task.workspaceRef, lockId);
      }
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
