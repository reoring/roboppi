import { describe, it, expect, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { HookContextBuilder } from "../../../src/workflow/management/hook-context-builder.js";
import { StepStatus, type StepState } from "../../../src/workflow/types.js";

let tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "roboppi-mgmt-ctx-"));
  tmpDirs.push(dir);
  return dir;
}

describe("HookContextBuilder", () => {
  it("writes input.json with stable artifact pointers (paths)", async () => {
    const contextDir = await makeTmpDir();
    const builder = new HookContextBuilder(contextDir);

    const steps: Record<string, StepState> = {
      A: { status: StepStatus.READY, iteration: 0, maxIterations: 3 },
      B: { status: StepStatus.PENDING, iteration: 0, maxIterations: 1 },
    };

    const { inputFile, invDir, context } = await builder.buildAndWrite(
      "hook-1",
      "pre_step",
      "A",
      steps,
      { contextHint: "hint" },
    );

    expect(path.isAbsolute(inputFile)).toBe(true);
    expect(path.isAbsolute(invDir)).toBe(true);
    expect(context.paths).toBeDefined();

    const p = context.paths!;
    expect(p.context_dir).toBe(contextDir);
    expect(p.management_inv_dir).toBe(invDir);
    expect(p.workflow_state_file).toBe(path.join(contextDir, "_workflow", "state.json"));
    expect(p.management_decisions_log).toBe(path.join(contextDir, "_management", "decisions.jsonl"));
    expect(p.step_dir).toBe(path.join(contextDir, "A"));
    expect(p.step_meta_file).toBe(path.join(contextDir, "A", "_meta.json"));
    expect(p.step_resolved_file).toBe(path.join(contextDir, "A", "_resolved.json"));
    expect(p.convergence_dir).toBe(path.join(contextDir, "A", "_convergence"));
    expect(p.stall_dir).toBe(path.join(contextDir, "A", "_stall"));

    const onDisk = JSON.parse(await readFile(inputFile, "utf-8")) as any;
    expect(onDisk.paths.context_dir).toBe(contextDir);
    expect(onDisk.context_hint).toBe("hint");
    expect(onDisk.workflow_state.steps.A.status).toBe(StepStatus.READY);
  });
});
