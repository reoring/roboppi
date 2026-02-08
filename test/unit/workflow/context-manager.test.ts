import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContextManager } from "../../../src/workflow/context-manager.js";
import type { StepMeta } from "../../../src/workflow/context-manager.js";
import type { InputRef, OutputDef } from "../../../src/workflow/types.js";

let tempDir: string;
let contextDir: string;
let mgr: ContextManager;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "ctx-test-"));
  contextDir = path.join(tempDir, "context");
  mgr = new ContextManager(contextDir);
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("ContextManager", () => {
  describe("initWorkflow", () => {
    test("creates context directory and _workflow.json", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");

      const s = await stat(contextDir);
      expect(s.isDirectory()).toBe(true);

      const content = JSON.parse(
        await readFile(path.join(contextDir, "_workflow.json"), "utf-8"),
      );
      expect(content.id).toBe("wf-001");
      expect(content.name).toBe("test-workflow");
      expect(content.status).toBe("RUNNING");
      expect(typeof content.startedAt).toBe("number");
    });
  });

  describe("initStep", () => {
    test("creates step directory", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");
      await mgr.initStep("implement");

      const s = await stat(path.join(contextDir, "implement"));
      expect(s.isDirectory()).toBe(true);
    });
  });

  describe("resolveInputs", () => {
    test("copies artifact files from prior step to workspace", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");
      await mgr.initStep("implement");

      // Simulate a prior step's collected output
      const artifactDir = path.join(contextDir, "implement", "code");
      await mkdir(artifactDir, { recursive: true });
      await writeFile(path.join(artifactDir, "feature.ts"), "export const x = 1;");

      // Create workspace for the next step
      const workspace = path.join(tempDir, "workspace");
      await mkdir(workspace, { recursive: true });

      const inputs: InputRef[] = [
        { from: "implement", artifact: "code" },
      ];

      await mgr.resolveInputs("review", inputs, workspace);

      const copied = await readFile(path.join(workspace, "code", "feature.ts"), "utf-8");
      expect(copied).toBe("export const x = 1;");
    });

    test("uses 'as' field for local name when provided", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");
      await mgr.initStep("implement");

      const artifactDir = path.join(contextDir, "implement", "code");
      await mkdir(artifactDir, { recursive: true });
      await writeFile(path.join(artifactDir, "file.ts"), "content");

      const workspace = path.join(tempDir, "workspace");
      await mkdir(workspace, { recursive: true });

      const inputs: InputRef[] = [
        { from: "implement", artifact: "code", as: "source" },
      ];

      await mgr.resolveInputs("review", inputs, workspace);

      const copied = await readFile(path.join(workspace, "source", "file.ts"), "utf-8");
      expect(copied).toBe("content");
    });

    test("skips missing artifacts without error", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");

      const workspace = path.join(tempDir, "workspace");
      await mkdir(workspace, { recursive: true });

      const inputs: InputRef[] = [
        { from: "nonexistent", artifact: "code" },
      ];

      // Should not throw
      await mgr.resolveInputs("review", inputs, workspace);
    });

    test("resolves multiple inputs", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");

      // Set up two prior steps with artifacts
      const codeDir = path.join(contextDir, "implement", "code");
      await mkdir(codeDir, { recursive: true });
      await writeFile(path.join(codeDir, "main.ts"), "main");

      const reviewDir = path.join(contextDir, "review", "comments");
      await mkdir(reviewDir, { recursive: true });
      await writeFile(path.join(reviewDir, "review.md"), "looks good");

      const workspace = path.join(tempDir, "workspace");
      await mkdir(workspace, { recursive: true });

      const inputs: InputRef[] = [
        { from: "implement", artifact: "code" },
        { from: "review", artifact: "comments" },
      ];

      await mgr.resolveInputs("fix", inputs, workspace);

      expect(await readFile(path.join(workspace, "code", "main.ts"), "utf-8")).toBe("main");
      expect(await readFile(path.join(workspace, "comments", "review.md"), "utf-8")).toBe("looks good");
    });
  });

  describe("collectOutputs", () => {
    test("collects a single file output into context", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");
      await mgr.initStep("implement");

      const workspace = path.join(tempDir, "workspace");
      await mkdir(workspace, { recursive: true });
      await writeFile(path.join(workspace, "result.txt"), "output content");

      const outputs: OutputDef[] = [
        { name: "report", path: "result.txt", type: "text" },
      ];

      await mgr.collectOutputs("implement", outputs, workspace);

      const collected = await readFile(
        path.join(contextDir, "implement", "report", "result.txt"),
        "utf-8",
      );
      expect(collected).toBe("output content");
    });

    test("collects a directory output into context", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");
      await mgr.initStep("implement");

      const workspace = path.join(tempDir, "workspace");
      const srcDir = path.join(workspace, "src");
      await mkdir(srcDir, { recursive: true });
      await writeFile(path.join(srcDir, "a.ts"), "a");
      await writeFile(path.join(srcDir, "b.ts"), "b");

      const outputs: OutputDef[] = [
        { name: "code", path: "src", type: "code" },
      ];

      await mgr.collectOutputs("implement", outputs, workspace);

      const a = await readFile(
        path.join(contextDir, "implement", "code", "a.ts"),
        "utf-8",
      );
      const b = await readFile(
        path.join(contextDir, "implement", "code", "b.ts"),
        "utf-8",
      );
      expect(a).toBe("a");
      expect(b).toBe("b");
    });

    test("skips missing output paths without error", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");
      await mgr.initStep("implement");

      const workspace = path.join(tempDir, "workspace");
      await mkdir(workspace, { recursive: true });

      const outputs: OutputDef[] = [
        { name: "missing", path: "does-not-exist.txt" },
      ];

      // Should not throw
      await mgr.collectOutputs("implement", outputs, workspace);
    });

    test("collects nested file path output", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");
      await mgr.initStep("implement");

      const workspace = path.join(tempDir, "workspace");
      await mkdir(path.join(workspace, "src"), { recursive: true });
      await writeFile(path.join(workspace, "src", "feature.ts"), "code here");

      const outputs: OutputDef[] = [
        { name: "implementation", path: "src/feature.ts", type: "code" },
      ];

      await mgr.collectOutputs("implement", outputs, workspace);

      const collected = await readFile(
        path.join(contextDir, "implement", "implementation", "feature.ts"),
        "utf-8",
      );
      expect(collected).toBe("code here");
    });
  });

  describe("writeStepMeta / readStepMeta", () => {
    test("roundtrips step metadata", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");
      await mgr.initStep("implement");

      const meta: StepMeta = {
        stepId: "implement",
        status: "SUCCEEDED",
        startedAt: 1700000000000,
        completedAt: 1700000900000,
        wallTimeMs: 900000,
        attempts: 1,
        workerKind: "CODEX_CLI",
        artifacts: [
          { name: "code", path: "code/feature.ts", type: "code" },
        ],
      };

      await mgr.writeStepMeta("implement", meta);
      const read = await mgr.readStepMeta("implement");

      expect(read).not.toBeNull();
      expect(read!.stepId).toBe("implement");
      expect(read!.status).toBe("SUCCEEDED");
      expect(read!.startedAt).toBe(1700000000000);
      expect(read!.completedAt).toBe(1700000900000);
      expect(read!.wallTimeMs).toBe(900000);
      expect(read!.attempts).toBe(1);
      expect(read!.workerKind).toBe("CODEX_CLI");
      expect(read!.artifacts).toHaveLength(1);
      expect(read!.artifacts[0]!.name).toBe("code");
    });

    test("readStepMeta returns null for missing step", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");

      const result = await mgr.readStepMeta("nonexistent");
      expect(result).toBeNull();
    });

    test("writeStepMeta with iteration fields", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");
      await mgr.initStep("loop-step");

      const meta: StepMeta = {
        stepId: "loop-step",
        status: "SUCCEEDED",
        startedAt: 1700000000000,
        completedAt: 1700000060000,
        wallTimeMs: 60000,
        attempts: 1,
        iterations: 5,
        maxIterations: 20,
        workerKind: "CODEX_CLI",
        artifacts: [],
      };

      await mgr.writeStepMeta("loop-step", meta);
      const read = await mgr.readStepMeta("loop-step");

      expect(read!.iterations).toBe(5);
      expect(read!.maxIterations).toBe(20);
    });

    test("writeStepMeta with workerResult", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");
      await mgr.initStep("step-a");

      const meta: StepMeta = {
        stepId: "step-a",
        status: "SUCCEEDED",
        startedAt: 1700000000000,
        attempts: 1,
        workerKind: "CLAUDE_CODE",
        artifacts: [],
        workerResult: {
          status: "SUCCEEDED",
          cost: { estimatedTokens: 5000 },
        },
      };

      await mgr.writeStepMeta("step-a", meta);
      const read = await mgr.readStepMeta("step-a");

      expect(read!.workerResult).toEqual({
        status: "SUCCEEDED",
        cost: { estimatedTokens: 5000 },
      });
    });
  });

  describe("writeWorkflowMeta", () => {
    test("writes and overwrites _workflow.json", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");

      await mgr.writeWorkflowMeta({
        id: "wf-001",
        name: "test-workflow",
        status: "SUCCEEDED",
        completedAt: 1700001000000,
      });

      const content = JSON.parse(
        await readFile(path.join(contextDir, "_workflow.json"), "utf-8"),
      );
      expect(content.status).toBe("SUCCEEDED");
      expect(content.completedAt).toBe(1700001000000);
    });
  });

  describe("cleanup", () => {
    test("removes context directory", async () => {
      await mgr.initWorkflow("wf-001", "test-workflow");
      await mgr.initStep("step-a");

      await mgr.cleanup();

      const exists = await stat(contextDir).catch(() => null);
      expect(exists).toBeNull();
    });

    test("cleanup is safe to call when directory does not exist", async () => {
      // Should not throw
      await mgr.cleanup();
    });
  });

  describe("getArtifactPath", () => {
    test("returns correct path for step artifact", () => {
      const p = mgr.getArtifactPath("implement", "code");
      expect(p).toBe(path.join(contextDir, "implement", "code"));
    });
  });

  describe("end-to-end flow", () => {
    test("full workflow: init -> step A outputs -> step B inputs -> collect", async () => {
      await mgr.initWorkflow("wf-e2e", "e2e-test");

      // Step A: implement
      await mgr.initStep("implement");
      const workspaceA = path.join(tempDir, "ws-implement");
      await mkdir(path.join(workspaceA, "src"), { recursive: true });
      await writeFile(path.join(workspaceA, "src", "feature.ts"), "export function hello() {}");
      await writeFile(path.join(workspaceA, "src", "util.ts"), "export const PI = 3.14;");

      await mgr.collectOutputs("implement", [
        { name: "implementation", path: "src", type: "code" },
      ], workspaceA);

      await mgr.writeStepMeta("implement", {
        stepId: "implement",
        status: "SUCCEEDED",
        startedAt: 1700000000000,
        completedAt: 1700000100000,
        wallTimeMs: 100000,
        attempts: 1,
        workerKind: "CODEX_CLI",
        artifacts: [{ name: "implementation", path: "implementation/src", type: "code" }],
      });

      // Step B: review — resolve inputs from implement
      await mgr.initStep("review");
      const workspaceB = path.join(tempDir, "ws-review");
      await mkdir(workspaceB, { recursive: true });

      await mgr.resolveInputs("review", [
        { from: "implement", artifact: "implementation", as: "source" },
      ], workspaceB);

      // Verify the files are available in workspace B
      const feature = await readFile(path.join(workspaceB, "source", "feature.ts"), "utf-8");
      expect(feature).toBe("export function hello() {}");
      const util = await readFile(path.join(workspaceB, "source", "util.ts"), "utf-8");
      expect(util).toBe("export const PI = 3.14;");

      // Step B produces output
      await writeFile(path.join(workspaceB, "review.md"), "LGTM with minor comments");
      await mgr.collectOutputs("review", [
        { name: "review-comments", path: "review.md", type: "review" },
      ], workspaceB);

      // Verify final state
      const reviewFile = await readFile(
        path.join(contextDir, "review", "review-comments", "review.md"),
        "utf-8",
      );
      expect(reviewFile).toBe("LGTM with minor comments");

      // Update workflow meta at end
      await mgr.writeWorkflowMeta({
        id: "wf-e2e",
        name: "e2e-test",
        status: "SUCCEEDED",
        completedAt: Date.now(),
      });

      const wfMeta = JSON.parse(
        await readFile(path.join(contextDir, "_workflow.json"), "utf-8"),
      );
      expect(wfMeta.status).toBe("SUCCEEDED");
    });
  });
});
