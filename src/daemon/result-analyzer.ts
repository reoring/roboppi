import type { AnalyzeDef } from "./types.js";
import type { WorkflowState } from "../workflow/types.js";
import type { StepRunner, StepRunResult } from "../workflow/executor.js";
import type { StepDefinition } from "../workflow/types.js";
import { expandTemplate } from "./template.js";
import { parseDuration } from "../workflow/duration.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * ResultAnalyzer runs post-workflow analysis.
 *
 * For CUSTOM workers: runs instructions as a shell command, returns stdout.
 * For LLM workers (CLAUDE_CODE etc.): spawns the CLI, returns stdout.
 *   If the CLI is not found (ENOENT), logs a warning and returns "".
 */
export class ResultAnalyzer {
  async analyze(
    analyzeDef: AnalyzeDef,
    workflowResult: WorkflowState,
    contextDir: string,
    workspaceDir: string,
    triggerId?: string,
    executionCount?: number,
    stepRunner?: StepRunner,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const stepsJson = JSON.stringify(workflowResult.steps);
    const vars: Record<string, string> = {
      workflow_status: workflowResult.status,
      steps: stepsJson,
      context_dir: contextDir,
      trigger_id: triggerId ?? "",
      execution_count: String(executionCount ?? 0),
      timestamp: new Date().toISOString(),
    };

    const instructions = expandTemplate(analyzeDef.instructions, vars);
    const timeoutMs = analyzeDef.timeout
      ? parseDuration(analyzeDef.timeout)
      : 30000;

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);

    const onAbort = () => abortController.abort();
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Pass template variables as environment variables to prevent shell injection.
    const varsEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(vars)) {
      const upper = key.toUpperCase();
      varsEnv[`ROBOPPI_${upper}`] = value;
    }
    const env: Record<string, string> = { ...process.env as Record<string, string>, ...varsEnv };

    const combinedAbort = abortController.signal;

    let stdout = "";
    try {
      if (stepRunner) {
        stdout = await this.runViaStepRunner(
          stepRunner,
          analyzeDef,
          instructions,
          varsEnv,
          workspaceDir,
          combinedAbort,
          triggerId,
        );
      } else if (analyzeDef.worker === "CUSTOM") {
        const proc = Bun.spawn(["bash", "-c", instructions], {
          cwd: workspaceDir,
          stdout: "pipe",
          stderr: "pipe",
          env,
          signal: combinedAbort,
        });

        stdout = await new Response(proc.stdout).text();
        await proc.exited;
      } else {
        // LLM worker — spawn CLI
        const cmd = this.buildCliCommand(analyzeDef.worker, instructions);
        if (!cmd) {
          console.log(
            `[analyze] Unsupported worker kind: ${analyzeDef.worker}, skipping analysis`,
          );
          return "";
        }

        const proc = Bun.spawn(cmd, {
          cwd: workspaceDir,
          stdout: "pipe",
          stderr: "pipe",
          signal: combinedAbort,
        });

        stdout = await new Response(proc.stdout).text();
        await proc.exited;
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        console.warn(
          `[analyze] CLI not found for worker ${analyzeDef.worker}, skipping analysis`,
        );
      }
      return "";
    } finally {
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
    }

    // Save outputs if defined — only write if the script did not already create the file
    if (analyzeDef.outputs) {
      const resolvedWorkspace = path.resolve(workspaceDir);
      for (const output of analyzeDef.outputs) {
        const outputPath = path.resolve(workspaceDir, output.path);
        // Prevent path traversal outside workspace
        if (!outputPath.startsWith(resolvedWorkspace + path.sep) && outputPath !== resolvedWorkspace) {
          throw new Error(`Path traversal detected in analyze output: ${output.path}`);
        }
        await mkdir(path.dirname(outputPath), { recursive: true });
        const alreadyExists = await Bun.file(outputPath).exists();
        if (!alreadyExists) {
          await writeFile(outputPath, stdout);
        }
      }
    }

    return stdout.trim();
  }

  private async runViaStepRunner(
    runner: StepRunner,
    analyzeDef: AnalyzeDef,
    instructions: string,
    env: Record<string, string>,
    workspaceDir: string,
    abortSignal: AbortSignal,
    triggerId?: string,
  ): Promise<string> {
    const step: StepDefinition = {
      worker: analyzeDef.worker,
      instructions,
      capabilities: analyzeDef.capabilities,
      timeout: analyzeDef.timeout ?? "30s",
    };

    const result = await runner.runStep(
      `analyze${triggerId ? `:${triggerId}` : ""}`,
      step,
      workspaceDir,
      abortSignal,
      env,
    );

    if (result.status !== "SUCCEEDED") return "";
    return extractStepText(result);
  }

  protected buildCliCommand(
    worker: string,
    instructions: string,
  ): string[] | null {
    switch (worker) {
      case "CLAUDE_CODE":
        return ["claude", "-p", instructions, "--output-format", "text"];
      case "CODEX_CLI":
        return ["codex", "-p", instructions];
      case "OPENCODE":
        return ["opencode", "-p", instructions];
      default:
        return null;
    }
  }
}

function extractStepText(result: StepRunResult): string {
  const parts: string[] = [];
  for (const o of result.observations ?? []) {
    if (o.summary) parts.push(o.summary);
  }
  return parts.join("\n");
}
