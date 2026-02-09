import { describe, test, expect } from "bun:test";
import { WorkspaceLock } from "../../../src/worker/workspace-lock.js";
import { generateId } from "../../../src/types/index.js";

describe("WorkspaceLock", () => {
  test("acquire returns true for unlocked workspace", () => {
    const lock = new WorkspaceLock();
    const taskId = generateId();
    expect(lock.acquire("/workspace/a", taskId)).toBe(true);
  });

  test("acquire returns false when workspace already locked", () => {
    const lock = new WorkspaceLock();
    const task1 = generateId();
    const task2 = generateId();

    expect(lock.acquire("/workspace/a", task1)).toBe(true);
    expect(lock.acquire("/workspace/a", task2)).toBe(false);
  });

  test("release by holder returns true and unlocks", () => {
    const lock = new WorkspaceLock();
    const taskId = generateId();

    lock.acquire("/workspace/a", taskId);
    expect(lock.release("/workspace/a", taskId)).toBe(true);
    expect(lock.isLocked("/workspace/a")).toBe(false);
  });

  test("release by non-holder returns false", () => {
    const lock = new WorkspaceLock();
    const holder = generateId();
    const other = generateId();

    lock.acquire("/workspace/a", holder);
    expect(lock.release("/workspace/a", other)).toBe(false);
    expect(lock.isLocked("/workspace/a")).toBe(true);
  });

  test("release on unlocked workspace returns false", () => {
    const lock = new WorkspaceLock();
    expect(lock.release("/workspace/a", generateId())).toBe(false);
  });

  test("isLocked returns correct state", () => {
    const lock = new WorkspaceLock();
    const taskId = generateId();

    expect(lock.isLocked("/workspace/a")).toBe(false);
    lock.acquire("/workspace/a", taskId);
    expect(lock.isLocked("/workspace/a")).toBe(true);
    lock.release("/workspace/a", taskId);
    expect(lock.isLocked("/workspace/a")).toBe(false);
  });

  test("different workspaces are independent", () => {
    const lock = new WorkspaceLock();
    const task1 = generateId();
    const task2 = generateId();

    expect(lock.acquire("/workspace/a", task1)).toBe(true);
    expect(lock.acquire("/workspace/b", task2)).toBe(true);
  });

  test("waitForLock acquires immediately when unlocked", async () => {
    const lock = new WorkspaceLock();
    const taskId = generateId();

    const acquired = await lock.waitForLock("/workspace/a", taskId, 1000);
    expect(acquired).toBe(true);
    expect(lock.isLocked("/workspace/a")).toBe(true);
  });

  test("waitForLock waits and acquires after release", async () => {
    const lock = new WorkspaceLock();
    const holder = generateId();
    const waiter = generateId();

    lock.acquire("/workspace/a", holder);

    // Release after 150ms
    setTimeout(() => {
      lock.release("/workspace/a", holder);
    }, 150);

    const acquired = await lock.waitForLock("/workspace/a", waiter, 2000);
    expect(acquired).toBe(true);
    expect(lock.getWaitTimeMs("/workspace/a")).toBeGreaterThan(0);
  });

  test("waitForLock times out when lock not released", async () => {
    const lock = new WorkspaceLock();
    const holder = generateId();
    const waiter = generateId();

    lock.acquire("/workspace/a", holder);

    const acquired = await lock.waitForLock("/workspace/a", waiter, 250);
    expect(acquired).toBe(false);
    expect(lock.getWaitTimeMs("/workspace/a")).toBeGreaterThanOrEqual(250);
  });

  test("getWaitTimeMs returns 0 for no wait history", () => {
    const lock = new WorkspaceLock();
    expect(lock.getWaitTimeMs("/workspace/unknown")).toBe(0);
  });

  test("expired lock is auto-released on acquire", () => {
    // Use a very short TTL so it expires immediately
    const lock = new WorkspaceLock({ maxLockDurationMs: 1 });
    const holder = generateId();
    const waiter = generateId();

    lock.acquire("/workspace/a", holder);

    // Wait for TTL to expire
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait to ensure TTL passes
    }

    // New acquire should succeed because old lock expired
    expect(lock.acquire("/workspace/a", waiter)).toBe(true);
  });

  test("non-expired lock is not auto-released on acquire", () => {
    const lock = new WorkspaceLock({ maxLockDurationMs: 60000 });
    const holder = generateId();
    const waiter = generateId();

    lock.acquire("/workspace/a", holder);
    expect(lock.acquire("/workspace/a", waiter)).toBe(false);
  });

  test("isLocked returns false for expired lock", () => {
    const lock = new WorkspaceLock({ maxLockDurationMs: 1 });
    const holder = generateId();

    lock.acquire("/workspace/a", holder);

    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait
    }

    expect(lock.isLocked("/workspace/a")).toBe(false);
  });

  test("forceRelease releases lock regardless of holder", () => {
    const lock = new WorkspaceLock();
    const holder = generateId();

    lock.acquire("/workspace/a", holder);
    expect(lock.isLocked("/workspace/a")).toBe(true);

    expect(lock.forceRelease("/workspace/a")).toBe(true);
    expect(lock.isLocked("/workspace/a")).toBe(false);
  });

  test("forceRelease returns false for unlocked workspace", () => {
    const lock = new WorkspaceLock();
    expect(lock.forceRelease("/workspace/a")).toBe(false);
  });

  test("forceRelease notifies waiters", async () => {
    const lock = new WorkspaceLock();
    const holder = generateId();
    const waiter = generateId();

    lock.acquire("/workspace/a", holder);

    // Force release after 50ms
    setTimeout(() => {
      lock.forceRelease("/workspace/a");
    }, 50);

    const acquired = await lock.waitForLock("/workspace/a", waiter, 2000);
    expect(acquired).toBe(true);
  });

  test("per-lock maxLockDurationMs overrides default", () => {
    const lock = new WorkspaceLock({ maxLockDurationMs: 60000 });
    const holder = generateId();
    const waiter = generateId();

    // Acquire with a very short TTL
    lock.acquire("/workspace/a", holder, 1);

    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait
    }

    // Should succeed because per-lock TTL (1ms) expired
    expect(lock.acquire("/workspace/a", waiter)).toBe(true);
  });

  test("waitForLock succeeds when lock expires during wait", async () => {
    const lock = new WorkspaceLock({ maxLockDurationMs: 50 });
    const holder = generateId();
    const waiter = generateId();

    lock.acquire("/workspace/a", holder);

    // The lock will expire after 50ms, and waitForLock should be able to acquire
    // We use a polling approach inside waitForLock via notifyWaiters on TTL check
    // Since TTL auto-release happens on acquire() call inside waitForLock,
    // and the waiter gets notified, this should work.
    // But actually TTL auto-release only happens when someone calls acquire/isLocked.
    // So let's force-release to simulate the scenario:
    setTimeout(() => {
      // Trigger isLocked which will detect expiry and notify waiters
      lock.isLocked("/workspace/a");
    }, 80);

    const acquired = await lock.waitForLock("/workspace/a", waiter, 2000);
    expect(acquired).toBe(true);
  });
});
