import type { UUID } from "../types/index.js";

interface LockEntry {
  holder: UUID;
  acquiredAt: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 30000;

export class WorkspaceLock {
  private locks = new Map<string, LockEntry>();
  private waitTimes = new Map<string, number>();
  private waiters = new Map<string, Array<() => void>>();

  acquire(workspaceRef: string, taskId: UUID): boolean {
    if (this.locks.has(workspaceRef)) {
      return false;
    }
    this.locks.set(workspaceRef, { holder: taskId, acquiredAt: Date.now() });
    return true;
  }

  release(workspaceRef: string, taskId: UUID): boolean {
    const entry = this.locks.get(workspaceRef);
    if (!entry || entry.holder !== taskId) {
      return false;
    }
    this.locks.delete(workspaceRef);

    // Notify the next waiter in queue
    const queue = this.waiters.get(workspaceRef);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) {
        this.waiters.delete(workspaceRef);
      }
      next();
    }

    return true;
  }

  isLocked(workspaceRef: string): boolean {
    return this.locks.has(workspaceRef);
  }

  async waitForLock(
    workspaceRef: string,
    taskId: UUID,
    timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
  ): Promise<boolean> {
    const startTime = Date.now();

    // Try to acquire immediately (atomic check-and-set)
    if (this.acquire(workspaceRef, taskId)) {
      this.waitTimes.set(workspaceRef, 0);
      return true;
    }

    // Promise-based waiting: enqueue a waiter that resolves when lock is released
    return new Promise<boolean>((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Remove ourselves from the waiters queue
        const queue = this.waiters.get(workspaceRef);
        if (queue) {
          const idx = queue.indexOf(onRelease);
          if (idx !== -1) queue.splice(idx, 1);
          if (queue.length === 0) this.waiters.delete(workspaceRef);
        }
        this.waitTimes.set(workspaceRef, Date.now() - startTime);
        resolve(false);
      }, timeoutMs);

      const onRelease = () => {
        if (settled) return;
        // Try atomic acquire — another waiter may have grabbed it
        if (this.acquire(workspaceRef, taskId)) {
          settled = true;
          clearTimeout(timer);
          this.waitTimes.set(workspaceRef, Date.now() - startTime);
          resolve(true);
        } else {
          // Re-enqueue ourselves to wait for next release
          let queue = this.waiters.get(workspaceRef);
          if (!queue) {
            queue = [];
            this.waiters.set(workspaceRef, queue);
          }
          queue.push(onRelease);
        }
      };

      let queue = this.waiters.get(workspaceRef);
      if (!queue) {
        queue = [];
        this.waiters.set(workspaceRef, queue);
      }
      queue.push(onRelease);
    });
  }

  getWaitTimeMs(workspaceRef: string): number {
    return this.waitTimes.get(workspaceRef) ?? 0;
  }
}
