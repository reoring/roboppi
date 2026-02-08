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
});
