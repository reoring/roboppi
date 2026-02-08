import { describe, test, expect } from "bun:test";
import { CancellationManager } from "../../../src/core/cancellation.js";

describe("CancellationManager", () => {
  test("createController returns an AbortController", () => {
    const mgr = new CancellationManager();
    const controller = mgr.createController("permit-1");
    expect(controller).toBeInstanceOf(AbortController);
    expect(controller.signal.aborted).toBe(false);
  });

  test("cancel aborts the controller", () => {
    const mgr = new CancellationManager();
    mgr.createController("permit-1");
    expect(mgr.isAborted("permit-1")).toBe(false);

    mgr.cancel("permit-1", "test reason");
    expect(mgr.isAborted("permit-1")).toBe(true);
  });

  test("cancel with reason sets the abort reason", () => {
    const mgr = new CancellationManager();
    const controller = mgr.createController("permit-1");
    mgr.cancel("permit-1", "my-reason");
    expect(controller.signal.reason).toBe("my-reason");
  });

  test("cancel on non-existent permit is a no-op", () => {
    const mgr = new CancellationManager();
    // Should not throw
    mgr.cancel("nonexistent");
  });

  test("cancel on already-aborted permit is a no-op", () => {
    const mgr = new CancellationManager();
    mgr.createController("permit-1");
    mgr.cancel("permit-1", "first");
    // Should not throw when cancelling again
    mgr.cancel("permit-1", "second");
    expect(mgr.isAborted("permit-1")).toBe(true);
  });

  test("isAborted returns false for unknown permit", () => {
    const mgr = new CancellationManager();
    expect(mgr.isAborted("unknown")).toBe(false);
  });

  test("cancelByJobId cancels all permits for a job", () => {
    const mgr = new CancellationManager();
    mgr.createController("permit-1", "job-A");
    mgr.createController("permit-2", "job-A");
    mgr.createController("permit-3", "job-B");

    mgr.cancelByJobId("job-A", "job cancelled");

    expect(mgr.isAborted("permit-1")).toBe(true);
    expect(mgr.isAborted("permit-2")).toBe(true);
    expect(mgr.isAborted("permit-3")).toBe(false);
  });

  test("onAbort registers callback that fires on cancel", () => {
    const mgr = new CancellationManager();
    mgr.createController("permit-1");

    let called = false;
    mgr.onAbort("permit-1", () => {
      called = true;
    });

    expect(called).toBe(false);
    mgr.cancel("permit-1");
    expect(called).toBe(true);
  });

  test("onAbort fires immediately if already aborted", () => {
    const mgr = new CancellationManager();
    mgr.createController("permit-1");
    mgr.cancel("permit-1");

    let called = false;
    mgr.onAbort("permit-1", () => {
      called = true;
    });

    expect(called).toBe(true);
  });

  test("onAbort is a no-op for unknown permit", () => {
    const mgr = new CancellationManager();
    let called = false;
    mgr.onAbort("unknown", () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  test("removeController cleans up permit", () => {
    const mgr = new CancellationManager();
    mgr.createController("permit-1", "job-A");
    expect(mgr.isAborted("permit-1")).toBe(false);

    mgr.removeController("permit-1");
    // After removal, isAborted returns false (no controller found)
    expect(mgr.isAborted("permit-1")).toBe(false);

    // cancelByJobId should not find removed permit
    mgr.cancelByJobId("job-A");
    // no error thrown
  });
});
