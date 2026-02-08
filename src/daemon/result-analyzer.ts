import type { AnalyzeDef } from "./types.js";
import type { WorkflowState } from "../workflow/types.js";
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

    // Pass template variables as environment variables to prevent shell injection.
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    for (const [key, value] of Object.entries(vars)) {
      env[`AGENTCORE_${key.toUpperCase()}`] = value;
    }

    let stdout = "";
    try {
      if (analyzeDef.worker === "CUSTOM") {
        const proc = Bun.spawn(["bash", "-c", instructions], {
          cwd: workspaceDir,
          stdout: "pipe",
          stderr: "pipe",
          env,
          signal: abortController.signal,
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
          signal: abortController.signal,
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
