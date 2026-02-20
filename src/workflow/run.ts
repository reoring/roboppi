#!/usr/bin/env bun
/**
 * Workflow Runner CLI
 *
 * Usage:
 *   roboppi workflow <workflow.yaml> [--workspace <dir>] [--verbose] [--direct]
 *   (dev) bun run src/workflow/run.ts <workflow.yaml> [--workspace <dir>] [--verbose] [--direct]
 */
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflow } from "./parser.js";
import { parseAgentCatalog, type AgentCatalog } from "./agent-catalog.js";
import { validateDag } from "./dag-validator.js";
import { ContextManager } from "./context-manager.js";
import { WorkflowExecutor } from "./executor.js";
import { MultiWorkerStepRunner } from "./multi-worker-step-runner.js";
import { CoreIpcStepRunner } from "./core-ipc-step-runner.js";
import { WorkflowStatus, StepStatus } from "./types.js";
import { parseDuration } from "./duration.js";
import {
  resolveBranchRuntimeContext,
  type BranchRuntimeContext,
} from "./branch-context.js";

function isRunningUnderBun(): boolean {
  const base = path.basename(process.execPath).toLowerCase();
  return base === "bun" || base === "bun.exe";
}

function resolveCoreEntryPointForSupervised(coreEntryPointOverride: string | undefined): string {
  const fromCli = coreEntryPointOverride?.trim();
  if (fromCli) return fromCli;

  const fromEnv = process.env.ROBOPPI_CORE_ENTRYPOINT?.trim();
  if (fromEnv) return fromEnv;

  // Compiled binary: spawn this executable as the Core process.
  if (!isRunningUnderBun()) {
    return process.execPath;
  }

  // Dev mode: run Core from source.
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "index.ts",
  );
}

function resolveIpcRequestTimeoutMs(supervisedMode: boolean, ipcRequestTimeout: string | undefined): number {
  if (!supervisedMode) return 0;

  const fromCli = ipcRequestTimeout;
  const fromEnv = process.env.ROBOPPI_IPC_REQUEST_TIMEOUT;
  const fromEnvMs = process.env.ROBOPPI_IPC_REQUEST_TIMEOUT_MS;

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

function splitPathList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(":")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function loadAgentCatalogForWorkflow(
  workflowYamlPath: string,
  verboseMode: boolean,
  agentsFiles: string[],
): Promise<AgentCatalog | undefined> {
  const fromEnv = splitPathList(process.env.ROBOPPI_AGENTS_FILE);
  const fromCli = agentsFiles;

  // If any explicit path is provided, only load those (env first, then CLI overrides).
  const explicit = [...fromEnv, ...fromCli];

  const candidates: string[] = [];
  if (explicit.length > 0) {
    candidates.push(...explicit.map((p) => path.resolve(p)));
  } else {
    const dir = path.dirname(workflowYamlPath);
    candidates.push(path.join(dir, "agents.yaml"));
    candidates.push(path.join(dir, "agents.yml"));
  }

  let catalog: AgentCatalog | undefined;
  for (const p of candidates) {
    try {
      const content = await readFile(p, "utf-8");
      const parsed = parseAgentCatalog(content);
      catalog = { ...(catalog ?? {}), ...parsed };
      if (verboseMode) {
        process.stderr.write(`[workflow] loaded agent catalog: ${p} (agents=${Object.keys(parsed).length})\n`);
      }
    } catch (err: unknown) {
      const code = (err as any)?.code;

      // In implicit mode, missing default files are ignored.
      if (explicit.length === 0 && code === "ENOENT") {
        continue;
      }

      if (code === "ENOENT") {
        throw new Error(`Agent catalog not found: ${p}`);
      }
      throw err;
    }
  }

  return catalog;
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

function resolveKeepaliveEnabled(keepalive: boolean | undefined): boolean {
  if (keepalive !== undefined) return keepalive;
  const env = parseEnvBool(process.env.ROBOPPI_KEEPALIVE);
  if (env !== undefined) return env;
  return isNonInteractive();
}

function resolveKeepaliveIntervalMs(keepaliveInterval: string | undefined): number {
  const raw =
    keepaliveInterval ??
    process.env.ROBOPPI_KEEPALIVE_INTERVAL ??
    "10s";
  try {
    return parseDuration(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid keepalive interval: ${raw} (${msg})`);
  }
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

function printBranchContext(context: BranchRuntimeContext): void {
  if (!context.enabled) {
    console.log("\x1b[1mBranch Lock:\x1b[0m disabled");
    for (const warning of context.warnings) {
      process.stderr.write(`[workflow][warn] ${warning}\n`);
    }
    return;
  }

  console.log("\x1b[1mBranch Lock:\x1b[0m enabled");
  console.log(`  startup_branch: ${context.startupBranch ?? ""}`);
  console.log(`  startup_head_sha: ${context.startupHeadSha ?? ""}`);
  console.log(`  startup_toplevel: ${context.startupToplevel ?? ""}`);
  console.log(`  effective_base_branch: ${context.effectiveBaseBranch ?? ""}`);
  console.log(`  effective_base_branch_source: ${context.effectiveBaseBranchSource ?? ""}`);
  console.log(`  effective_base_sha: ${context.effectiveBaseSha ?? ""}`);
  console.log(`  create_branch: ${context.createBranch}`);
  if (context.expectedWorkBranch) {
    console.log(`  expected_work_branch: ${context.expectedWorkBranch}`);
  }
  if (context.expectedCurrentBranch) {
    console.log(`  expected_current_branch: ${context.expectedCurrentBranch}`);
  }
  if (context.branchTransitionStep) {
    console.log(`  branch_transition_step: ${context.branchTransitionStep}`);
  }
  console.log(`  protected_branches: ${context.protectedBranches.join(",")}`);
  console.log(`  protected_branches_source: ${context.protectedBranchesSource}`);
  console.log(`  allow_protected_branch: ${context.allowProtectedBranch}`);

  for (const warning of context.warnings) {
    process.stderr.write(`[workflow][warn] ${warning}\n`);
  }
}

export async function runWorkflowCli(argv: string[]): Promise<void> {
  const args = argv;
  let yamlPath = "";
  let workspaceDir = "";
  let verbose = false;
  let supervised = true;
  let keepalive: boolean | undefined;
  let keepaliveInterval: string | undefined;
  let ipcRequestTimeout: string | undefined;
  let cliBaseBranch: string | undefined;
  let cliProtectedBranches: string | undefined;
  let cliAllowProtectedBranch = false;
  const agentsFiles: string[] = [];
  let coreEntryPointOverride: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--workspace" || arg === "-w") {
      i++;
      workspaceDir = args[i] ?? "";
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--supervised") {
      supervised = true;
    } else if (arg === "--direct" || arg === "--no-supervised") {
      supervised = false;
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
    } else if (arg === "--base-branch") {
      i++;
      cliBaseBranch = args[i] ?? "";
    } else if (arg === "--protected-branches") {
      i++;
      cliProtectedBranches = args[i] ?? "";
    } else if (arg === "--allow-protected-branch") {
      cliAllowProtectedBranch = true;
    } else if (arg === "--agents") {
      i++;
      const p = args[i] ?? "";
      if (!p) {
        console.error("Error: --agents requires a value");
        process.exit(1);
      }
      agentsFiles.push(p);
    } else if (arg === "--core" || arg === "--core-entrypoint") {
      i++;
      coreEntryPointOverride = args[i] ?? "";
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  roboppi workflow <workflow.yaml> [options]
  (dev) bun run src/workflow/run.ts <workflow.yaml> [options]

Options:
  --workspace, -w <dir>   Working directory for steps (default: temp dir)
  --verbose, -v           Show step output
  --supervised            Supervised mode (default): delegate steps via Core IPC (Supervisor -> Core -> Worker)
  --direct                Direct mode: spawn worker CLIs directly (no Core IPC)
  --no-supervised         Alias for --direct
  --keepalive             Emit periodic output to avoid no-output watchdogs
  --no-keepalive          Disable keepalive output
  --keepalive-interval <d>  Keepalive interval (DurationString; default: 10s)
  --ipc-request-timeout <d>  IPC request timeout in supervised mode (DurationString; default: 2m)
  --base-branch <name>      Explicit base branch (overrides BASE_BRANCH env)
  --protected-branches <csv>  Protected work branches (default: main,master,release/*)
  --allow-protected-branch  Allow execution on protected branch (dangerous)
  --agents <path>           Agent catalog YAML (repeatable; merged with ROBOPPI_AGENTS_FILE; CLI wins on conflicts)
  --core <path|cmd>          Core entrypoint for supervised mode (default: auto)
  --help, -h              Show help`);
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      yamlPath = arg;
    }
  }

  if (verbose) {
    process.env.ROBOPPI_VERBOSE = "1";
  }

  // Keepalive flags should propagate to any supervised child processes (Core).
  if (keepalive !== undefined) {
    process.env.ROBOPPI_KEEPALIVE = keepalive ? "1" : "0";
  }
  if (keepaliveInterval !== undefined && keepaliveInterval !== "") {
    process.env.ROBOPPI_KEEPALIVE_INTERVAL = keepaliveInterval;
  }

  if (!yamlPath) {
    console.error("Error: workflow YAML path is required");
    console.error("Usage: roboppi workflow <workflow.yaml> [options]");
    process.exit(1);
  }

  try {
    // 1. Read and parse YAML
    const resolvedPath = path.resolve(yamlPath);
    console.log(`\x1b[1mWorkflow:\x1b[0m ${resolvedPath}`);

    const yamlContent = await readFile(resolvedPath, "utf-8");
    const agentCatalog = await loadAgentCatalogForWorkflow(resolvedPath, verbose, agentsFiles);
    const definition = parseWorkflow(yamlContent, { agents: agentCatalog });

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
      : await mkdtemp(path.join(tmpdir(), "roboppi-wf-"));

    // Context directory can be overridden by workflow YAML (context_dir).
    // Resolve relative paths from the workspace root.
    const contextDir = definition.context_dir
      ? path.resolve(ws, definition.context_dir)
      : path.join(ws, "context");
    console.log(`\x1b[1mWorkspace:\x1b[0m${ws}`);

    const branchContext = await resolveBranchRuntimeContext({
      workspaceDir: ws,
      cliBaseBranch,
      envBaseBranch: process.env.BASE_BRANCH,
      cliProtectedBranches,
      envProtectedBranches: process.env.ROBOPPI_PROTECTED_BRANCHES,
      cliAllowProtectedBranch,
      envAllowProtectedBranch: process.env.ROBOPPI_ALLOW_PROTECTED_BRANCH,
      createBranch: definition.create_branch ?? false,
      expectedWorkBranch: definition.expected_work_branch,
      branchTransitionStep: definition.branch_transition_step,
      stepIds: Object.keys(definition.steps),
    });
    printBranchContext(branchContext);
    console.log("");

    // Default supervised IPC transport.
    //
    // Some non-interactive runners exhibit broken stdio pipes between parent/child
    // processes. Use the socket transport by default in non-interactive mode.
    // (Override via ROBOPPI_SUPERVISED_IPC_TRANSPORT=stdio|socket|tcp.)
    if (supervised && process.env.ROBOPPI_SUPERVISED_IPC_TRANSPORT === undefined) {
      process.env.ROBOPPI_SUPERVISED_IPC_TRANSPORT = isNonInteractive() ? "socket" : "stdio";
    }

    // 4. Execute
    const runner = supervised
      ? new CoreIpcStepRunner({
          verbose,
          coreEntryPoint: resolveCoreEntryPointForSupervised(coreEntryPointOverride),
          ipcRequestTimeoutMs: resolveIpcRequestTimeoutMs(true, ipcRequestTimeout),
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
    const workflowEnv: Record<string, string> = {};
    if (verbose) {
      workflowEnv.ROBOPPI_VERBOSE = "1";
    }
    workflowEnv.ROBOPPI_CREATE_BRANCH = branchContext.createBranch ? "1" : "0";
    workflowEnv.ROBOPPI_PROTECTED_BRANCHES = branchContext.protectedBranches.join(",");
    workflowEnv.ROBOPPI_ALLOW_PROTECTED_BRANCH = branchContext.allowProtectedBranch
      ? "1"
      : "0";
    if (branchContext.effectiveBaseBranch) {
      workflowEnv.BASE_BRANCH = branchContext.effectiveBaseBranch;
      workflowEnv.ROBOPPI_EFFECTIVE_BASE_BRANCH = branchContext.effectiveBaseBranch;
    }
    if (branchContext.effectiveBaseBranchSource) {
      workflowEnv.ROBOPPI_EFFECTIVE_BASE_BRANCH_SOURCE =
        branchContext.effectiveBaseBranchSource;
    }
    if (branchContext.effectiveBaseSha) {
      workflowEnv.ROBOPPI_EFFECTIVE_BASE_SHA = branchContext.effectiveBaseSha;
    }
    if (branchContext.startupBranch) {
      workflowEnv.ROBOPPI_STARTUP_BRANCH = branchContext.startupBranch;
    }
    if (branchContext.startupHeadSha) {
      workflowEnv.ROBOPPI_STARTUP_HEAD_SHA = branchContext.startupHeadSha;
    }
    if (branchContext.startupToplevel) {
      workflowEnv.ROBOPPI_STARTUP_TOPLEVEL = branchContext.startupToplevel;
    }
    if (branchContext.expectedWorkBranch) {
      workflowEnv.ROBOPPI_EXPECTED_WORK_BRANCH = branchContext.expectedWorkBranch;
    }
    if (branchContext.expectedCurrentBranch) {
      workflowEnv.ROBOPPI_EXPECTED_CURRENT_BRANCH = branchContext.expectedCurrentBranch;
    }
    const executorEnv =
      Object.keys(workflowEnv).length > 0 ? workflowEnv : undefined;
    const executor = new WorkflowExecutor(
      definition,
      ctx,
      runner,
      ws,
      executorEnv,
      undefined,
      branchContext,
    );

    const startTime = Date.now();
    const keepaliveEnabled = resolveKeepaliveEnabled(keepalive);
    const keepaliveIntervalMs = keepaliveEnabled ? resolveKeepaliveIntervalMs(keepaliveInterval) : 0;
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
  } catch (err) {
    console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  runWorkflowCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`\x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
