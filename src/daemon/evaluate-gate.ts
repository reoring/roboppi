import type { EvaluateDef, DaemonEvent, WorkerKindString } from "./types.js";
import type { WorkflowState } from "../workflow/types.js";
import { expandTemplate } from "./template.js";
import { parseDuration } from "../workflow/duration.js";

/**
 * EvaluateGate runs the evaluation step to decide whether a trigger should
 * actually execute its workflow.
 *
 * For CUSTOM workers: runs instructions as a shell command.
 *   - exit 0 = run the workflow
 *   - non-zero = skip the workflow
 *
 * For LLM workers (CLAUDE_CODE, CODEX_CLI, OPENCODE): spawns the CLI process
 * with the instructions and parses the output for a "run" or "skip" decision.
 * If the CLI is not found, falls back to allowing execution (returns true).
 */
export class EvaluateGate {
  async shouldRun(
    evaluate: EvaluateDef,
    event: DaemonEvent,
    lastResult: WorkflowState | null,
    workspaceDir: string,
    triggerId?: string,
    executionCount?: number,
  ): Promise<boolean> {
    const vars: Record<string, string> = {
      event: JSON.stringify(event.payload),
      last_result: JSON.stringify(lastResult),
      timestamp: new Date().toISOString(),
      workspace: workspaceDir,
      trigger_id: triggerId ?? "",
      execution_count: String(executionCount ?? 0),
    };

    const instructions = expandTemplate(evaluate.instructions, vars);
    const timeoutMs = evaluate.timeout
      ? parseDuration(evaluate.timeout)
      : 30000;

    if (evaluate.worker === "CUSTOM") {
      return this.runCustom(instructions, vars, workspaceDir, timeoutMs);
    }

    return this.runLlmWorker(evaluate.worker, instructions, workspaceDir, timeoutMs);
  }

  private async runCustom(
    instructions: string,
    vars: Record<string, string>,
    workspaceDir: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);

    // Pass template variables as environment variables to prevent shell injection.
    // The shell command can reference them as $AGENTCORE_EVENT, $AGENTCORE_TRIGGER_ID, etc.
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    for (const [key, value] of Object.entries(vars)) {
      env[`AGENTCORE_${key.toUpperCase()}`] = value;
    }

    try {
      const proc = Bun.spawn(["bash", "-c", instructions], {
        cwd: workspaceDir,
        stdout: "pipe",
        stderr: "pipe",
        env,
        signal: abortController.signal,
      });

      const exitCode = await proc.exited;
      return exitCode === 0;
    } catch {
      // Timeout or spawn failure => skip
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async runLlmWorker(
    worker: WorkerKindString,
    instructions: string,
    workspaceDir: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const cmd = getWorkerCommand(worker, instructions);
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const proc = Bun.spawn(cmd, {
        cwd: workspaceDir,
        stdout: "pipe",
        stderr: "pipe",
        signal: abortController.signal,
      });

      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return parseDecision(stdout);
    } catch (err: unknown) {
      // Check if it's ENOENT (CLI not found)
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
        console.warn(
          `[evaluate] CLI not found for worker ${worker}, denying execution as safe fallback`,
        );
        return false;
      }
      // Timeout or other spawn failure => skip
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build the CLI command array for a given worker kind.
 */
export function getWorkerCommand(worker: WorkerKindString, instructions: string): string[] {
  switch (worker) {
    case "CLAUDE_CODE":
      return ["claude", "-p", instructions, "--output-format", "text"];
    case "CODEX_CLI":
      return ["codex", "--quiet", instructions];
    case "OPENCODE":
      return ["opencode", "run", instructions];
    default:
      return ["bash", "-c", instructions];
  }
}

/**
 * Parse a worker's stdout to determine whether to run or skip.
 * Looks at the last non-empty line of output.
 *   - Contains "run" (case-insensitive) → true
 *   - Contains "skip" (case-insensitive) → false
 *   - Default → false (safe side)
 */
export function parseDecision(output: string): boolean {
  const lines = output.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return false;

  const lastLine = lines[lines.length - 1]!;
  if (/\brun\b/i.test(lastLine)) return true;
  if (/\bskip\b/i.test(lastLine)) return false;
  return false;
}
