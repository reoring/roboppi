import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EvaluateGate, parseDecision, getWorkerCommand } from "../../../src/daemon/evaluate-gate.js";
import type { DaemonEvent } from "../../../src/daemon/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(sourceId: string): DaemonEvent {
  return {
    sourceId,
    timestamp: Date.now(),
    payload: { type: "interval", firedAt: Date.now() },
  };
}

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

// ---------------------------------------------------------------------------
// parseDecision
// ---------------------------------------------------------------------------

describe("parseDecision", () => {
  test('"run" returns true', () => {
    expect(parseDecision("run")).toBe(true);
  });

  test('"skip" returns false', () => {
    expect(parseDecision("skip")).toBe(false);
  });

  test('"SKIP" (uppercase) returns false', () => {
    expect(parseDecision("SKIP")).toBe(false);
  });

  test('"RUN" (uppercase) returns true', () => {
    expect(parseDecision("RUN")).toBe(true);
  });

  test("multi-line output with run on last line returns true", () => {
    expect(parseDecision("analyzing changes...\nfound 3 files\nrun")).toBe(true);
  });

  test("multi-line output with skip on last line returns false", () => {
    expect(parseDecision("analyzing...\nskip")).toBe(false);
  });

  test("empty string returns false", () => {
    expect(parseDecision("")).toBe(false);
  });

  test("only whitespace returns false", () => {
    expect(parseDecision("   \n  \n  ")).toBe(false);
  });

  test("unknown output returns false (safe side)", () => {
    expect(parseDecision("something else")).toBe(false);
  });

  test("last line with trailing newlines is handled", () => {
    expect(parseDecision("run\n\n\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getWorkerCommand
// ---------------------------------------------------------------------------

describe("getWorkerCommand", () => {
  test("CLAUDE_CODE command", () => {
    const cmd = getWorkerCommand("CLAUDE_CODE", "check this");
    expect(cmd).toEqual(["claude", "-p", "check this", "--output-format", "text"]);
  });

  test("CODEX_CLI command", () => {
    const cmd = getWorkerCommand("CODEX_CLI", "check this");
    expect(cmd).toEqual(["codex", "--quiet", "check this"]);
  });

  test("OPENCODE command", () => {
    const cmd = getWorkerCommand("OPENCODE", "check this");
    expect(cmd).toEqual(["opencode", "run", "check this"]);
  });
});

// ---------------------------------------------------------------------------
// EvaluateGate — CUSTOM worker
// ---------------------------------------------------------------------------

describe("EvaluateGate — CUSTOM worker", () => {
  const gate = new EvaluateGate();

  test("exit 0 returns true", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "eval-gate-"));
    const result = await gate.shouldRun(
      {
        worker: "CUSTOM",
        instructions: "exit 0",
        capabilities: ["RUN_COMMANDS"],
      },
      makeEvent("test"),
      null,
      tmpDir,
    );
    expect(result).toBe(true);
  });

  test("exit 1 returns false", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "eval-gate-"));
    const result = await gate.shouldRun(
      {
        worker: "CUSTOM",
        instructions: "exit 1",
        capabilities: ["RUN_COMMANDS"],
      },
      makeEvent("test"),
      null,
      tmpDir,
    );
    expect(result).toBe(false);
  });

  test("template variables are expanded ({{timestamp}})", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "eval-gate-"));
    const result = await gate.shouldRun(
      {
        worker: "CUSTOM",
        instructions: 'test -n "{{timestamp}}"',
        capabilities: ["RUN_COMMANDS"],
      },
      makeEvent("test"),
      null,
      tmpDir,
    );
    expect(result).toBe(true);
  });

  test("template variables: {{workspace}}, {{trigger_id}}, {{execution_count}}", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "eval-gate-"));
    const result = await gate.shouldRun(
      {
        worker: "CUSTOM",
        instructions:
          'test -n "{{workspace}}" && test "{{trigger_id}}" = "my-trigger" && test "{{execution_count}}" = "5"',
        capabilities: ["RUN_COMMANDS"],
      },
      makeEvent("test"),
      null,
      tmpDir,
      "my-trigger",
      5,
    );
    expect(result).toBe(true);
  });

  test("timeout returns false", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "eval-gate-"));
    const result = await gate.shouldRun(
      {
        worker: "CUSTOM",
        instructions: "sleep 10",
        capabilities: ["RUN_COMMANDS"],
        timeout: "1s",
      },
      makeEvent("test"),
      null,
      tmpDir,
    );
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EvaluateGate — non-CUSTOM worker (LLM workers)
// ---------------------------------------------------------------------------

describe("EvaluateGate — non-CUSTOM worker", () => {
  test("if CLI not found, returns false with warning (safe fallback)", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "eval-gate-"));

    // Create a minimal PATH directory that has only "bun" (for the subprocess to work),
    // but no "claude", "codex", or "opencode"
    const binDir = path.join(tmpDir, "bin");
    await mkdir(binDir, { recursive: true });

    // Find the real bun binary path
    const bunPath = process.execPath; // bun binary used to run this test

    // Symlink bun into our temporary bin directory
    await symlink(bunPath, path.join(binDir, "bun"));
    // Also need bash for the subprocess
    await symlink("/usr/bin/bash", path.join(binDir, "bash"));

    // Run the gate in a subprocess with the restricted PATH
    const proc = Bun.spawn(
      [
        path.join(binDir, "bun"),
        "-e",
        `
        import { EvaluateGate } from "./src/daemon/evaluate-gate.ts";
        const gate = new EvaluateGate();
        const result = await gate.shouldRun(
          { worker: "CLAUDE_CODE", instructions: "should we run?", capabilities: ["READ"] },
          { sourceId: "test", timestamp: Date.now(), payload: { type: "interval", firedAt: Date.now() } },
          null,
          "${tmpDir}",
        );
        process.stdout.write(String(result));
        `,
      ],
      {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { HOME: process.env["HOME"] ?? "", PATH: binDir },
      },
    );

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    // CLI not found should deny execution (return false) as safe fallback
    expect(stdout.trim().endsWith("false")).toBe(true);
  });

  test("CODEX_CLI: if CLI not found, returns false with warning (safe fallback)", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "eval-gate-"));

    const binDir = path.join(tmpDir, "bin");
    await mkdir(binDir, { recursive: true });
    const bunPath = process.execPath;
    await symlink(bunPath, path.join(binDir, "bun"));
    await symlink("/usr/bin/bash", path.join(binDir, "bash"));

    const proc = Bun.spawn(
      [
        path.join(binDir, "bun"),
        "-e",
        `
        import { EvaluateGate } from "./src/daemon/evaluate-gate.ts";
        const gate = new EvaluateGate();
        const result = await gate.shouldRun(
          { worker: "CODEX_CLI", instructions: "check", capabilities: ["READ"] },
          { sourceId: "test", timestamp: Date.now(), payload: { type: "interval", firedAt: Date.now() } },
          null,
          "${tmpDir}",
        );
        process.stdout.write(String(result));
        `,
      ],
      {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { HOME: process.env["HOME"] ?? "", PATH: binDir },
      },
    );

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    // CLI not found should deny execution (return false) as safe fallback
    expect(stdout.trim().endsWith("false")).toBe(true);
  });
});
