/**
 * Builds HookContext (input.json) for management agent hook invocations
 * and creates per-invocation isolation directories.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StepState } from "../types.js";
import type { ManagementHook, HookContext } from "./types.js";

// ---------------------------------------------------------------------------
// HookContextBuilder
// ---------------------------------------------------------------------------

export class HookContextBuilder {
  constructor(private readonly contextDir: string) {}

  /**
   * Create the per-invocation directory and write input.json.
   * Returns the absolute paths for input.json and decision.json.
   */
  async buildAndWrite(
    hookId: string,
    hook: ManagementHook,
    stepId: string,
    steps: Record<string, StepState>,
    opts?: {
      contextHint?: string;
      stallEvent?: unknown;
      checkResult?: unknown;
    },
  ): Promise<{ inputFile: string; decisionFile: string; invDir: string; context: HookContext }> {
    const invDir = path.join(this.contextDir, "_management", "inv", hookId);
    await mkdir(invDir, { recursive: true });

    const stepState = steps[stepId];

    const context: HookContext = {
      hook_id: hookId,
      hook,
      step_id: stepId,
      paths: {
        context_dir: this.contextDir,
        workflow_state_file: path.join(this.contextDir, "_workflow", "state.json"),
        management_decisions_log: path.join(this.contextDir, "_management", "decisions.jsonl"),
        management_inv_dir: invDir,
        step_dir: path.join(this.contextDir, stepId),
        step_meta_file: path.join(this.contextDir, stepId, "_meta.json"),
        step_resolved_file: path.join(this.contextDir, stepId, "_resolved.json"),
        convergence_dir: path.join(this.contextDir, stepId, "_convergence"),
        stall_dir: path.join(this.contextDir, stepId, "_stall"),
      },
      workflow_state: {
        steps: Object.fromEntries(
          Object.entries(steps).map(([id, s]) => [
            id,
            {
              status: s.status,
              iteration: s.iteration,
              maxIterations: s.maxIterations,
              startedAt: s.startedAt,
              completedAt: s.completedAt,
              error: s.error,
              convergenceStage: s.convergenceStage,
              convergenceStallCount: s.convergenceStallCount,
            },
          ]),
        ),
      },
      step_state: stepState
        ? {
            status: stepState.status,
            iteration: stepState.iteration,
            maxIterations: stepState.maxIterations,
          }
        : { status: "UNKNOWN", iteration: 0, maxIterations: 1 },
    };

    if (opts?.contextHint) {
      context.context_hint = opts.contextHint;
    }
    if (opts?.stallEvent !== undefined) {
      context.stall_event = opts.stallEvent;
    }
    if (opts?.checkResult !== undefined) {
      context.check_result = opts.checkResult;
    }

    const inputFile = path.join(invDir, "input.json");
    const decisionFile = path.join(invDir, "decision.json");

    await writeFile(inputFile, JSON.stringify(context, null, 2));

    return { inputFile, decisionFile, invDir, context };
  }
}
