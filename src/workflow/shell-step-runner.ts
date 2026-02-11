/**
 * ShellStepRunner executes `instructions` as a shell script.
 * Used for the CUSTOM worker to run workflows under examples/.
 */
import { spawn } from "node:child_process";
import type { StepDefinition, CompletionCheckDef } from "./types.js";
import type { StepRunner, StepRunResult, CheckResult } from "./executor.js";
import { ErrorClass } from "../types/common.js";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB

export class ShellStepRunner implements StepRunner {
  constructor(private readonly verbose: boolean = false) {}

  async runStep(
    stepId: string,
    step: StepDefinition,
    workspaceDir: string,
    abortSignal: AbortSignal,
    env?: Record<string, string>,
  ): Promise<StepRunResult> {
    if (this.verbose) {
      process.stderr.write(`\x1b[36m[step:${stepId}]\x1b[0m Running...\n`);
    }

    const result = await this.execShell(step.instructions, workspaceDir, abortSignal, env);

    if (this.verbose && result.stdout) {
      for (const line of result.stdout.split("\n").filter(Boolean)) {
        process.stderr.write(`\x1b[36m[step:${stepId}]\x1b[0m ${line}\n`);
      }
    }

    if (result.cancelled) {
      return { status: "FAILED", errorClass: ErrorClass.NON_RETRYABLE };
    }

    if (result.exitCode !== 0) {
      if (this.verbose) {
        process.stderr.write(`\x1b[31m[step:${stepId}]\x1b[0m Exit code: ${result.exitCode}\n`);
        if (result.stderr) {
          process.stderr.write(`\x1b[31m[step:${stepId}]\x1b[0m ${result.stderr}\n`);
        }
      }
      return { status: "FAILED", errorClass: ErrorClass.RETRYABLE_TRANSIENT };
    }

    return { status: "SUCCEEDED" };
  }

  async runCheck(
    stepId: string,
    check: CompletionCheckDef,
    workspaceDir: string,
    abortSignal: AbortSignal,
    env?: Record<string, string>,
  ): Promise<CheckResult> {
    if (this.verbose) {
      process.stderr.write(`\x1b[33m[check:${stepId}]\x1b[0m Running completion check...\n`);
    }

    const result = await this.execShell(check.instructions, workspaceDir, abortSignal, env);

    if (this.verbose && result.stdout) {
      for (const line of result.stdout.split("\n").filter(Boolean)) {
        process.stderr.write(`\x1b[33m[check:${stepId}]\x1b[0m ${line}\n`);
      }
    }

    if (result.cancelled) {
      return { complete: false, failed: true, errorClass: ErrorClass.NON_RETRYABLE };
    }

    // exit 0 = complete, exit 1 = incomplete, other = failed
    if (result.exitCode === 0) {
      return { complete: true, failed: false };
    }
    if (result.exitCode === 1) {
      return { complete: false, failed: false };
    }
    return { complete: false, failed: true, errorClass: ErrorClass.NON_RETRYABLE };
  }

  private execShell(
    script: string,
    cwd: string,
    abortSignal: AbortSignal,
    env?: Record<string, string>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string; cancelled: boolean }> {
    return new Promise((resolve) => {
      const mergedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) mergedEnv[k] = v;
      }

      const proc = spawn("bash", ["-e", "-c", script], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...mergedEnv,
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME ?? "",
          SHELL: process.env.SHELL ?? "/bin/sh",
          ...(env ?? {}),
        },
      });

      let stdout = "";
      let stderr = "";
      let cancelled = false;

      let stdoutTruncated = false;
      let stderrTruncated = false;

      proc.stdout.on("data", (data: Buffer) => {
        if (!stdoutTruncated) {
          stdout += data.toString();
          if (stdout.length > MAX_OUTPUT_BYTES) {
            stdout = stdout.slice(0, MAX_OUTPUT_BYTES) + "\n[truncated]";
            stdoutTruncated = true;
          }
        }
      });
      proc.stderr.on("data", (data: Buffer) => {
        if (!stderrTruncated) {
          stderr += data.toString();
          if (stderr.length > MAX_OUTPUT_BYTES) {
            stderr = stderr.slice(0, MAX_OUTPUT_BYTES) + "\n[truncated]";
            stderrTruncated = true;
          }
        }
      });

      const onAbort = () => {
        cancelled = true;
        proc.kill("SIGTERM");
      };

      if (abortSignal.aborted) {
        onAbort();
      } else {
        abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      proc.on("close", (code) => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve({ exitCode: code ?? 1, stdout, stderr, cancelled });
      });

      proc.on("error", (err) => {
        abortSignal.removeEventListener("abort", onAbort);
        stderr += err.message;
        resolve({ exitCode: 1, stdout, stderr, cancelled });
      });
    });
  }
}
