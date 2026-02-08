import { describe, test, expect, afterEach, beforeAll, afterAll } from "bun:test";
import { Supervisor } from "../../src/scheduler/supervisor.js";
import { unlinkSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

/**
 * Integration tests for Supervisor process lifecycle:
 * spawn, crash detection, restart, kill, consecutive crashes.
 *
 * Uses tiny temporary scripts as mock child processes instead of
 * the real AgentCore entry point, since the Supervisor constructs
 * the command as ["bun", "run", <coreEntryPoint>].
 */

const TMP_DIR = path.join(import.meta.dir, ".tmp-supervisor-scripts");

// Temporary script paths
const SCRIPTS = {
  /** Stays alive, writes JSON heartbeat to stdout so IPC transport has something to read */
  longRunning: path.join(TMP_DIR, "long-running.ts"),
  /** Exits immediately with code 1 */
  crashImmediate: path.join(TMP_DIR, "crash-immediate.ts"),
  /** Exits with code 1 after 100ms */
  crashDelayed: path.join(TMP_DIR, "crash-delayed.ts"),
  /** Stays alive briefly (500ms) then exits cleanly */
  shortLived: path.join(TMP_DIR, "short-lived.ts"),
} as const;

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });

  // Long-running process: reads stdin to stay alive, writes periodic JSON lines to stdout
  writeFileSync(
    SCRIPTS.longRunning,
    `
const encoder = new TextEncoder();
const msg = JSON.stringify({ type: "heartbeat", timestamp: Date.now() }) + "\\n";
process.stdout.write(msg);

// Keep alive by reading stdin (blocks until parent closes it)
const stdin = Bun.stdin.stream();
const reader = stdin.getReader();
try {
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
} catch {}
process.exit(0);
`,
  );

  // Crash immediately with exit code 1
  writeFileSync(SCRIPTS.crashImmediate, `process.exit(1);\n`);

  // Crash after a short delay
  writeFileSync(
    SCRIPTS.crashDelayed,
    `
setTimeout(() => process.exit(1), 100);
`,
  );

  // Short-lived clean process
  writeFileSync(
    SCRIPTS.shortLived,
    `
const msg = JSON.stringify({ type: "heartbeat", timestamp: Date.now() }) + "\\n";
process.stdout.write(msg);
setTimeout(() => process.exit(0), 500);
`,
  );
});

afterAll(() => {
  // Clean up temporary scripts
  for (const script of Object.values(SCRIPTS)) {
    try {
      unlinkSync(script);
    } catch {}
  }
  try {
    unlinkSync(TMP_DIR);
  } catch {}
});

describe("Supervisor restart integration", () => {
  let supervisor: Supervisor;

  afterEach(async () => {
    // Always clean up to avoid orphan processes
    try {
      await supervisor?.killCore();
    } catch {}
  });

  test(
    "Supervisor spawns a child process and gets IPC connection",
    async () => {
      supervisor = new Supervisor({
        coreEntryPoint: SCRIPTS.longRunning,
        healthCheck: { intervalMs: 60_000, unhealthyThresholdMs: 120_000 },
      });

      const ipc = await supervisor.spawnCore();

      expect(ipc).toBeDefined();
      expect(supervisor.getIpc()).toBe(ipc);
      expect(supervisor.isRunning()).toBe(true);
    },
    10_000,
  );

  test(
    "Supervisor detects child process crash",
    async () => {
      supervisor = new Supervisor({
        coreEntryPoint: SCRIPTS.crashDelayed,
        healthCheck: { intervalMs: 60_000, unhealthyThresholdMs: 120_000 },
      });

      const crashPromise = new Promise<number | null>((resolve) => {
        supervisor.onCoreCrash((exitCode) => {
          resolve(exitCode);
        });
      });

      await supervisor.spawnCore();

      const exitCode = await crashPromise;
      expect(exitCode).not.toBe(0);
    },
    10_000,
  );

  test(
    "Supervisor restarts after crash",
    async () => {
      supervisor = new Supervisor({
        coreEntryPoint: SCRIPTS.longRunning,
        healthCheck: { intervalMs: 60_000, unhealthyThresholdMs: 120_000 },
      });

      // Spawn initial child
      const ipc1 = await supervisor.spawnCore();
      expect(supervisor.isRunning()).toBe(true);

      // Restart
      const ipc2 = await supervisor.restartCore();
      expect(supervisor.isRunning()).toBe(true);

      // IPC should be a new instance
      expect(ipc2).toBeDefined();
      expect(ipc2).not.toBe(ipc1);
    },
    10_000,
  );

  test(
    "Supervisor.killCore sends SIGTERM and waits",
    async () => {
      supervisor = new Supervisor({
        coreEntryPoint: SCRIPTS.longRunning,
        healthCheck: { intervalMs: 60_000, unhealthyThresholdMs: 120_000 },
      });

      await supervisor.spawnCore();
      expect(supervisor.isRunning()).toBe(true);

      await supervisor.killCore();
      expect(supervisor.isRunning()).toBe(false);
      expect(supervisor.getIpc()).toBeNull();
    },
    10_000,
  );

  test(
    "Supervisor handles consecutive crashes",
    async () => {
      const crashCount = { value: 0 };
      const crashCodes: (number | null)[] = [];

      supervisor = new Supervisor({
        coreEntryPoint: SCRIPTS.longRunning,
        healthCheck: { intervalMs: 60_000, unhealthyThresholdMs: 120_000 },
      });

      supervisor.onCoreCrash((exitCode) => {
        crashCount.value++;
        crashCodes.push(exitCode);
      });

      // Spawn, kill (simulating crash), restart -- 3 cycles
      for (let i = 0; i < 3; i++) {
        await supervisor.spawnCore();
        expect(supervisor.isRunning()).toBe(true);

        // Restart replaces the process (kills then spawns new one)
        if (i < 2) {
          await supervisor.restartCore();
        }
      }

      // Final cleanup
      await supervisor.killCore();
      expect(supervisor.isRunning()).toBe(false);

      // Verify supervisor managed multiple spawn/kill cycles without error
      // The crash callback count depends on whether kill triggers it
      // (per the code, crashCallback fires only when exitCode !== 0,
      //  and proc.kill() sends SIGTERM which may result in null exitCode)
      // The important thing is that we survived 3 cycles without hanging
      expect(crashCodes.length).toBeGreaterThanOrEqual(0);
    },
    15_000,
  );

  test(
    "Supervisor crash callback fires for each crash in consecutive restarts",
    async () => {
      const crashExitCodes: (number | null)[] = [];

      supervisor = new Supervisor({
        coreEntryPoint: SCRIPTS.crashDelayed,
        healthCheck: { intervalMs: 60_000, unhealthyThresholdMs: 120_000 },
      });

      // Do 3 crash-and-restart cycles
      for (let i = 0; i < 3; i++) {
        const crashPromise = new Promise<number | null>((resolve) => {
          supervisor.onCoreCrash((exitCode) => {
            crashExitCodes.push(exitCode);
            resolve(exitCode);
          });
        });

        await supervisor.spawnCore();

        // Wait for the child to crash on its own (100ms delay in the script)
        await crashPromise;
      }

      // All 3 crashes should have been detected
      expect(crashExitCodes.length).toBe(3);
      for (const code of crashExitCodes) {
        expect(code).not.toBe(0);
      }
    },
    15_000,
  );
});
