import { describe, test, expect } from "bun:test";
import { ProcessManager } from "../../../src/worker/process-manager.js";

describe("ProcessManager", () => {
  test("spawn runs a simple command and captures stdout", async () => {
    const pm = new ProcessManager();
    const managed = pm.spawn({ command: ["echo", "hello"] });

    expect(managed.pid).toBeGreaterThan(0);

    const exitCode = await managed.exitPromise;
    expect(exitCode).toBe(0);

    const output = await new Response(managed.stdout).text();
    expect(output.trim()).toBe("hello");
  });

  test("spawn captures stderr", async () => {
    const pm = new ProcessManager();
    const managed = pm.spawn({ command: ["sh", "-c", "echo error >&2"] });

    const exitCode = await managed.exitPromise;
    expect(exitCode).toBe(0);

    const output = await new Response(managed.stderr).text();
    expect(output.trim()).toBe("error");
  });

  test("tracks active process count", async () => {
    const pm = new ProcessManager();
    const managed = pm.spawn({ command: ["sleep", "0.5"] });

    expect(pm.getActiveCount()).toBe(1);

    await managed.exitPromise;
    expect(pm.getActiveCount()).toBe(0);
  });

  test("kill terminates a running process", async () => {
    const pm = new ProcessManager();
    const managed = pm.spawn({ command: ["sleep", "10"] });

    expect(pm.getActiveCount()).toBe(1);
    pm.kill(managed.pid);

    const exitCode = await managed.exitPromise;
    // Killed processes return non-zero (signal-based exit)
    expect(exitCode).not.toBe(0);
  });

  test("gracefulShutdown sends SIGTERM then SIGKILL if needed", async () => {
    const pm = new ProcessManager();
    const managed = pm.spawn({ command: ["sleep", "30"] });

    await pm.gracefulShutdown(managed.pid, 500);
    expect(pm.getActiveCount()).toBe(0);
  });

  test("abort signal kills the process", async () => {
    const pm = new ProcessManager();
    const ac = new AbortController();

    const managed = pm.spawn({
      command: ["sleep", "10"],
      abortSignal: ac.signal,
    });

    // Abort after short delay
    setTimeout(() => ac.abort(), 50);

    const exitCode = await managed.exitPromise;
    expect(exitCode).not.toBe(0);
  });

  test("killAll terminates all processes", async () => {
    const pm = new ProcessManager();
    pm.spawn({ command: ["sleep", "10"] });
    pm.spawn({ command: ["sleep", "10"] });

    expect(pm.getActiveCount()).toBe(2);

    await pm.killAll();
    expect(pm.getActiveCount()).toBe(0);
  });

  test("spawn with cwd sets working directory", async () => {
    const pm = new ProcessManager();
    const managed = pm.spawn({
      command: ["pwd"],
      cwd: "/tmp",
    });

    const exitCode = await managed.exitPromise;
    expect(exitCode).toBe(0);

    const output = await new Response(managed.stdout).text();
    // /tmp might be a symlink to /private/tmp on macOS
    expect(output.trim()).toContain("tmp");
  });

  test("timeoutMs kills the process after timeout", async () => {
    const pm = new ProcessManager();
    const managed = pm.spawn({
      command: ["sleep", "30"],
      timeoutMs: 200,
    });

    const exitCode = await managed.exitPromise;
    expect(exitCode).not.toBe(0);
  });
});
