import { describe, test, expect } from "bun:test";
import { Supervisor } from "../../../src/scheduler/supervisor.js";

describe("Supervisor", () => {
  test("starts not running", () => {
    const supervisor = new Supervisor();
    expect(supervisor.isRunning()).toBe(false);
  });

  test("getIpc returns null before spawn", () => {
    const supervisor = new Supervisor();
    expect(supervisor.getIpc()).toBeNull();
  });

  test("onCoreCrash callback can be set", () => {
    const supervisor = new Supervisor();
    let called = false;
    supervisor.onCoreCrash(() => {
      called = true;
    });
    // Just verifying it doesn't throw
    expect(called).toBe(false);
  });

  test("onCoreHang callback can be set", () => {
    const supervisor = new Supervisor();
    let called = false;
    supervisor.onCoreHang(() => {
      called = true;
    });
    expect(called).toBe(false);
  });

  test("accepts custom config", () => {
    const supervisor = new Supervisor({
      coreEntryPoint: "custom/entry.ts",
      healthCheck: { intervalMs: 1000 },
    });
    expect(supervisor.isRunning()).toBe(false);
  });

  test("killCore when not running is a no-op", async () => {
    const supervisor = new Supervisor();
    await supervisor.killCore(); // should not throw
    expect(supervisor.isRunning()).toBe(false);
  });
});
