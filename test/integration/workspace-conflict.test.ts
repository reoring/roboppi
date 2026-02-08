import { describe, test, expect } from "bun:test";
import { WorkspaceLock } from "../../src/worker/workspace-lock.js";
import { generateId } from "../../src/types/index.js";

describe("Workspace lock conflict integration", () => {
  test("two tasks for same workspace: first gets lock, second waits", async () => {
    const lock = new WorkspaceLock();
    const ws = "/workspace/shared";
    const task1 = generateId();
    const task2 = generateId();

    // Task 1 acquires lock
    expect(lock.acquire(ws, task1)).toBe(true);
    expect(lock.isLocked(ws)).toBe(true);

    // Task 2 cannot acquire immediately
    expect(lock.acquire(ws, task2)).toBe(false);

    // Task 2 starts waiting; task 1 releases after 150ms
    setTimeout(() => lock.release(ws, task1), 150);

    const acquired = await lock.waitForLock(ws, task2, 2000);
    expect(acquired).toBe(true);
    expect(lock.isLocked(ws)).toBe(true);

    // Verify task2 holds the lock now
    expect(lock.release(ws, task2)).toBe(true);
  });

  test("lock release allows waiting task to proceed", async () => {
    const lock = new WorkspaceLock();
    const ws = "/workspace/release-test";
    const holder = generateId();
    const waiter = generateId();

    lock.acquire(ws, holder);

    // Start two concurrent operations: waiter waits, holder releases
    const waitPromise = lock.waitForLock(ws, waiter, 5000);

    // Release after a short delay
    await new Promise((r) => setTimeout(r, 120));
    lock.release(ws, holder);

    const acquired = await waitPromise;
    expect(acquired).toBe(true);

    // The wait time should reflect the actual wait
    const waitTime = lock.getWaitTimeMs(ws);
    expect(waitTime).toBeGreaterThanOrEqual(100);
  });

  test("lock timeout: waiting task gives up after timeout", async () => {
    const lock = new WorkspaceLock();
    const ws = "/workspace/timeout-test";
    const holder = generateId();
    const waiter = generateId();

    lock.acquire(ws, holder);

    // Waiter has a very short timeout — holder never releases
    const acquired = await lock.waitForLock(ws, waiter, 200);
    expect(acquired).toBe(false);

    // Original holder still holds the lock
    expect(lock.isLocked(ws)).toBe(true);
    expect(lock.release(ws, holder)).toBe(true);
  });

  test("multiple waiters queue for the same workspace", async () => {
    const lock = new WorkspaceLock();
    const ws = "/workspace/multi-waiter";
    const holder = generateId();
    const waiter1 = generateId();
    const waiter2 = generateId();

    lock.acquire(ws, holder);

    // Both waiters start waiting
    const wait1 = lock.waitForLock(ws, waiter1, 2000);
    const wait2 = lock.waitForLock(ws, waiter2, 2000);

    // Release holder — one waiter should acquire
    await new Promise((r) => setTimeout(r, 120));
    lock.release(ws, holder);

    const result1 = await wait1;
    // If waiter1 acquired, release it so waiter2 can proceed
    if (result1) {
      await new Promise((r) => setTimeout(r, 120));
      lock.release(ws, waiter1);
    }

    const result2 = await wait2;

    // At least one should have acquired the lock at some point
    expect(result1 || result2).toBe(true);
  });

  test("different workspaces do not conflict", async () => {
    const lock = new WorkspaceLock();
    const task1 = generateId();
    const task2 = generateId();

    expect(lock.acquire("/workspace/a", task1)).toBe(true);
    expect(lock.acquire("/workspace/b", task2)).toBe(true);

    // Both are locked independently
    expect(lock.isLocked("/workspace/a")).toBe(true);
    expect(lock.isLocked("/workspace/b")).toBe(true);

    lock.release("/workspace/a", task1);
    expect(lock.isLocked("/workspace/a")).toBe(false);
    expect(lock.isLocked("/workspace/b")).toBe(true);
  });

  test("re-acquiring same workspace by same task fails", () => {
    const lock = new WorkspaceLock();
    const task = generateId();
    const ws = "/workspace/reacquire";

    expect(lock.acquire(ws, task)).toBe(true);
    // Same task tries to acquire again — should fail because lock is held
    expect(lock.acquire(ws, task)).toBe(false);
  });

  test("release by wrong holder does not free the lock", () => {
    const lock = new WorkspaceLock();
    const holder = generateId();
    const imposter = generateId();
    const ws = "/workspace/imposter";

    lock.acquire(ws, holder);
    expect(lock.release(ws, imposter)).toBe(false);
    expect(lock.isLocked(ws)).toBe(true);
  });
});
