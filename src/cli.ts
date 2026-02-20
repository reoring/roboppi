#!/usr/bin/env bun
/**
 * AgentCore CLI — execution control runtime for AI agents.
 *
  * Modes:
  *   roboppi [options]                       Core IPC server (stdin/stdout JSON Lines)
  *   roboppi run --worker <kind> ...         One-shot worker task execution
  *   roboppi workflow <workflow.yaml> ...    Workflow runner
  *   roboppi daemon <daemon.yaml> ...        Daemon mode
 *
 * Compatibility alias:
 *   agentcore (same CLI)
 */
import { applyEnvPrefixAliases } from "./core/env-aliases.js";
import type { AgentCoreConfig } from "./core/agentcore.js";
import type { LogLevel } from "./core/observability.js";
import { startCoreRuntime } from "./core/core-runtime.js";
import { ExecutionBudget } from "./core/execution-budget.js";
import { BackpressureController } from "./core/backpressure.js";
import { CircuitBreakerRegistry } from "./core/circuit-breaker.js";
import { PermitGate } from "./core/permit-gate.js";
import { ProcessManager } from "./worker/process-manager.js";
import { OpenCodeAdapter } from "./worker/adapters/opencode-adapter.js";
import { ClaudeCodeAdapter } from "./worker/adapters/claude-code-adapter.js";
import { CodexCliAdapter } from "./worker/adapters/codex-cli-adapter.js";
import type { WorkerAdapter } from "./worker/worker-adapter.js";
import { generateId } from "./types/common.js";
import { WorkerKind, WorkerCapability, OutputMode, WorkerStatus, JobType, PriorityClass } from "./types/index.js";
import type { WorkerTask, Job } from "./types/index.js";

applyEnvPrefixAliases();

// ── Argument parsing ──────────────────────────────────────────────

interface SharedOptions {
  help: boolean;
  version: boolean;
  concurrency: number | undefined;
  rps: number | undefined;
  maxCost: number | undefined;
  bpReject: number | undefined;
  bpDefer: number | undefined;
  bpDegrade: number | undefined;
  cbThreshold: number | undefined;
  cbResetMs: number | undefined;
  cbHalfOpenMax: number | undefined;
  logLevel: LogLevel | undefined;
}

interface RunOptions {
  worker: string;
  workspace: string;
  model: string;
  capabilities: string;
  timeout: number;
  instructions: string;
}

type CliMode = { mode: "server"; opts: SharedOptions } | { mode: "run"; opts: SharedOptions; run: RunOptions };

const HELP_TEXT = `
roboppi — execution-control runtime for agentic workers

USAGE
  roboppi [options]                          Start Core IPC server mode
  roboppi run [options] <instructions...>    Run a one-shot worker task
  roboppi workflow <workflow.yaml> [options] Run a workflow YAML
  roboppi daemon <daemon.yaml> [options]     Run daemon mode (resident workflows)
  roboppi agent [options] <instructions...>  Alias for 'roboppi run'

IPC SERVER MODE
  Reads JSON Lines from stdin, writes responses to stdout. Logs go to stderr.

RUN MODE OPTIONS
  --worker <kind>         Worker to use: opencode, claude-code, codex  (required)
  --workspace <path>      Working directory for the worker             (required)
  --model <id>            Model identifier (adapter-specific)          (optional)
  --capabilities <csv>    Comma-separated: READ,EDIT,RUN_TESTS,RUN_COMMANDS
                                                                        (default: EDIT)
  --timeout <ms>          Task timeout in milliseconds                 (default: 120000)

SHARED OPTIONS
  --concurrency <n>       Max concurrent permits                       (default: 10)
  --rps <n>               Max requests per second                      (default: 50)
  --max-cost <n>          Cumulative cost budget limit                  (default: unlimited)

  --bp-reject <n>         Backpressure: reject threshold               (default: 100)
  --bp-defer <n>          Backpressure: defer threshold                (default: 75)
  --bp-degrade <n>        Backpressure: degrade threshold              (default: 50)

  --cb-threshold <n>      Circuit breaker failure threshold             (default: 5)
  --cb-reset-ms <n>       Circuit breaker reset timeout ms              (default: 30000)
  --cb-half-open <n>      Circuit breaker half-open attempts            (default: 3)

  --log-level <level>     Log level: debug|info|warn|error|fatal       (default: info)

  --help, -h              Show this help message
  --version, -v           Show version

EXAMPLES
  # IPC server mode
  echo '{"type":"submit_job",...}' | roboppi

  # One-shot: have OpenCode create files
  roboppi run --worker opencode --workspace /tmp/demo "Create hello.ts"

  # One-shot: have Claude Code fix tests
  roboppi run --worker claude-code --workspace ./my-project \\
    --capabilities EDIT,RUN_TESTS "Fix the failing tests"

  # One-shot with budget options
  roboppi run --worker opencode --workspace /tmp/demo \\
    --timeout 60000 --concurrency 5 "Write a README"

  # Run a workflow
  roboppi workflow examples/hello-world.yaml --verbose

  # Run daemon mode
  roboppi daemon examples/daemon/simple-cron.yaml --verbose
`.trim();

const VERSION = "0.1.0";

const VALID_LOG_LEVELS = new Set(["debug", "info", "warn", "error", "fatal"]);

const VALID_WORKERS: Record<string, WorkerKind> = {
  opencode: WorkerKind.OPENCODE,
  "claude-code": WorkerKind.CLAUDE_CODE,
  codex: WorkerKind.CODEX_CLI,
};

const VALID_CAPABILITIES: Record<string, WorkerCapability> = {
  READ: WorkerCapability.READ,
  EDIT: WorkerCapability.EDIT,
  RUN_TESTS: WorkerCapability.RUN_TESTS,
  RUN_COMMANDS: WorkerCapability.RUN_COMMANDS,
};

function die(msg: string): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

function parseCliArgs(argv: string[]): CliMode {
  const shared: SharedOptions = {
    help: false,
    version: false,
    concurrency: undefined,
    rps: undefined,
    maxCost: undefined,
    bpReject: undefined,
    bpDefer: undefined,
    bpDegrade: undefined,
    cbThreshold: undefined,
    cbResetMs: undefined,
    cbHalfOpenMax: undefined,
    logLevel: undefined,
  };

  // Detect "run" subcommand
  if (argv[0] === "run") {
    const run: RunOptions = {
      worker: "",
      workspace: "",
      model: "",
      capabilities: "EDIT",
      timeout: 120000,
      instructions: "",
    };
    const positional: string[] = [];

    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]!;
      const next = (): string => {
        i++;
        const val = argv[i];
        if (val === undefined) die(`${arg} requires a value`);
        return val;
      };
      const nextInt = (): number => {
        const v = Number(next());
        if (!Number.isFinite(v) || v < 0) die(`${arg} requires a non-negative number`);
        return v;
      };

      if (arg === "--help" || arg === "-h") { shared.help = true; continue; }
      if (arg === "--worker") { run.worker = next(); continue; }
      if (arg === "--workspace") { run.workspace = next(); continue; }
      if (arg === "--model") { run.model = next(); continue; }
      if (arg === "--capabilities") { run.capabilities = next(); continue; }
      if (arg === "--timeout") { run.timeout = nextInt(); continue; }
      if (arg === "--concurrency") { shared.concurrency = nextInt(); continue; }
      if (arg === "--rps") { shared.rps = nextInt(); continue; }
      if (arg === "--max-cost") { shared.maxCost = nextInt(); continue; }
      if (arg === "--bp-reject") { shared.bpReject = nextInt(); continue; }
      if (arg === "--bp-defer") { shared.bpDefer = nextInt(); continue; }
      if (arg === "--bp-degrade") { shared.bpDegrade = nextInt(); continue; }
      if (arg === "--cb-threshold") { shared.cbThreshold = nextInt(); continue; }
      if (arg === "--cb-reset-ms") { shared.cbResetMs = nextInt(); continue; }
      if (arg === "--cb-half-open") { shared.cbHalfOpenMax = nextInt(); continue; }
      if (arg === "--log-level") {
        const level = next();
        if (!VALID_LOG_LEVELS.has(level)) die(`invalid log level "${level}". Must be one of: debug, info, warn, error, fatal`);
        shared.logLevel = level as LogLevel;
        continue;
      }
       if (arg.startsWith("-")) die(`unknown option "${arg}"\nRun 'roboppi run --help' for usage.`);
       positional.push(arg);
     }

    run.instructions = positional.join(" ");
    return { mode: "run", opts: shared, run };
  }

  // Server mode
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      i++;
      const val = argv[i];
      if (val === undefined) die(`${arg} requires a value`);
      return val;
    };
    const nextInt = (): number => {
      const v = Number(next());
      if (!Number.isFinite(v) || v < 0) die(`${arg} requires a non-negative number`);
      return v;
    };

    switch (arg) {
      case "--help": case "-h": shared.help = true; break;
      case "--version": case "-v": shared.version = true; break;
      case "--concurrency": shared.concurrency = nextInt(); break;
      case "--rps": shared.rps = nextInt(); break;
      case "--max-cost": shared.maxCost = nextInt(); break;
      case "--bp-reject": shared.bpReject = nextInt(); break;
      case "--bp-defer": shared.bpDefer = nextInt(); break;
      case "--bp-degrade": shared.bpDegrade = nextInt(); break;
      case "--cb-threshold": shared.cbThreshold = nextInt(); break;
      case "--cb-reset-ms": shared.cbResetMs = nextInt(); break;
      case "--cb-half-open": shared.cbHalfOpenMax = nextInt(); break;
      case "--log-level": {
        const level = next();
        if (!VALID_LOG_LEVELS.has(level)) die(`invalid log level "${level}". Must be one of: debug, info, warn, error, fatal`);
        shared.logLevel = level as LogLevel;
        break;
      }
      default:
        die(`unknown option "${arg}"\nRun 'roboppi --help' for usage.`);
    }
  }
  return { mode: "server", opts: shared };
}

function buildConfig(opts: SharedOptions): AgentCoreConfig {
  const config: AgentCoreConfig = {};
  if (opts.concurrency !== undefined || opts.rps !== undefined || opts.maxCost !== undefined) {
    config.budget = {
      maxConcurrency: opts.concurrency ?? 10,
      maxRps: opts.rps ?? 50,
      ...(opts.maxCost !== undefined && { maxCostBudget: opts.maxCost }),
    };
  }
  if (opts.bpReject !== undefined || opts.bpDefer !== undefined || opts.bpDegrade !== undefined) {
    config.backpressure = {
      rejectThreshold: opts.bpReject ?? 100,
      deferThreshold: opts.bpDefer ?? 75,
      degradeThreshold: opts.bpDegrade ?? 50,
    };
  }
  if (opts.cbThreshold !== undefined || opts.cbResetMs !== undefined || opts.cbHalfOpenMax !== undefined) {
    config.circuitBreaker = {
      failureThreshold: opts.cbThreshold ?? 5,
      resetTimeoutMs: opts.cbResetMs ?? 30000,
      halfOpenMaxAttempts: opts.cbHalfOpenMax ?? 3,
    };
  }
  if (opts.logLevel !== undefined) {
    config.logLevel = opts.logLevel;
  }
  return config;
}

// ── Logger ────────────────────────────────────────────────────────

function createLogger(component: string) {
  return {
    error(msg: string, data?: unknown) {
      process.stderr.write(
        JSON.stringify({ timestamp: Date.now(), level: "error", component, message: msg, data }) + "\n",
      );
    },
    info(msg: string, data?: unknown) {
      process.stderr.write(
        JSON.stringify({ timestamp: Date.now(), level: "info", component, message: msg, data }) + "\n",
      );
    },
  };
}

// ── Run mode ──────────────────────────────────────────────────────

async function executeRun(opts: SharedOptions, run: RunOptions): Promise<void> {
  const logger = createLogger("run");

  // Validate required args
  if (!run.worker) die("--worker is required.\nUsage: roboppi run --worker <kind> --workspace <path> <instructions>");
  if (!run.workspace) die("--workspace is required.\nUsage: roboppi run --worker <kind> --workspace <path> <instructions>");
  if (!run.instructions) die("instructions are required.\nUsage: roboppi run --worker <kind> --workspace <path> \"your instructions\"");

  const workerKind = VALID_WORKERS[run.worker];
  if (!workerKind) die(`unknown worker "${run.worker}". Must be one of: ${Object.keys(VALID_WORKERS).join(", ")}`);

  // Parse capabilities
  const capabilities: WorkerCapability[] = run.capabilities.split(",").map(s => {
    const cap = VALID_CAPABILITIES[s.trim()];
    if (!cap) die(`unknown capability "${s.trim()}". Must be one of: ${Object.keys(VALID_CAPABILITIES).join(", ")}`);
    return cap;
  });

  const config = buildConfig(opts);

  // Build core safety components
  const budget = new ExecutionBudget(config.budget ?? { maxConcurrency: 10, maxRps: 50 });
  const backpressure = new BackpressureController(config.backpressure ?? { rejectThreshold: 1.0, deferThreshold: 0.75, degradeThreshold: 0.5 });
  const circuitBreakers = new CircuitBreakerRegistry(config.circuitBreaker);
  const permitGate = new PermitGate(budget, circuitBreakers, backpressure);
  const pm = new ProcessManager();

  // Create the requested worker adapter
  let adapter: WorkerAdapter;
  switch (workerKind) {
    case WorkerKind.OPENCODE:
      adapter = new OpenCodeAdapter(pm);
      break;
    case WorkerKind.CLAUDE_CODE:
      adapter = new ClaudeCodeAdapter({}, pm);
      break;
    case WorkerKind.CODEX_CLI:
      adapter = new CodexCliAdapter(pm);
      break;
    default:
      die(`unsupported worker kind: ${workerKind}`);
  }

  // Build a job
  const jobId = generateId();
  const job: Job = {
    jobId,
    type: JobType.WORKER_TASK,
    priority: { value: 1, class: PriorityClass.INTERACTIVE },
    payload: {},
    limits: { timeoutMs: run.timeout, maxAttempts: 1 },
    context: { traceId: generateId(), correlationId: generateId() },
  };

  logger.info("Requesting permit", { worker: run.worker, workspace: run.workspace });

  // Request a permit through the safety gate
  const permitResult = permitGate.requestPermit(job, 0);
  if (!("permitId" in permitResult)) {
    die(`Permit rejected: ${permitResult.reason} — ${permitResult.detail ?? ""}`);
  }
  const permit = permitResult;

  logger.info("Permit granted, delegating to worker", {
    permitId: permit.permitId,
    worker: run.worker,
    instructions: run.instructions.slice(0, 100),
  });

  // Build the worker task
  const task: WorkerTask = {
    workerTaskId: generateId(),
    workerKind,
    workspaceRef: run.workspace,
    instructions: run.instructions,
    ...(run.model ? { model: run.model } : {}),
    capabilities,
    outputMode: OutputMode.BATCH,
    budget: { deadlineAt: Date.now() + run.timeout },
    abortSignal: permit.abortController.signal,
  };

  // Wire SIGINT/SIGTERM to cancel
  const cancelHandler = () => {
    logger.info("Cancelling worker task");
    permit.abortController.abort("User cancelled");
  };
  process.on("SIGINT", cancelHandler);
  process.on("SIGTERM", cancelHandler);

  // Start the worker task
  try {
    const handle = await adapter.startTask(task);

    // Wire abort signal to cancel
    const onAbort = () => { adapter.cancel(handle); };
    if (permit.abortController.signal.aborted) {
      await adapter.cancel(handle);
    } else {
      permit.abortController.signal.addEventListener("abort", onAbort, { once: true });
    }

    // Stream worker events as JSON Lines to stderr, parallel with awaitResult
    const streamDone = (async () => {
      try {
        for await (const event of adapter.streamEvents(handle)) {
          // If data is a JSON string, parse it so it embeds as an object (no double-escape)
          let data: unknown = event.type === "stdout" || event.type === "stderr" ? event.data : event;
          if (typeof data === "string") {
            try { data = JSON.parse(data); } catch { /* keep as string */ }
          }
          process.stderr.write(JSON.stringify({ timestamp: Date.now(), component: "worker", type: event.type, data }) + "\n");
        }
      } catch {
        // Stream may close early on abort — that's fine
      }
    })();

    const result = await adapter.awaitResult(handle);
    await streamDone;

    permit.abortController.signal.removeEventListener("abort", onAbort);
    permitGate.completePermit(permit.permitId);

    const elapsed = (result.cost.wallTimeMs / 1000).toFixed(1);

    if (result.status === WorkerStatus.SUCCEEDED) {
      logger.info("Task completed successfully", { elapsed: `${elapsed}s` });
      process.exit(0);
    } else if (result.status === WorkerStatus.CANCELLED) {
      logger.info("Task was cancelled", { elapsed: `${elapsed}s` });
      process.exit(130);
    } else {
      logger.error("Task failed", { elapsed: `${elapsed}s`, errorClass: result.errorClass });
      process.exit(1);
    }
  } catch (err) {
    permitGate.completePermit(permit.permitId);
    logger.error("Task execution error", err);
    process.exit(1);
  } finally {
    permitGate.dispose();
    circuitBreakers.dispose();
  }
}

// ── Server mode ───────────────────────────────────────────────────

function startServer(opts: SharedOptions): void {
  const config = buildConfig(opts);
  startCoreRuntime({
    config,
    loggerComponent: "cli",
  });
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv[0] === "workflow") {
    const { runWorkflowCli } = await import("./workflow/run.js");
    await runWorkflowCli(argv.slice(1));
    return;
  }

  if (argv[0] === "daemon") {
    const { runDaemonCli } = await import("./daemon/cli.js");
    await runDaemonCli(argv.slice(1));
    return;
  }

  // Alias: `roboppi agent ...` == `roboppi run ...`
  const parsed = argv[0] === "agent"
    ? parseCliArgs(["run", ...argv.slice(1)])
    : parseCliArgs(argv);

  if (parsed.opts.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (parsed.opts.version) {
    console.log(`roboppi ${VERSION}`);
    process.exit(0);
  }

  if (parsed.mode === "run") {
    await executeRun(parsed.opts, parsed.run);
  } else {
    startServer(parsed.opts);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
});
