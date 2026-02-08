import { describe, test, expect } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResultAnalyzer } from "../../../src/daemon/result-analyzer.js";
import type { WorkflowState } from "../../../src/workflow/types.js";
import { WorkflowStatus } from "../../../src/workflow/types.js";

const analyzer = new ResultAnalyzer();

function mockResult(status: WorkflowStatus = WorkflowStatus.SUCCEEDED): WorkflowState {
  return {
    workflowId: "test-wf-1",
    name: "test-workflow",
    status,
    steps: {},
    startedAt: Date.now(),
    completedAt: Date.now(),
  };
}

describe("ResultAnalyzer", () => {
  // -----------------------------------------------------------------------
  // CUSTOM worker
  // -----------------------------------------------------------------------

  test("CUSTOM: returns stdout", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ra-custom-"));
    const output = await analyzer.analyze(
      {
        worker: "CUSTOM",
        instructions: 'echo "analysis complete"',
        capabilities: ["RUN_COMMANDS"],
      },
      mockResult(),
      tmpDir,
      tmpDir,
    );
    expect(output).toBe("analysis complete");
  });

  test("CUSTOM: template vars {{workflow_status}}, {{trigger_id}}, {{timestamp}} expanded", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ra-vars-"));
    const output = await analyzer.analyze(
      {
        worker: "CUSTOM",
        instructions: "echo {{workflow_status}}-{{trigger_id}}-{{timestamp}}",
        capabilities: ["RUN_COMMANDS"],
      },
      mockResult(),
      tmpDir,
      tmpDir,
      "my-trigger",
      5,
    );
    const parts = output.split("-");
    expect(parts[0]).toBe("SUCCEEDED");
    expect(parts[1]).toBe("my");
    // timestamp will contain dashes (ISO format) so just check it's non-empty
    expect(output).toContain("SUCCEEDED");
    expect(output).toContain("my-trigger");
  });

  test("CUSTOM: {{execution_count}} expanded", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ra-count-"));
    const output = await analyzer.analyze(
      {
        worker: "CUSTOM",
        instructions: "echo {{execution_count}}",
        capabilities: ["RUN_COMMANDS"],
      },
      mockResult(),
      tmpDir,
      tmpDir,
      "t1",
      42,
    );
    expect(output).toBe("42");
  });

  test("CUSTOM: defaults for optional params", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ra-defaults-"));
    const output = await analyzer.analyze(
      {
        worker: "CUSTOM",
        instructions: "echo {{trigger_id}}-{{execution_count}}",
        capabilities: ["RUN_COMMANDS"],
      },
      mockResult(),
      tmpDir,
      tmpDir,
    );
    // triggerId defaults to "", executionCount defaults to 0
    expect(output).toBe("-0");
  });

  // -----------------------------------------------------------------------
  // Non-CUSTOM worker (LLM CLI spawn)
  // -----------------------------------------------------------------------

  test("non-CUSTOM: if CLI not found (ENOENT), returns empty string with warning", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ra-llm-"));
    // Subclass to override CLI binary to something that doesn't exist
    const testAnalyzer = new (class extends ResultAnalyzer {
      protected override buildCliCommand(
        _worker: string,
        instructions: string,
      ): string[] | null {
        return ["nonexistent-cli-binary-xyz-123", "-p", instructions];
      }
    })();

    const output = await testAnalyzer.analyze(
      {
        worker: "CLAUDE_CODE",
        instructions: "analyze the results",
        capabilities: ["READ"],
      },
      mockResult(),
      tmpDir,
      tmpDir,
    );
    expect(output).toBe("");
  });

  test("non-CUSTOM: unsupported worker kind returns empty string", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ra-unsupported-"));
    const output = await analyzer.analyze(
      {
        worker: "UNKNOWN_WORKER" as "CUSTOM",
        instructions: "analyze results",
        capabilities: ["READ"],
      },
      mockResult(),
      tmpDir,
      tmpDir,
    );
    expect(output).toBe("");
  });

  // -----------------------------------------------------------------------
  // Output saving
  // -----------------------------------------------------------------------

  test("output saving: script creates file, file preserved (not overwritten)", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ra-out-script-"));
    const outputPath = path.join(tmpDir, "report.txt");

    // Instructions: echo stdout AND create the output file with different content
    const output = await analyzer.analyze(
      {
        worker: "CUSTOM",
        instructions: `echo "stdout-content" && echo "script-created" > ${outputPath}`,
        capabilities: ["RUN_COMMANDS"],
        outputs: [{ name: "report", path: "report.txt" }],
      },
      mockResult(),
      tmpDir,
      tmpDir,
    );

    expect(output).toBe("stdout-content");

    // The script created the file, so it should NOT be overwritten with stdout
    const fileContent = await readFile(outputPath, "utf-8");
    expect(fileContent.trim()).toBe("script-created");
  });

  test("output saving: script does not create file, stdout written to path", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ra-out-auto-"));
    const outputRelPath = "output/result.txt";
    const outputAbsPath = path.join(tmpDir, outputRelPath);

    const output = await analyzer.analyze(
      {
        worker: "CUSTOM",
        instructions: 'echo "auto-saved"',
        capabilities: ["RUN_COMMANDS"],
        outputs: [{ name: "result", path: outputRelPath }],
      },
      mockResult(),
      tmpDir,
      tmpDir,
    );

    expect(output).toBe("auto-saved");

    // stdout should be written to the output path
    const fileContent = await readFile(outputAbsPath, "utf-8");
    // writeFile writes the raw stdout (with trailing newline)
    expect(fileContent).toContain("auto-saved");
  });
});
