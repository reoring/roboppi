#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreIpcStepRunner } from "../workflow/core-ipc-step-runner.js";
import { MultiWorkerStepRunner } from "../workflow/multi-worker-step-runner.js";
import { parseDuration } from "../workflow/duration.js";
import { emitTaskActivity } from "./activity-log.js";
import {
  applyGitHubPullRequestActuation,
  applyGitHubPullRequestOpen,
} from "./github-pr-actuator.js";
import { emitTaskIntent, TaskIntentAuthorizationError } from "./intent-log.js";
import { parseTaskOrchestratorConfig } from "./parser.js";
import { TaskOrchestratorService } from "./service.js";
import { TaskOrchestratorServer } from "./server.js";
import { TaskRegistryStore } from "./state-store.js";
import type {
  TaskEnvelope,
  TaskLandingDecision,
  TaskOrchestratorConfig,
  TaskPullRequestOpenRequest,
  TaskRecordState,
  TaskRunRecord,
  TaskRunSummary,
} from "./types.js";

function isNonInteractive(): boolean {
  return !(process.stdout.isTTY || process.stderr.isTTY);
}

function isRunningUnderBun(): boolean {
  const base = path.basename(process.execPath).toLowerCase();
  return base === "bun" || base === "bun.exe";
}

function resolveCoreEntryPointForSupervised(coreEntryPointOverride: string | undefined): string {
  const fromCli = coreEntryPointOverride?.trim();
  if (fromCli) return fromCli;

  const fromEnv = process.env.ROBOPPI_CORE_ENTRYPOINT?.trim();
  if (fromEnv) return fromEnv;

  if (!isRunningUnderBun()) return process.execPath;

  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "index.ts",
  );
}

export async function runTaskOrchestratorCli(argv: string[]): Promise<void> {
  const args = argv;
  const command = args[0];

  if (
    command === undefined ||
    command === "--help" ||
    command === "-h"
  ) {
    printHelp();
    process.exit(0);
  }

  if (command === "run") {
    await runOnceCommand(args.slice(1));
    return;
  }

  if (command === "serve") {
    await runServeCommand(args.slice(1));
    return;
  }

  if (command === "status") {
    await runStatusCommand(args.slice(1));
    return;
  }

  if (command === "activity") {
    await runActivityCommand(args.slice(1));
    return;
  }

  if (command === "intent") {
    await runIntentCommand(args.slice(1));
    return;
  }

  if (command === "github") {
    await runGitHubCommand(args.slice(1));
    return;
  }

  if (command !== "run") {
    console.error(`Error: unknown task-orchestrator subcommand "${command}"`);
    printHelp();
    process.exit(1);
  }
}

async function runOnceCommand(args: string[]): Promise<void> {
  let configPath = "";
  let baseDirOverride = "";
  let verbose = false;
  let jsonOutput = false;
  let supervised = true;
  let coreEntryPointOverride: string | undefined;
  let cliBaseBranch: string | undefined;
  let cliProtectedBranches: string | undefined;
  let cliAllowProtectedBranch = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = (): string => {
      i++;
      const value = args[i];
      if (value === undefined) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--base-dir" || arg === "-C") {
      baseDirOverride = next();
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--supervised") {
      supervised = true;
    } else if (arg === "--direct" || arg === "--no-supervised") {
      supervised = false;
    } else if (arg === "--core" || arg === "--core-entrypoint") {
      coreEntryPointOverride = next();
    } else if (arg === "--base-branch") {
      cliBaseBranch = next();
    } else if (arg === "--protected-branches") {
      cliProtectedBranches = next();
    } else if (arg === "--allow-protected-branch") {
      cliAllowProtectedBranch = true;
    } else if (!arg.startsWith("-") && configPath === "") {
      configPath = arg;
    } else {
      console.error(`Error: unknown option "${arg}"`);
      printHelp();
      process.exit(1);
    }
  }

  if (!configPath) {
    console.error("Error: task orchestrator config YAML path is required");
    console.error("Usage: roboppi task-orchestrator run <config.yaml> [options]");
    process.exit(1);
  }

  if (verbose) {
    process.env.ROBOPPI_VERBOSE = "1";
  }

  if (supervised && process.env.ROBOPPI_SUPERVISED_IPC_TRANSPORT === undefined) {
    process.env.ROBOPPI_SUPERVISED_IPC_TRANSPORT = isNonInteractive() ? "socket" : "stdio";
  }

  const { config, configBaseDir } = await loadTaskOrchestratorConfig(
    configPath,
    baseDirOverride,
  );

  const runner = createTaskOrchestratorRunner({
    supervised,
    verbose,
    coreEntryPointOverride,
  });

  try {
    const service = new TaskOrchestratorService(config, {
      baseDir: configBaseDir,
      stepRunner: runner,
      supervised,
      cliBaseBranch,
      cliProtectedBranches,
      cliAllowProtectedBranch,
    });

    const result = await service.runOnce();
    if (jsonOutput) {
      console.log(JSON.stringify({
        config: {
          name: config.name,
          sources: Object.keys(config.sources).length,
          routes: Object.keys(config.routes).length,
        },
        result,
      }, null, 2));
    } else {
      console.log(`Task Orchestrator: ${config.name}`);
      console.log(`Sources: ${Object.keys(config.sources).length}`);
      console.log(`Routes: ${Object.keys(config.routes).length}`);
      console.log("");

      for (const sourceResult of result.sources) {
        console.log(
          `${sourceResult.sourceId}: candidates=${sourceResult.candidates} dispatched=${sourceResult.dispatched} skipped_active=${sourceResult.skipped_active} skipped_unchanged=${sourceResult.skipped_unchanged} unmatched=${sourceResult.unmatched} failed=${sourceResult.failed} acked=${sourceResult.acked} ack_failed=${sourceResult.ack_failed}`,
        );
        for (const error of sourceResult.errors) {
          console.log(
            `  error[${error.stage}]${error.ref ? ` ref=${error.ref}` : ""}${error.taskId ? ` task=${error.taskId}` : ""}: ${error.message}`,
          );
        }
      }
      console.log("");
      console.log(
        `Totals: candidates=${result.totals.candidates} dispatched=${result.totals.dispatched} skipped_active=${result.totals.skipped_active} skipped_unchanged=${result.totals.skipped_unchanged} unmatched=${result.totals.unmatched} failed=${result.totals.failed} acked=${result.totals.acked} ack_failed=${result.totals.ack_failed}`,
      );
    }

    process.exit(result.totals.failed > 0 ? 1 : 0);
  } finally {
    if (runner instanceof CoreIpcStepRunner) {
      await runner.shutdown().catch(() => {});
    }
  }
}

async function runServeCommand(args: string[]): Promise<void> {
  let configPath = "";
  let baseDirOverride = "";
  let verbose = false;
  let jsonOutput = false;
  let supervised = true;
  let coreEntryPointOverride: string | undefined;
  let cliBaseBranch: string | undefined;
  let cliProtectedBranches: string | undefined;
  let cliAllowProtectedBranch = false;
  let pollEveryOverride: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = (): string => {
      i++;
      const value = args[i];
      if (value === undefined) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--base-dir" || arg === "-C") {
      baseDirOverride = next();
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--supervised") {
      supervised = true;
    } else if (arg === "--direct" || arg === "--no-supervised") {
      supervised = false;
    } else if (arg === "--core" || arg === "--core-entrypoint") {
      coreEntryPointOverride = next();
    } else if (arg === "--base-branch") {
      cliBaseBranch = next();
    } else if (arg === "--protected-branches") {
      cliProtectedBranches = next();
    } else if (arg === "--allow-protected-branch") {
      cliAllowProtectedBranch = true;
    } else if (arg === "--poll-every") {
      pollEveryOverride = next();
    } else if (!arg.startsWith("-") && configPath === "") {
      configPath = arg;
    } else {
      console.error(`Error: unknown option "${arg}"`);
      printHelp();
      process.exit(1);
    }
  }

  if (!configPath) {
    console.error("Error: task orchestrator config YAML path is required");
    console.error("Usage: roboppi task-orchestrator serve <config.yaml> [options]");
    process.exit(1);
  }

  if (verbose) {
    process.env.ROBOPPI_VERBOSE = "1";
  }

  if (supervised && process.env.ROBOPPI_SUPERVISED_IPC_TRANSPORT === undefined) {
    process.env.ROBOPPI_SUPERVISED_IPC_TRANSPORT = isNonInteractive() ? "socket" : "stdio";
  }

  const { config, configBaseDir } = await loadTaskOrchestratorConfig(
    configPath,
    baseDirOverride,
  );
  const runner = createTaskOrchestratorRunner({
    supervised,
    verbose,
    coreEntryPointOverride,
  });
  const abortController = new AbortController();
  const cleanupSignals = installShutdownHandlers(abortController);

  try {
    const server = new TaskOrchestratorServer(config, {
      baseDir: configBaseDir,
      stepRunner: runner,
      supervised,
      cliBaseBranch,
      cliProtectedBranches,
      cliAllowProtectedBranch,
      abortSignal: abortController.signal,
      pollEveryMs:
        pollEveryOverride !== undefined ? parseDuration(pollEveryOverride) : undefined,
      onCycle: async (result) => {
        if (jsonOutput) {
          console.log(JSON.stringify({
            type: "cycle",
            ts: Date.now(),
            result,
          }));
          return;
        }
        console.log(
          `[cycle] candidates=${result.totals.candidates} dispatched=${result.totals.dispatched} skipped_active=${result.totals.skipped_active} skipped_unchanged=${result.totals.skipped_unchanged} unmatched=${result.totals.unmatched} failed=${result.totals.failed} acked=${result.totals.acked} ack_failed=${result.totals.ack_failed}`,
        );
      },
      onBackgroundEvent: async (event) => {
        if (jsonOutput) {
          console.log(JSON.stringify({
            type: "background",
            ts: Date.now(),
            event,
          }));
          return;
        }
        if (event.type === "completed") return;
        console.error(
          `[background:${event.type}] source=${event.sourceId} task=${event.taskId}${event.runId ? ` run=${event.runId}` : ""}: ${event.message ?? ""}`.trim(),
        );
      },
    });

    if (!jsonOutput) {
      console.log(`Task Orchestrator Serve: ${config.name}`);
      console.log(`State dir: ${resolveStateDir(config, configBaseDir)}`);
      console.log(
        `Poll every: ${pollEveryOverride ?? config.runtime.poll_every}`,
      );
      if (config.runtime.max_active_instances !== undefined) {
        console.log(`Max active instances: ${config.runtime.max_active_instances}`);
      }
      console.log("Press Ctrl+C to stop.");
    }

    try {
      await server.serve();
    } catch (err) {
      // Resident shutdown can interrupt in-flight source/bridge polling. Once
      // SIGINT/SIGTERM has been requested, treat those late abort errors as a
      // normal stop instead of surfacing a cleanup-only non-zero exit.
      if (!abortController.signal.aborted) {
        throw err;
      }
    }
  } finally {
    cleanupSignals();
    if (runner instanceof CoreIpcStepRunner) {
      await runner.shutdown().catch(() => {});
    }
  }

  process.exit(0);
}

async function runStatusCommand(args: string[]): Promise<void> {
  let configPath = "";
  let baseDirOverride = "";
  let jsonOutput = false;
  let taskIdFilter: string | undefined;
  let activeOnly = false;
  let limit = 20;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = (): string => {
      i++;
      const value = args[i];
      if (value === undefined) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--json") {
      jsonOutput = true;
    } else if (arg === "--base-dir" || arg === "-C") {
      baseDirOverride = next();
    } else if (arg === "--task-id") {
      taskIdFilter = next();
    } else if (arg === "--active") {
      activeOnly = true;
    } else if (arg === "--limit") {
      const parsed = Number(next());
      if (!Number.isInteger(parsed) || parsed <= 0) {
        console.error("Error: --limit requires a positive integer");
        process.exit(1);
      }
      limit = parsed;
    } else if (!arg.startsWith("-") && configPath === "") {
      configPath = arg;
    } else {
      console.error(`Error: unknown option "${arg}"`);
      printHelp();
      process.exit(1);
    }
  }

  if (!configPath) {
    console.error("Error: task orchestrator config YAML path is required");
    console.error("Usage: roboppi task-orchestrator status <config.yaml> [options]");
    process.exit(1);
  }

  const { config, configBaseDir } = await loadTaskOrchestratorConfig(
    configPath,
    baseDirOverride,
  );
  const registry = new TaskRegistryStore(resolveStateDir(config, configBaseDir));

  let states = await registry.listTaskStates();
  if (activeOnly) {
    states = states.filter((state) => state.active_run_id !== null);
  }
  if (taskIdFilter) {
    states = states.filter((state) => state.task_id === taskIdFilter);
  }
  states = states.slice(0, limit);

  if (taskIdFilter && states.length === 0) {
    console.error(`Error: task not found: ${taskIdFilter}`);
    process.exit(1);
  }

  const tasks = await Promise.all(states.map((state) => buildTaskStatusView(registry, state)));
  if (jsonOutput) {
    console.log(JSON.stringify({
      config: {
        name: config.name,
        state_dir: registry.getStateDirectory(),
      },
      filters: {
        active: activeOnly,
        task_id: taskIdFilter,
        limit,
      },
      tasks,
    }, null, 2));
    process.exit(0);
  }

  console.log(`Task Orchestrator Status: ${config.name}`);
  console.log(`State dir: ${registry.getStateDirectory()}`);
  console.log(`Tasks: ${tasks.length}`);
  console.log("");

  if (tasks.length === 0) {
    console.log("No tasks found.");
    process.exit(0);
  }

  for (const task of tasks) {
    console.log(task.task_id);
    console.log(
      `  lifecycle=${task.lifecycle} updated_at=${task.updated_at_iso} runs=${task.run_count}${task.active_run_id ? ` active_run=${task.active_run_id}` : ""}`,
    );
    console.log(
      `  source=${task.source.kind} external_id=${task.source.external_id}${task.repository_id ? ` repository=${task.repository_id}` : ""}`,
    );
    console.log(`  title=${task.title}`);
    if (task.latest_run) {
      console.log(
        `  latest_run=${task.latest_run.run_id} status=${task.latest_run.status}${task.latest_run.workflow_status ? ` workflow_status=${task.latest_run.workflow_status}` : ""} attempt=${task.latest_run.attempt}`,
      );
    }
    if (task.latest_summary?.rationale) {
      console.log(`  rationale=${task.latest_summary.rationale}`);
    }
    if (task.latest_landing) {
      console.log(
        `  landing=${task.latest_landing.lifecycle} source=${task.latest_landing.source}`,
      );
    }
  }

  process.exit(0);
}

async function runActivityCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand !== "emit") {
    console.error(`Error: unknown task-orchestrator activity subcommand "${String(subcommand)}"`);
    printHelp();
    process.exit(1);
  }

  let contextDir = "";
  let kind = "";
  let message = "";
  let phase: string | undefined;
  let memberId: string | undefined;
  let metadataJson: string | undefined;
  let mailboxMessagePath: string | undefined;
  let jsonOutput = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    const next = (): string => {
      i++;
      const value = args[i];
      if (value === undefined) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--context") {
      contextDir = next();
    } else if (arg === "--kind") {
      kind = next();
    } else if (arg === "--message") {
      message = next();
    } else if (arg === "--phase") {
      phase = next();
    } else if (arg === "--member-id") {
      memberId = next();
    } else if (arg === "--metadata-json") {
      metadataJson = next();
    } else if (arg === "--mailbox-message") {
      mailboxMessagePath = next();
    } else if (arg === "--json") {
      jsonOutput = true;
    } else {
      console.error(`Error: unknown option "${arg}"`);
      printHelp();
      process.exit(1);
    }
  }

  if (!contextDir) {
    console.error("Error: activity emit requires --context");
    process.exit(1);
  }

  let mailboxBody: Record<string, unknown> | undefined;
  if (mailboxMessagePath) {
    mailboxBody = await readMailboxBodyObject(path.resolve(mailboxMessagePath), "activity emit");
    if (!kind) {
      kind = requiredStringProperty(mailboxBody, "kind", "activity emit mailbox body");
    }
    if (!message) {
      message = requiredStringProperty(mailboxBody, "message", "activity emit mailbox body");
    }
    if (!phase) {
      phase = optionalStringProperty(mailboxBody, "phase", "activity emit mailbox body");
    }
  }

  if (!kind || !message) {
    console.error(
      "Error: activity emit requires --kind and --message, or --mailbox-message containing kind/message",
    );
    process.exit(1);
  }

  let metadata: Record<string, unknown> | undefined;
  if (metadataJson) {
    try {
      const parsed = JSON.parse(metadataJson) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("metadata must be a JSON object");
      }
      metadata = parsed as Record<string, unknown>;
    } catch (err) {
      console.error(`Error: invalid --metadata-json: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else if (mailboxBody) {
    const fromMailbox = optionalObjectProperty(
      mailboxBody,
      "metadata",
      "activity emit mailbox body",
    );
    if (fromMailbox !== undefined) {
      metadata = fromMailbox;
    }
  }

  const event = await emitTaskActivity({
    contextDir: path.resolve(contextDir),
    kind: kind as Parameters<typeof emitTaskActivity>[0]["kind"],
    message,
    phase,
    memberId,
    metadata,
  });
  if (jsonOutput) {
    console.log(JSON.stringify(event, null, 2));
  } else {
    console.log(
      `Emitted activity: task=${event.task_id} run=${event.run_id} kind=${event.kind}`,
    );
  }
  process.exit(0);
}

async function runIntentCommand(args: string[]): Promise<void> {
  const action = args[0];
  if (action !== "emit") {
    console.error(`Error: unknown intent subcommand "${String(action)}"`);
    printHelp();
    process.exit(1);
  }

  let contextDir = "";
  let kind = "";
  let payloadJson = "";
  let payloadFile = "";
  let payloadMailboxBody = "";
  let memberId = "";
  let jsonOutput = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    const next = (): string => {
      i++;
      const value = args[i];
      if (value === undefined) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--context") {
      contextDir = next();
    } else if (arg === "--kind") {
      kind = next();
    } else if (arg === "--payload-json") {
      payloadJson = next();
    } else if (arg === "--payload-file") {
      payloadFile = next();
    } else if (arg === "--payload-mailbox-body") {
      payloadMailboxBody = next();
    } else if (arg === "--member-id") {
      memberId = next();
    } else if (arg === "--json") {
      jsonOutput = true;
    } else {
      console.error(`Error: unknown option "${arg}"`);
      printHelp();
      process.exit(1);
    }
  }

  const payloadSourceCount = Number(payloadJson !== "")
    + Number(payloadFile !== "")
    + Number(payloadMailboxBody !== "");
  if (!contextDir || !kind || !memberId || payloadSourceCount !== 1) {
    console.error(
      "Error: intent emit requires --context, --kind, --member-id, and exactly one of --payload-json, --payload-file, or --payload-mailbox-body",
    );
    process.exit(1);
  }

  let payload: Record<string, unknown>;
  try {
    if (payloadJson) {
      payload = parseJsonObject(payloadJson, "payload");
    } else if (payloadFile) {
      payload = await readJsonObjectFile(path.resolve(payloadFile), "intent payload file");
    } else {
      payload = await readMailboxBodyObject(
        path.resolve(payloadMailboxBody),
        "intent payload mailbox body",
      );
    }
  } catch (err) {
    console.error(
      `Error: invalid intent payload: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  try {
    const record = await emitTaskIntent({
      contextDir: path.resolve(contextDir),
      kind: kind as Exclude<Parameters<typeof emitTaskIntent>[0]["kind"], "activity">,
      memberId,
      payload,
    });
    if (jsonOutput) {
      console.log(JSON.stringify(record, null, 2));
    } else {
      console.log(
        `Recorded intent: task=${record.task_id} run=${record.run_id} kind=${record.kind} member=${record.member_id}`,
      );
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof TaskIntentAuthorizationError) {
      if (jsonOutput) {
        console.log(JSON.stringify(err.record, null, 2));
      } else {
        console.error(`Error: ${err.message}`);
      }
      process.exit(1);
    }
    throw err;
  }
}

async function runGitHubCommand(args: string[]): Promise<void> {
  const action = args[0];
  if (
    action !== "apply-pr-review"
    && action !== "apply-pr-open"
    && action !== "record-pr-open-request"
    && action !== "record-review-result"
  ) {
    console.error(`Error: unknown github subcommand "${String(action)}"`);
    printHelp();
    process.exit(1);
  }

  let contextDir = "";
  let mailboxPath: string | undefined;
  let memberId: string | undefined;
  let mergeStrategy = "squash";
  let jsonOutput = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    const next = (): string => {
      i++;
      const value = args[i];
      if (value === undefined) {
        console.error(`Error: ${arg} requires a value`);
        process.exit(1);
      }
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--context") {
      contextDir = next();
    } else if (arg === "--mailbox-path") {
      mailboxPath = next();
    } else if (arg === "--member-id") {
      memberId = next();
    } else if (arg === "--merge-strategy") {
      mergeStrategy = next();
    } else if (arg === "--json") {
      jsonOutput = true;
    } else {
      console.error(`Error: unknown option "${arg}"`);
      printHelp();
      process.exit(1);
    }
  }

  if (!contextDir) {
    console.error(`Error: github ${action} requires --context`);
    process.exit(1);
  }

  const resolvedContextDir = path.resolve(contextDir);
  const result =
    action === "apply-pr-open"
      ? await applyGitHubPullRequestOpen({
          contextDir: resolvedContextDir,
        })
      : action === "apply-pr-review"
        ? await applyGitHubPullRequestActuation({
            contextDir: resolvedContextDir,
          })
        : action === "record-pr-open-request"
          ? await recordGitHubPullRequestOpenRequest({
              contextDir: resolvedContextDir,
              mailboxPath,
              memberId,
            })
          : await recordGitHubReviewResult({
              contextDir: resolvedContextDir,
              mailboxPath,
              memberId,
              mergeStrategy,
            });
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (action === "apply-pr-open") {
      const openResult = result as Awaited<ReturnType<typeof applyGitHubPullRequestOpen>>;
      console.log(
        `Applied GitHub PR open: task=${openResult.task_id} issue=${openResult.issue.repository}#${openResult.issue.number} pr=${openResult.pull_request.repository}#${openResult.pull_request.number}`,
      );
    } else if (action === "record-pr-open-request") {
      const record = result as Awaited<ReturnType<typeof recordGitHubPullRequestOpenRequest>>;
      console.log(
        `Recorded GitHub PR-open request: task=${record.task_id} run=${record.run_id} head=${record.payload.head_ref ?? "-"}`,
      );
    } else if (action === "record-review-result") {
      const record = result as Awaited<ReturnType<typeof recordGitHubReviewResult>>;
      console.log(
        `Recorded GitHub review result: task=${record.task_id} run=${record.run_id} decision=${record.decision}`,
      );
    } else {
      const reviewResult = result as Awaited<ReturnType<typeof applyGitHubPullRequestActuation>>;
      console.log(
        `Applied GitHub PR actuation: task=${reviewResult.task_id} pr=${reviewResult.pull_request.repository}#${reviewResult.pull_request.number} decision=${reviewResult.decision} merged=${reviewResult.merged}`,
      );
    }
  }
  process.exit(0);
}

async function loadTaskOrchestratorConfig(
  configPath: string,
  baseDirOverride: string,
): Promise<{
  config: TaskOrchestratorConfig;
  resolvedConfigPath: string;
  configBaseDir: string;
}> {
  const resolvedConfigPath = path.resolve(configPath);
  const configBaseDir = baseDirOverride
    ? path.resolve(baseDirOverride)
    : path.dirname(resolvedConfigPath);
  const yamlContent = await readFile(resolvedConfigPath, "utf-8");
  const config = parseTaskOrchestratorConfig(yamlContent);
  return {
    config,
    resolvedConfigPath,
    configBaseDir,
  };
}

function resolveStateDir(config: TaskOrchestratorConfig, baseDir: string): string {
  return path.isAbsolute(config.state_dir)
    ? config.state_dir
    : path.resolve(baseDir, config.state_dir);
}

function createTaskOrchestratorRunner(args: {
  supervised: boolean;
  verbose: boolean;
  coreEntryPointOverride?: string;
}): CoreIpcStepRunner | MultiWorkerStepRunner {
  return args.supervised
    ? new CoreIpcStepRunner({
        verbose: args.verbose,
        coreEntryPoint: resolveCoreEntryPointForSupervised(args.coreEntryPointOverride),
      })
    : new MultiWorkerStepRunner(args.verbose);
}

function parseJsonObject(
  input: string,
  label: string,
): Record<string, unknown> {
  const parsed = JSON.parse(input) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function readJsonObjectFile(
  filePath: string,
  label: string,
): Promise<Record<string, unknown>> {
  const text = await readFile(filePath, "utf-8");
  return parseJsonObject(text, label);
}

async function readMailboxBodyObject(
  filePath: string,
  label: string,
): Promise<Record<string, unknown>> {
  const doc = parseJsonObject(await readFile(filePath, "utf-8"), `${label} mailbox message`);
  const body = doc["body"];
  if (typeof body !== "string" || body.trim() === "") {
    throw new Error(`${label} mailbox message must contain a non-empty string body`);
  }
  return parseJsonObject(body, `${label} mailbox body`);
}

function resolveMailboxPath(
  contextDir: string,
  mailboxPath: string,
): string {
  return path.isAbsolute(mailboxPath)
    ? mailboxPath
    : path.join(contextDir, mailboxPath);
}

interface InboxSummaryDoc {
  entries?: Array<{
    topic?: unknown;
    mailbox_path?: unknown;
  }>;
}

async function recordGitHubPullRequestOpenRequest(args: {
  contextDir: string;
  mailboxPath?: string;
  memberId?: string;
}): Promise<{
  task_id: string;
  run_id: string;
  mailbox_path: string;
  payload: TaskPullRequestOpenRequest;
}> {
  if (!args.memberId || args.memberId.trim() === "") {
    console.error("Error: github record-pr-open-request requires --member-id");
    process.exit(1);
  }

  const mailboxPath = args.mailboxPath
    ? resolveMailboxPath(args.contextDir, args.mailboxPath)
    : await findLatestReviewRequiredMailboxPath(args.contextDir);
  const payload = await readMailboxBodyObject(mailboxPath, "github record-pr-open-request");
  const record = await emitTaskIntent({
    contextDir: args.contextDir,
    kind: "pr_open_request",
    memberId: args.memberId,
    payload,
  });
  const request = JSON.parse(
    await readFile(path.join(args.contextDir, "_task", "pr-open-request.json"), "utf-8"),
  ) as TaskPullRequestOpenRequest;
  return {
    task_id: record.task_id,
    run_id: record.run_id,
    mailbox_path: mailboxPath,
    payload: request,
  };
}

async function findLatestReviewRequiredMailboxPath(contextDir: string): Promise<string> {
  const inboxSummaryPath = path.join(contextDir, "_agents", "inbox-summary.json");
  const inboxSummary = JSON.parse(
    await readFile(inboxSummaryPath, "utf-8"),
  ) as InboxSummaryDoc;
  const entries = Array.isArray(inboxSummary.entries) ? inboxSummary.entries : [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.topic !== "implementation_milestone") continue;
    if (typeof entry.mailbox_path !== "string" || entry.mailbox_path.trim() === "") continue;
    const mailboxPath = resolveMailboxPath(contextDir, entry.mailbox_path);
    const body = await readMailboxBodyObject(
      mailboxPath,
      "github record-pr-open-request mailbox candidate",
    ).catch(() => null);
    if (body?.["kind"] === "review_required") {
      return mailboxPath;
    }
  }

  throw new Error(
    `No review_required implementation_milestone mailbox message found in ${inboxSummaryPath}`,
  );
}

type ReviewDecision = "approve" | "changes_requested";

async function recordGitHubReviewResult(args: {
  contextDir: string;
  mailboxPath?: string;
  memberId?: string;
  mergeStrategy: string;
}): Promise<{
  task_id: string;
  run_id: string;
  mailbox_path: string;
  decision: ReviewDecision;
  review_verdict: Record<string, unknown>;
  merge_request?: Record<string, unknown>;
}> {
  if (!args.memberId || args.memberId.trim() === "") {
    console.error("Error: github record-review-result requires --member-id");
    process.exit(1);
  }

  const mailboxPath = args.mailboxPath
    ? resolveMailboxPath(args.contextDir, args.mailboxPath)
    : await findLatestReviewResultMailboxPath(args.contextDir);
  const reviewResult = await readMailboxBodyObject(mailboxPath, "github record-review-result");
  const decision = requiredStringProperty(
    reviewResult,
    "decision",
    "github record-review-result mailbox body",
  );
  if (decision !== "approve" && decision !== "changes_requested") {
    throw new Error(
      `github record-review-result mailbox body.decision must be approve or changes_requested`,
    );
  }
  const rationale = requiredStringProperty(
    reviewResult,
    "message",
    "github record-review-result mailbox body",
  );

  const reviewVerdictRecord = await emitTaskIntent({
    contextDir: args.contextDir,
    kind: "review_verdict",
    memberId: args.memberId,
    payload: {
      decision,
      rationale,
    },
  });

  let mergeRequestRecord: Awaited<ReturnType<typeof emitTaskIntent>> | undefined;
  if (decision === "approve") {
    mergeRequestRecord = await emitTaskIntent({
      contextDir: args.contextDir,
      kind: "merge_request",
      memberId: args.memberId,
      payload: {
        strategy: args.mergeStrategy,
        rationale,
      },
    });
  }

  return {
    task_id: reviewVerdictRecord.task_id,
    run_id: reviewVerdictRecord.run_id,
    mailbox_path: mailboxPath,
    decision,
    review_verdict: reviewVerdictRecord.payload,
    merge_request: mergeRequestRecord?.payload,
  };
}

async function findLatestReviewResultMailboxPath(contextDir: string): Promise<string> {
  const inboxSummaryPath = path.join(contextDir, "_agents", "inbox-summary.json");
  const inboxSummary = JSON.parse(
    await readFile(inboxSummaryPath, "utf-8"),
  ) as InboxSummaryDoc;
  const entries = Array.isArray(inboxSummary.entries) ? inboxSummary.entries : [];

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.topic !== "review_result") continue;
    if (typeof entry.mailbox_path !== "string" || entry.mailbox_path.trim() === "") continue;
    return resolveMailboxPath(contextDir, entry.mailbox_path);
  }

  throw new Error(
    `No review_result mailbox message found in ${inboxSummaryPath}`,
  );
}

function requiredStringProperty(
  doc: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = doc[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalStringProperty(
  doc: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = doc[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label}.${key} must be a string`);
  }
  return value;
}

function optionalObjectProperty(
  doc: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, unknown> | undefined {
  const value = doc[key];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}.${key} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function installShutdownHandlers(abortController: AbortController): () => void {
  const onSignal = () => {
    abortController.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

async function buildTaskStatusView(
  registry: TaskRegistryStore,
  state: TaskRecordState,
): Promise<{
  task_id: string;
  lifecycle: string;
  updated_at: number;
  updated_at_iso: string;
  last_transition_at: number;
  active_run_id: string | null;
  latest_run_id: string | null;
  run_count: number;
  title: string;
  requested_action: string;
  requested_by?: string;
  repository_id?: string;
  source: TaskEnvelope["source"];
  latest_run?: TaskRunRecord;
  latest_summary?: TaskRunSummary | null;
  latest_landing?: TaskLandingDecision | null;
}> {
  const envelope = await registry.getEnvelope(state.task_id);
  if (!envelope) {
    throw new Error(`Task envelope not found for "${state.task_id}"`);
  }

  const latestRun = state.latest_run_id
    ? await registry.getRun(state.task_id, state.latest_run_id)
    : null;
  const latestSummary = state.latest_run_id
    ? await registry.getRunSummary(state.task_id, state.latest_run_id)
    : null;
  const latestLanding = state.latest_run_id
    ? await registry.getLandingDecision(state.task_id, state.latest_run_id)
    : null;

  return {
    task_id: state.task_id,
    lifecycle: state.lifecycle,
    updated_at: state.updated_at,
    updated_at_iso: new Date(state.updated_at).toISOString(),
    last_transition_at: state.last_transition_at,
    active_run_id: state.active_run_id,
    latest_run_id: state.latest_run_id,
    run_count: state.run_count,
    title: envelope.title,
    requested_action: envelope.requested_action,
    requested_by: envelope.requested_by,
    repository_id: envelope.repository?.id,
    source: envelope.source,
    latest_run: latestRun ?? undefined,
    latest_summary: latestSummary,
    latest_landing: latestLanding,
  };
}

function printHelp(): void {
  console.log(`Usage:
  roboppi task-orchestrator run <config.yaml> [options]
  roboppi task-orchestrator serve <config.yaml> [options]
  roboppi task-orchestrator status <config.yaml> [options]
  roboppi task-orchestrator activity emit --context <dir> --kind <kind> --message <text> [options]
  roboppi task-orchestrator intent emit --context <dir> --kind <kind> --payload-json <obj> --member-id <id> [options]
  roboppi task-orchestrator github record-pr-open-request --context <dir> --member-id <id> [--mailbox-path <path>] [options]
  roboppi task-orchestrator github record-review-result --context <dir> --member-id <id> [--mailbox-path <path>] [--merge-strategy <name>] [options]
  roboppi task-orchestrator github apply-pr-open --context <dir> [options]
  roboppi task-orchestrator github apply-pr-review --context <dir> [options]
  (dev) bun run src/task-orchestrator/cli.ts run <config.yaml> [options]
  (dev) bun run src/task-orchestrator/cli.ts serve <config.yaml> [options]
  (dev) bun run src/task-orchestrator/cli.ts status <config.yaml> [options]

Options:
  --base-dir, -C <dir>  Override base directory for config-relative paths
  --json                Emit a machine-readable JSON summary to stdout
  --verbose, -v         Enable verbose logging
  --supervised          Supervised mode (default): run workflows via Core IPC
  --direct              Opt out of Core IPC and spawn worker CLIs directly
  --no-supervised       Alias for --direct
  --core <path|cmd>     Core entrypoint for supervised mode (default: auto)
  --base-branch <name>  Override branch base resolution for task workflows
  --protected-branches <csv>
                        Override protected branch patterns
  --allow-protected-branch
                        Disable protected branch guard
  --poll-every <dur>    (serve) Override poll interval
  --task-id <id>        (status) Show only one task
  --active              (status) Show only active tasks
  --limit <n>           (status) Max tasks to show (default: 20)
  --context <dir>       (activity emit) Task context dir
  --kind <kind>         (activity emit) progress|blocker|waiting_for_input|review_required|ready_to_land|landed|commit_created|push_completed
  --message <text>      (activity emit) Human-readable activity message
  --phase <name>        (activity emit) Optional phase label
  --member-id <id>      (activity emit) Optional member id
  --metadata-json <obj> (activity emit) Optional metadata JSON object
  --mailbox-message <path>
                       (activity emit) Read kind/message/phase/metadata from mailbox JSON body
  --payload-json <obj>  (intent emit) Intent payload JSON object
  --payload-file <path> (intent emit) Read intent payload JSON object from file
  --payload-mailbox-body <path>
                       (intent emit) Read intent payload JSON object from mailbox JSON body
  --member-id <id>      (intent emit) Emitting member id
  --kind <kind>         (intent emit) review_verdict|landing_decision|clarification_request|pr_open_request|merge_request|external_publish
  --context <dir>       (github subcommands) Task context dir
  --mailbox-path <path> (github record-pr-open-request) Mailbox JSON path; if relative, resolved from task context
  --member-id <id>      (github record-* helpers) Emitting member id
  --merge-strategy <name>
                       (github record-review-result) Merge strategy to record on approval (default: squash)
  --help, -h            Show help`);
}

if (import.meta.main) {
  runTaskOrchestratorCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
