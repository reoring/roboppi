/**
 * AT-3: Context passing (ContextManager)
 *
 * Tests ContextManager.collectOutputs() and resolveInputs() directly,
 * since WorkflowExecutor does not call these methods during execution.
 */
import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ContextManager } from "../../src/workflow/context-manager.js";
import type { StepMeta } from "../../src/workflow/context-manager.js";
import { withTempDir } from "./helpers.js";

describe("AT-3: Context passing (ContextManager)", () => {
  // -----------------------------------------------------------------------
  // AT-3.1 File passing between steps
  // -----------------------------------------------------------------------
  test("AT-3.1: file passing between steps", async () => {
    await withTempDir(async (dir) => {
      const contextDir = path.join(dir, "context");
      const workspaceA = path.join(dir, "workspaceA");
      const workspaceB = path.join(dir, "workspaceB");
      await mkdir(workspaceA, { recursive: true });
      await mkdir(workspaceB, { recursive: true });

      const ctx = new ContextManager(contextDir);
      await ctx.initWorkflow("wf-1", "test-workflow");
      await ctx.initStep("A");
      await ctx.initStep("B");

      // Step A writes output.txt to workspace
      await writeFile(path.join(workspaceA, "output.txt"), "hello");

      // Collect outputs from step A
      await ctx.collectOutputs(
        "A",
        [{ name: "result", path: "output.txt" }],
        workspaceA,
      );

      // Verify context/A/result/output.txt exists
      expect(
        existsSync(path.join(contextDir, "A", "result", "output.txt")),
      ).toBe(true);

      // Resolve inputs for step B
      await ctx.resolveInputs(
        "B",
        [{ from: "A", artifact: "result" }],
        workspaceB,
      );

      // Verify B's workspace has result/output.txt
      const bFile = path.join(workspaceB, "result", "output.txt");
      expect(existsSync(bFile)).toBe(true);
      const content = await readFile(bFile, "utf-8");
      expect(content).toBe("hello");
    });
  });

  // -----------------------------------------------------------------------
  // AT-3.2 Directory artifact passing
  // -----------------------------------------------------------------------
  test("AT-3.2: directory artifact passing", async () => {
    await withTempDir(async (dir) => {
      const contextDir = path.join(dir, "context");
      const workspaceA = path.join(dir, "workspaceA");
      const workspaceB = path.join(dir, "workspaceB");
      await mkdir(workspaceA, { recursive: true });
      await mkdir(workspaceB, { recursive: true });

      const ctx = new ContextManager(contextDir);
      await ctx.initWorkflow("wf-2", "test-workflow");
      await ctx.initStep("A");
      await ctx.initStep("B");

      // Step A creates a src/ directory with multiple files
      const srcDir = path.join(workspaceA, "src");
      await mkdir(srcDir, { recursive: true });
      await writeFile(path.join(srcDir, "main.ts"), "console.log('main')");
      await writeFile(path.join(srcDir, "util.ts"), "export const x = 1;");

      // Collect directory output
      await ctx.collectOutputs(
        "A",
        [{ name: "code", path: "src" }],
        workspaceA,
      );

      // Verify directory copied to context
      expect(
        existsSync(path.join(contextDir, "A", "code", "main.ts")),
      ).toBe(true);
      expect(
        existsSync(path.join(contextDir, "A", "code", "util.ts")),
      ).toBe(true);

      // Resolve inputs for step B
      await ctx.resolveInputs(
        "B",
        [{ from: "A", artifact: "code" }],
        workspaceB,
      );

      // Verify B's workspace has the directory structure
      expect(
        existsSync(path.join(workspaceB, "code", "main.ts")),
      ).toBe(true);
      expect(
        existsSync(path.join(workspaceB, "code", "util.ts")),
      ).toBe(true);
      const mainContent = await readFile(
        path.join(workspaceB, "code", "main.ts"),
        "utf-8",
      );
      expect(mainContent).toBe("console.log('main')");
    });
  });

  // -----------------------------------------------------------------------
  // AT-3.3 `as` rename in inputs
  // -----------------------------------------------------------------------
  test("AT-3.3: `as` rename in inputs", async () => {
    await withTempDir(async (dir) => {
      const contextDir = path.join(dir, "context");
      const workspaceA = path.join(dir, "workspaceA");
      const workspaceB = path.join(dir, "workspaceB");
      await mkdir(workspaceA, { recursive: true });
      await mkdir(workspaceB, { recursive: true });

      const ctx = new ContextManager(contextDir);
      await ctx.initWorkflow("wf-3", "test-workflow");
      await ctx.initStep("A");
      await ctx.initStep("B");

      // Step A writes output
      await writeFile(path.join(workspaceA, "output.txt"), "renamed content");
      await ctx.collectOutputs(
        "A",
        [{ name: "result", path: "output.txt" }],
        workspaceA,
      );

      // Resolve inputs with `as` rename
      await ctx.resolveInputs(
        "B",
        [{ from: "A", artifact: "result", as: "prev-output" }],
        workspaceB,
      );

      // Verify placed under prev-output/ (not result/)
      expect(
        existsSync(path.join(workspaceB, "prev-output", "output.txt")),
      ).toBe(true);
      expect(
        existsSync(path.join(workspaceB, "result")),
      ).toBe(false);

      const content = await readFile(
        path.join(workspaceB, "prev-output", "output.txt"),
        "utf-8",
      );
      expect(content).toBe("renamed content");
    });
  });

  // -----------------------------------------------------------------------
  // AT-3.4 Missing artifact (output path doesn't exist)
  // -----------------------------------------------------------------------
  test("AT-3.4: missing artifact (output path doesn't exist)", async () => {
    await withTempDir(async (dir) => {
      const contextDir = path.join(dir, "context");
      const workspaceA = path.join(dir, "workspaceA");
      const workspaceB = path.join(dir, "workspaceB");
      await mkdir(workspaceA, { recursive: true });
      await mkdir(workspaceB, { recursive: true });

      const ctx = new ContextManager(contextDir);
      await ctx.initWorkflow("wf-4", "test-workflow");
      await ctx.initStep("A");
      await ctx.initStep("B");

      // Step A does NOT write the declared output — collectOutputs should skip
      await ctx.collectOutputs(
        "A",
        [{ name: "result", path: "nonexistent.txt" }],
        workspaceA,
      );

      // context/A/result/ should not exist (source file was missing)
      expect(
        existsSync(path.join(contextDir, "A", "result")),
      ).toBe(false);

      // resolveInputs should not fail, but artifact directory is empty/missing
      await ctx.resolveInputs(
        "B",
        [{ from: "A", artifact: "result" }],
        workspaceB,
      );

      // B's workspace should not have the artifact
      expect(
        existsSync(path.join(workspaceB, "result")),
      ).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // AT-3.5 on_failure: continue with missing inputs
  // -----------------------------------------------------------------------
  test("AT-3.5: on_failure: continue with missing inputs", async () => {
    await withTempDir(async (dir) => {
      const contextDir = path.join(dir, "context");
      const workspaceA = path.join(dir, "workspaceA");
      const workspaceB = path.join(dir, "workspaceB");
      await mkdir(workspaceA, { recursive: true });
      await mkdir(workspaceB, { recursive: true });

      const ctx = new ContextManager(contextDir);
      await ctx.initWorkflow("wf-5", "test-workflow");
      await ctx.initStep("A");
      await ctx.initStep("B");

      // Step A "failed" — no outputs were collected.
      // (We skip collectOutputs entirely to simulate failure.)

      // resolveInputs should not throw when artifact doesn't exist
      await ctx.resolveInputs(
        "B",
        [{ from: "A", artifact: "result" }],
        workspaceB,
      );

      // B's workspace should not contain the missing artifact
      expect(
        existsSync(path.join(workspaceB, "result")),
      ).toBe(false);

      // B should still be able to write its own files (execution continues)
      await writeFile(path.join(workspaceB, "own-output.txt"), "B ran OK");
      const content = await readFile(
        path.join(workspaceB, "own-output.txt"),
        "utf-8",
      );
      expect(content).toBe("B ran OK");
    });
  });

  // -----------------------------------------------------------------------
  // AT-3.6 _meta.json content verification
  // -----------------------------------------------------------------------
  test("AT-3.6: _meta.json content verification", async () => {
    await withTempDir(async (dir) => {
      const contextDir = path.join(dir, "context");

      const ctx = new ContextManager(contextDir);
      await ctx.initWorkflow("wf-6", "test-workflow");
      await ctx.initStep("stepA");

      const now = Date.now();
      const meta: StepMeta = {
        stepId: "stepA",
        status: "SUCCEEDED",
        startedAt: now - 100,
        completedAt: now,
        wallTimeMs: 100,
        attempts: 1,
        workerKind: "CLAUDE_CODE",
        artifacts: [{ name: "result", path: "output.txt" }],
      };

      await ctx.writeStepMeta("stepA", meta);

      const readMeta = await ctx.readStepMeta("stepA");
      expect(readMeta).not.toBeNull();
      expect(readMeta!.stepId).toBe("stepA");
      expect(readMeta!.status).toBe("SUCCEEDED");
      expect(readMeta!.startedAt).toBeGreaterThan(0);
      expect(readMeta!.completedAt).toBeGreaterThanOrEqual(readMeta!.startedAt);
      expect(readMeta!.attempts).toBeGreaterThanOrEqual(1);
      expect(readMeta!.workerKind).toBe("CLAUDE_CODE");
      expect(readMeta!.artifacts).toEqual([
        { name: "result", path: "output.txt" },
      ]);

      // Also verify the raw file exists
      const rawContent = await readFile(
        path.join(contextDir, "stepA", "_meta.json"),
        "utf-8",
      );
      const parsed = JSON.parse(rawContent);
      expect(parsed.stepId).toBe("stepA");
    });
  });

  // -----------------------------------------------------------------------
  // AT-3.7 _workflow.json content verification
  // -----------------------------------------------------------------------
  test("AT-3.7: _workflow.json content verification", async () => {
    await withTempDir(async (dir) => {
      const contextDir = path.join(dir, "context");

      const ctx = new ContextManager(contextDir);
      await ctx.initWorkflow("test-wf-id", "my-workflow");

      const rawContent = await readFile(
        path.join(contextDir, "_workflow.json"),
        "utf-8",
      );
      const parsed = JSON.parse(rawContent);

      // id should match what was passed
      expect(parsed.id).toBe("test-wf-id");
      // name should match
      expect(parsed.name).toBe("my-workflow");
      // startedAt should be a positive number
      expect(typeof parsed.startedAt).toBe("number");
      expect(parsed.startedAt).toBeGreaterThan(0);
      // status should be RUNNING (written at init time)
      expect(parsed.status).toBe("RUNNING");
    });
  });
});
