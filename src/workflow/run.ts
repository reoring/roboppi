#!/usr/bin/env bun
/**
 * Workflow Runner CLI
 *
 * Usage:
 *   bun run src/workflow/run.ts <workflow.yaml> [--workspace <dir>] [--verbose]
 */
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseWorkflow } from "./parser.js";
import { validateDag } from "./dag-validator.js";
import { ContextManager } from "./context-manager.js";
import { WorkflowExecutor } from "./executor.js";
import { ShellStepRunner } from "./shell-step-runner.js";
import { WorkflowStatus, StepStatus } from "./types.js";

// ── Argument parsing ────────────────────────────────────────────

const args = process.argv.slice(2);
let yamlPath = "";
let workspaceDir = "";
let verbose = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--workspace" || arg === "-w") {
    i++;
    workspaceDir = args[i] ?? "";
  } else if (arg === "--verbose" || arg === "-v") {
    verbose = true;
  } else if (arg === "--help" || arg === "-h") {
    console.log(`Usage: bun run src/workflow/run.ts <workflow.yaml> [options]

Options:
  --workspace, -w <dir>   Working directory for steps (default: temp dir)
  --verbose, -v           Show step output
  --help, -h              Show help`);
    process.exit(0);
  } else if (!arg.startsWith("-")) {
    yamlPath = arg;
  }
}

if (!yamlPath) {
  console.error("Error: workflow YAML path is required");
  console.error("Usage: bun run src/workflow/run.ts <workflow.yaml>");
  process.exit(1);
}

// ── Main ────────────────────────────────────────────────────────

const STATUS_ICON: Record<string, string> = {
  [StepStatus.SUCCEEDED]: "\x1b[32mPASS\x1b[0m",
  [StepStatus.FAILED]: "\x1b[31mFAIL\x1b[0m",
  [StepStatus.SKIPPED]: "\x1b[90mSKIP\x1b[0m",
  [StepStatus.INCOMPLETE]: "\x1b[33mINCOMPLETE\x1b[0m",
  [StepStatus.CANCELLED]: "\x1b[31mCANCELLED\x1b[0m",
};

const WF_ICON: Record<string, string> = {
  [WorkflowStatus.SUCCEEDED]: "\x1b[32mSUCCEEDED\x1b[0m",
  [WorkflowStatus.FAILED]: "\x1b[31mFAILED\x1b[0m",
  [WorkflowStatus.TIMED_OUT]: "\x1b[31mTIMED_OUT\x1b[0m",
  [WorkflowStatus.CANCELLED]: "\x1b[31mCANCELLED\x1b[0m",
};

async function main(): Promise<void> {
  // 1. Read and parse YAML
  const resolvedPath = path.resolve(yamlPath);
  console.log(`\x1b[1mWorkflow:\x1b[0m ${resolvedPath}`);

  const yamlContent = await readFile(resolvedPath, "utf-8");
  const definition = parseWorkflow(yamlContent);

  console.log(`\x1b[1mName:\x1b[0m     ${definition.name}`);
  console.log(`\x1b[1mSteps:\x1b[0m    ${Object.keys(definition.steps).join(", ")}`);
  console.log(`\x1b[1mTimeout:\x1b[0m  ${definition.timeout}`);

  // 2. Validate DAG
  const errors = validateDag(definition);
  if (errors.length > 0) {
    console.error("\n\x1b[31mDAG validation failed:\x1b[0m");
    for (const e of errors) {
      console.error(`  - ${e.message}`);
    }
    process.exit(1);
  }

  // 3. Setup workspace
  const ws = workspaceDir
    ? path.resolve(workspaceDir)
    : await mkdtemp(path.join(tmpdir(), "agentcore-wf-"));

  const contextDir = path.join(ws, "context");
  console.log(`\x1b[1mWorkspace:\x1b[0m${ws}`);
  console.log("");

  // 4. Execute
  const runner = new ShellStepRunner(verbose);
  const ctx = new ContextManager(contextDir);
  const executor = new WorkflowExecutor(definition, ctx, runner, ws);

  const startTime = Date.now();
  const state = await executor.execute();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // 5. Report results
  console.log("");
  console.log("\x1b[1m─── Results ───\x1b[0m");
  console.log("");

  const stepIds = Object.keys(definition.steps);
  const maxLen = Math.max(...stepIds.map((s) => s.length));

  for (const stepId of stepIds) {
    const stepState = state.steps[stepId]!;
    const icon = STATUS_ICON[stepState.status] ?? stepState.status;
    const pad = " ".repeat(maxLen - stepId.length);
    let extra = "";
    if (stepState.iteration > 1) {
      extra = ` (${stepState.iteration} iterations)`;
    }
    if (stepState.error) {
      extra += ` — ${stepState.error}`;
    }
    console.log(`  ${icon}  ${stepId}${pad}${extra}`);
  }

  console.log("");
  const wfIcon = WF_ICON[state.status] ?? state.status;
  console.log(`\x1b[1mWorkflow:\x1b[0m ${wfIcon}  (${elapsed}s)`);
  console.log(`\x1b[1mContext:\x1b[0m  ${contextDir}`);

  process.exit(state.status === WorkflowStatus.SUCCEEDED ? 0 : 1);
}

main().catch((err) => {
  console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
