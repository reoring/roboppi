import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MultiWorkerStepRunner } from "../../../src/workflow/multi-worker-step-runner.js";
import type { CompletionCheckDef } from "../../../src/workflow/types.js";
import type { WorkerAdapter, WorkerEvent, WorkerHandle } from "../../../src/worker/worker-adapter.js";
import type { WorkerResult, WorkerTask } from "../../../src/types/index.js";
import {
  WorkerKind,
  WorkerStatus,
} from "../../../src/types/index.js";

class DecisionWritingAdapter implements WorkerAdapter {
  readonly kind = WorkerKind.OPENCODE;
  readonly tasks: WorkerTask[] = [];

  constructor(private readonly decisions: Array<"complete" | "incomplete">) {}

  async startTask(task: WorkerTask): Promise<WorkerHandle> {
    this.tasks.push(task);
    return {
      handleId: `handle-${this.tasks.length}`,
      workerKind: this.kind,
      abortSignal: task.abortSignal,
    };
  }

  async *streamEvents(_handle: WorkerHandle): AsyncIterable<WorkerEvent> {
    return;
  }

  async cancel(_handle: WorkerHandle): Promise<void> {}

  async awaitResult(handle: WorkerHandle): Promise<WorkerResult> {
    const task = this.tasks[Number(handle.handleId.split("-")[1]) - 1]!;
    const decisionFile = task.env?.ROBOPPI_COMPLETION_DECISION_FILE;
    const checkId = task.env?.ROBOPPI_COMPLETION_CHECK_ID;
    if (!decisionFile || !checkId) {
      throw new Error("expected completion decision env to be present");
    }

    await mkdir(path.dirname(decisionFile), { recursive: true });
    const decision = this.decisions.shift() ?? "incomplete";
    await writeFile(
      decisionFile,
      JSON.stringify({ decision, check_id: checkId }),
      "utf-8",
    );

    return {
      status: WorkerStatus.SUCCEEDED,
      artifacts: [],
      observations: [],
      cost: { wallTimeMs: 1 },
      durationMs: 1,
    };
  }
}

function makeCheck(): CompletionCheckDef {
  return {
    worker: "OPENCODE",
    model: "openai/gpt-5.4",
    instructions: "Write completion decision to $ROBOPPI_COMPLETION_DECISION_FILE",
    capabilities: ["READ"],
    decision_file: ".roboppi-loop/current/decision.json",
  } as CompletionCheckDef;
}

describe("MultiWorkerStepRunner completion decision isolation", () => {
  test("uses a unique per-check decision file instead of the shared path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roboppi-runcheck-"));
    try {
      const sharedDecision = path.join(dir, ".roboppi-loop", "current", "decision.json");
      await mkdir(path.dirname(sharedDecision), { recursive: true });
      await writeFile(
        sharedDecision,
        JSON.stringify({ decision: "complete", check_id: "stale-check" }),
        "utf-8",
      );

      const runner = new MultiWorkerStepRunner(false);
      const adapter = new DecisionWritingAdapter(["incomplete", "complete"]);
      (runner as unknown as { adapters: Record<string, WorkerAdapter> }).adapters.OPENCODE = adapter;

      const first = await runner.runCheck(
        "orchestrate",
        makeCheck(),
        dir,
        AbortSignal.timeout(5_000),
      );
      expect(first.complete).toBe(false);
      expect(first.failed).toBe(false);

      const second = await runner.runCheck(
        "orchestrate",
        makeCheck(),
        dir,
        AbortSignal.timeout(5_000),
      );
      expect(second.complete).toBe(true);
      expect(second.failed).toBe(false);

      expect(adapter.tasks).toHaveLength(2);
      const firstDecisionFile = adapter.tasks[0]!.env?.ROBOPPI_COMPLETION_DECISION_FILE;
      const secondDecisionFile = adapter.tasks[1]!.env?.ROBOPPI_COMPLETION_DECISION_FILE;
      expect(firstDecisionFile).toBeDefined();
      expect(secondDecisionFile).toBeDefined();
      expect(firstDecisionFile).not.toBe(sharedDecision);
      expect(secondDecisionFile).not.toBe(sharedDecision);
      expect(firstDecisionFile).not.toBe(secondDecisionFile);
      expect(firstDecisionFile).toContain(`${path.sep}.roboppi-loop${path.sep}current${path.sep}_completion${path.sep}orchestrate${path.sep}`);
      expect(secondDecisionFile).toContain(`${path.sep}.roboppi-loop${path.sep}current${path.sep}_completion${path.sep}orchestrate${path.sep}`);

      const sharedContent = JSON.parse(await readFile(sharedDecision, "utf-8")) as { check_id: string };
      expect(sharedContent.check_id).toBe("stale-check");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
