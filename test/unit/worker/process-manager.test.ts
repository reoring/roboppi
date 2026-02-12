import { describe, test, expect } from "bun:test";
import { ProcessManager } from "../../../src/worker/process-manager.js";

const HAS_SETSID = process.platform !== "win32" && Bun.which("setsid") !== null;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidToExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
}

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return buffer;
      buffer += decoder.decode(value, { stream: true });
      const nl = buffer.indexOf("\n");
      if (nl !== -1) return buffer.slice(0, nl);
    }
  } finally {
    reader.releaseLock();
  }
}

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

  (HAS_SETSID ? test : test.skip)(
    "processGroup kill terminates child processes",
    async () => {
      const pm = new ProcessManager();

      // Start a shell that spawns a background child and prints its PID.
      const managed = pm.spawn({
        command: ["sh", "-c", "sleep 30 & echo CHILD_PID=$!; wait"],
        processGroup: true,
      });

      let childPid = 0;
      try {
        // Ensure we have the child PID before killing.
        const guard = setTimeout(() => pm.kill(managed.pid), 2000);
        const line = await readFirstLine(managed.stdout);
        clearTimeout(guard);

        const m = line.match(/CHILD_PID=(\d+)/);
        expect(m).not.toBeNull();
        childPid = Number(m![1]);
        expect(childPid).toBeGreaterThan(0);
        expect(isProcessAlive(childPid)).toBe(true);

        pm.kill(managed.pid);
        await managed.exitPromise;

        await waitForPidToExit(childPid, 2000);
        expect(isProcessAlive(childPid)).toBe(false);
      } finally {
        if (childPid > 0 && isProcessAlive(childPid)) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            // ignore
          }
        }
      }
    },
  );

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
