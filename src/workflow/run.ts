#!/usr/bin/env bun
/**
 * Workflow Runner CLI
 *
 * Usage:
 *   bun run src/workflow/run.ts <workflow.yaml> [--workspace <dir>] [--verbose] [--supervised]
 */
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow } from "./parser.js";
import { validateDag } from "./dag-validator.js";
import { ContextManager } from "./context-manager.js";
import { WorkflowExecutor } from "./executor.js";
import { MultiWorkerStepRunner } from "./multi-worker-step-runner.js";
import { CoreIpcStepRunner } from "./core-ipc-step-runner.js";
import { WorkflowStatus, StepStatus } from "./types.js";
import { parseDuration } from "./duration.js";

// ── Argument parsing ────────────────────────────────────────────

const args = process.argv.slice(2);
let yamlPath = "";
let workspaceDir = "";
let verbose = false;
let supervised = false;
let keepalive: boolean | undefined;
let keepaliveInterval: string | undefined;
let ipcRequestTimeout: string | undefined;

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--workspace" || arg === "-w") {
    i++;
    workspaceDir = args[i] ?? "";
  } else if (arg === "--verbose" || arg === "-v") {
    verbose = true;
  } else if (arg === "--supervised") {
    supervised = true;
  } else if (arg === "--keepalive") {
    keepalive = true;
  } else if (arg === "--no-keepalive") {
    keepalive = false;
  } else if (arg === "--keepalive-interval") {
    keepalive = true;
    i++;
    keepaliveInterval = args[i] ?? "";
  } else if (arg === "--ipc-request-timeout") {
    i++;
    ipcRequestTimeout = args[i] ?? "";
  } else if (arg === "--help" || arg === "-h") {
    console.log(`Usage: bun run src/workflow/run.ts <workflow.yaml> [options]

Options:
  --workspace, -w <dir>   Working directory for steps (default: temp dir)
  --verbose, -v           Show step output
  --supervised            Delegate steps via Core IPC (Supervisor -> Core -> Worker)
  --keepalive             Emit periodic output to avoid no-output watchdogs
  --no-keepalive          Disable keepalive output
  --keepalive-interval <d>  Keepalive interval (DurationString; default: 10s)
  --ipc-request-timeout <d>  IPC request timeout in supervised mode (DurationString; default: 2m)
  --help, -h              Show help`);
    process.exit(0);
  } else if (!arg.startsWith("-")) {
    yamlPath = arg;
  }
}

if (verbose) {
  process.env.AGENTCORE_VERBOSE = "1";
}

// Keepalive flags should propagate to any supervised child processes (Core).
if (keepalive !== undefined) {
  process.env.AGENTCORE_KEEPALIVE = keepalive ? "1" : "0";
}
if (keepaliveInterval !== undefined && keepaliveInterval !== "") {
  process.env.AGENTCORE_KEEPALIVE_INTERVAL = keepaliveInterval;
}

function resolveIpcRequestTimeoutMs(supervisedMode: boolean): number {
  if (!supervisedMode) return 0;

  const fromCli = ipcRequestTimeout;
  const fromEnv = process.env.AGENTCORE_IPC_REQUEST_TIMEOUT;
  const fromEnvMs = process.env.AGENTCORE_IPC_REQUEST_TIMEOUT_MS;

  if (fromCli !== undefined) {
    return parseDurationOrThrow(fromCli, "IPC request timeout");
  }
  if (fromEnv !== undefined) {
    return parseDurationOrThrow(fromEnv, "IPC request timeout");
  }
  if (fromEnvMs !== undefined) {
    const n = Number(fromEnvMs);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Invalid IPC request timeout ms: ${fromEnvMs}`);
    }
    return Math.floor(n);
  }

  return parseDuration("2m");
}

function parseDurationOrThrow(value: string, label: string): number {
  try {
    return parseDuration(value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid ${label}: ${value} (${msg})`);
  }
}

function isNonInteractive(): boolean {
  // Bun sets isTTY on stdout/stderr similarly to Node.
  // Treat either stream being a TTY as interactive.
  return !(process.stdout.isTTY || process.stderr.isTTY);
}

function parseEnvBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

function resolveKeepaliveEnabled(): boolean {
  if (keepalive !== undefined) return keepalive;
  const env = parseEnvBool(process.env.AGENTCORE_KEEPALIVE);
  if (env !== undefined) return env;
  return isNonInteractive();
}

function resolveKeepaliveIntervalMs(): number {
  const raw =
    keepaliveInterval ??
    process.env.AGENTCORE_KEEPALIVE_INTERVAL ??
    "10s";
  try {
    return parseDuration(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid keepalive interval: ${raw} (${msg})`);
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

  // Default supervised IPC transport.
  //
  // Some non-interactive runners exhibit broken stdio pipes between parent/child
  // processes. Use the socket transport by default in non-interactive mode.
  // (Override via AGENTCORE_SUPERVISED_IPC_TRANSPORT=stdio|socket|tcp.)
  if (supervised && process.env.AGENTCORE_SUPERVISED_IPC_TRANSPORT === undefined) {
    process.env.AGENTCORE_SUPERVISED_IPC_TRANSPORT = isNonInteractive() ? "socket" : "stdio";
  }

  // 4. Execute
  const runner = supervised
    ? new CoreIpcStepRunner({
        verbose,
        coreEntryPoint: path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "..",
          "index.ts",
        ),
        ipcRequestTimeoutMs: resolveIpcRequestTimeoutMs(true),
      })
    : new MultiWorkerStepRunner(verbose);

  let shuttingDown = false;
  const shutdown = async (reason: string, exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (supervised) {
      try {
        process.stderr.write(`\n[workflow] shutting down Core: ${reason}\n`);
        await (runner as CoreIpcStepRunner).shutdown();
      } catch {
        // best-effort
      }
    }
    process.exit(exitCode);
  };

  if (supervised) {
    process.on("SIGINT", () => {
      void shutdown("SIGINT", 130);
    });
    process.on("SIGTERM", () => {
      void shutdown("SIGTERM", 143);
    });
  }

  const ctx = new ContextManager(contextDir);
  const executor = new WorkflowExecutor(
    definition,
    ctx,
    runner,
    ws,
    verbose ? { AGENTCORE_VERBOSE: "1" } : undefined,
  );

  const startTime = Date.now();
  const keepaliveEnabled = resolveKeepaliveEnabled();
  const keepaliveIntervalMs = keepaliveEnabled ? resolveKeepaliveIntervalMs() : 0;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  if (keepaliveEnabled) {
    keepaliveTimer = setInterval(() => {
      const elapsedS = Math.floor((Date.now() - startTime) / 1000);
      process.stderr.write(`[workflow] keepalive: running (${elapsedS}s elapsed)\n`);
    }, keepaliveIntervalMs);
  }

  let state;
  try {
    state = await executor.execute();
  } finally {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
    }
    if (supervised) {
      try {
        await (runner as CoreIpcStepRunner).shutdown();
      } catch {
        // best-effort
      }
    }
  }
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
