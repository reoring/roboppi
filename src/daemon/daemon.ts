import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DaemonConfig, DaemonEvent, TriggerDef } from "./types.js";
import type { WorkflowState } from "../workflow/types.js";
import { DaemonStateStore } from "./state-store.js";
import { TriggerEngine, WorkflowQueuedError } from "./trigger-engine.js";
import { EvaluateGate } from "./evaluate-gate.js";
import { ResultAnalyzer } from "./result-analyzer.js";
import { CronSource } from "./events/cron-source.js";
import { IntervalSource } from "./events/interval-source.js";
import { FSWatchSource } from "./events/fswatch-source.js";
import { WebhookServer } from "./events/webhook-server.js";
import { WebhookSource } from "./events/webhook-source.js";
import { CommandSource } from "./events/command-source.js";
import { mergeEventSources } from "./events/event-source.js";
import type { EventSource } from "./events/event-source.js";
import { parseWorkflow } from "../workflow/parser.js";
import { parseAgentCatalog, type AgentCatalog } from "../workflow/agent-catalog.js";
import type { StepRunner } from "../workflow/executor.js";
import { WorkflowExecutor } from "../workflow/executor.js";
import { MultiWorkerStepRunner } from "../workflow/multi-worker-step-runner.js";
import { CoreIpcStepRunner } from "../workflow/core-ipc-step-runner.js";
import { ContextManager } from "../workflow/context-manager.js";
import { Logger } from "../core/observability.js";
import {
  resolveBranchRuntimeContext,
  type BranchRuntimeContext,
} from "../workflow/branch-context.js";

export interface DaemonOptions {
  supervised?: boolean;
  /** Path to Core entrypoint for supervised mode (default: src/index.ts). */
  coreEntryPoint?: string;
}

function splitPathList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(":")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface QueuedItem {
  triggerId: string;
  trigger: TriggerDef;
  event: DaemonEvent;
}

export class Daemon {
  private readonly config: DaemonConfig;
  private readonly stateStore: DaemonStateStore;
  private readonly evaluateGate: EvaluateGate;
  private readonly resultAnalyzer: ResultAnalyzer;
  private readonly eventSources: EventSource[] = [];
  private triggerEngine: TriggerEngine | null = null;
  private webhookServer: WebhookServer | null = null;

  private readonly logger: Logger;
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  private readonly supervised: boolean;
  private readonly coreEntryPoint: string;

  private readonly shutdownAbortController = new AbortController();
  private stepRunner: StepRunner | null = null;
  private coreRunner: CoreIpcStepRunner | null = null;
  private shutdownRequested = false;
  private runningWorkflows = 0;
  private readonly maxConcurrent: number;
  private readonly workflowQueue: QueuedItem[] = [];
  private readonly defaultMaxQueue: number = 10;
  private workflowDoneResolve: (() => void) | null = null;
  private startedAt: number = 0;

  constructor(config: DaemonConfig, logger?: Logger, options: DaemonOptions = {}) {
    this.config = config;
    this.logger = logger ?? new Logger("daemon");
    this.workspaceDir = path.resolve(config.workspace);
    this.stateDir = config.state_dir
      ? (path.isAbsolute(config.state_dir) ? config.state_dir : path.resolve(this.workspaceDir, config.state_dir))
      : path.join(this.workspaceDir, ".daemon-state");
    this.stateStore = new DaemonStateStore(this.stateDir);
    this.evaluateGate = new EvaluateGate();
    this.resultAnalyzer = new ResultAnalyzer();
    this.maxConcurrent = config.max_concurrent_workflows ?? 5;

    this.supervised = options.supervised ?? false;
    const defaultCoreEntryPoint = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "index.ts",
    );
    this.coreEntryPoint = options.coreEntryPoint ?? defaultCoreEntryPoint;
  }

  async start(): Promise<void> {
    // 1. Ensure workspace and state dirs exist
    await mkdir(this.workspaceDir, { recursive: true });
    await mkdir(this.stateDir, { recursive: true });

    // 2. Save daemon state
    this.startedAt = Date.now();
    await this.stateStore.saveDaemonState({
      pid: process.pid,
      startedAt: this.startedAt,
      configName: this.config.name,
      status: "running",
    });

    // 3. Create event sources
    for (const [eventId, eventDef] of Object.entries(this.config.events)) {
      switch (eventDef.type) {
        case "cron":
          this.eventSources.push(new CronSource(eventId, eventDef.schedule));
          break;
        case "interval":
          this.eventSources.push(new IntervalSource(eventId, eventDef.every));
          break;
        case "fswatch":
          this.eventSources.push(new FSWatchSource(eventId, eventDef, 200, this.workspaceDir));
          break;
        case "webhook":
          if (!this.webhookServer) {
            this.webhookServer = new WebhookServer();
          }
          this.eventSources.push(new WebhookSource(eventId, eventDef, this.webhookServer));
          break;
        case "command":
          this.eventSources.push(new CommandSource(eventId, eventDef, this.workspaceDir));
          break;
        default:
          this.logger.warn(`Event type not yet supported, skipping`, { eventId });
          break;
      }
    }

    // Start webhook server if any webhook event sources were created
    if (this.webhookServer) {
      const firstWebhookDef = Object.values(this.config.events).find(
        (e) => e.type === "webhook",
      ) as import("./types.js").WebhookEventDef | undefined;
      const webhookPort = firstWebhookDef?.port ?? 8080;
      this.webhookServer.start(webhookPort);
      this.logger.info(`Webhook server started`, { port: webhookPort });
    }

    if (this.eventSources.length === 0) {
      this.logger.warn("No supported event sources found, exiting");
      return;
    }

    // 4. Create trigger engine
    this.triggerEngine = new TriggerEngine(
      this.config,
      this.stateStore,
      (triggerId, trigger, event) =>
        this.scheduleWorkflow(triggerId, trigger, event),
    );

    // 5. Set up signal handlers
    const onShutdown = () => {
      void this.stop();
    };
    process.on("SIGTERM", onShutdown);
    process.on("SIGINT", onShutdown);

    // 6. Merge event sources and run event loop
    const merged = mergeEventSources(this.eventSources);

    // 6b. Initialize step runner
    const verbose = process.env.AGENTCORE_VERBOSE === "1";
    if (this.supervised) {
      this.coreRunner = new CoreIpcStepRunner({
        verbose,
        coreEntryPoint: this.coreEntryPoint,
      });
      this.stepRunner = this.coreRunner;
      this.logger.info("Supervised mode enabled", { coreEntryPoint: this.coreEntryPoint });
    } else {
      this.stepRunner = new MultiWorkerStepRunner(verbose);
    }

    this.logger.info("Event loop started, waiting for events...");

    try {
      try {
        for await (const event of merged) {
          if (this.shutdownRequested) break;

          try {
            this.logger.debug("Event received", { sourceId: event.sourceId, type: event.payload.type });

            const actions = await this.triggerEngine.handleEvent(event);
            for (const action of actions) {
              if (action.action === "executed") {
                this.logger.info("Workflow completed", { status: action.result.status });
              } else if (action.action === "queued") {
                this.logger.info("Workflow queued", { triggerId: action.triggerId, queueSize: this.workflowQueue.length });
              } else {
                this.logger.debug("Trigger action", { action: action.action });
              }
            }
          } catch (err) {
            this.logger.error("Error handling event", { sourceId: event.sourceId, error: err instanceof Error ? err.message : String(err) });
            continue;
          }
        }
      } catch (err) {
        if (!this.shutdownRequested) {
          this.logger.error("Event loop error", { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // 7. Update daemon state
      await this.stateStore.saveDaemonState({
        pid: process.pid,
        startedAt: this.startedAt,
        configName: this.config.name,
        status: "stopped",
      });
    } finally {
      // Ensure Core is shut down in supervised mode.
      if (this.coreRunner) {
        try {
          await this.coreRunner.shutdown();
        } catch {
          // best-effort
        }
        this.coreRunner = null;
        this.stepRunner = null;
      }
    }
  }

  async stop(): Promise<void> {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;

    // Abort running workflows/evaluate/analyze ASAP.
    this.shutdownAbortController.abort();

    // Prevent any queued workflows from starting.
    this.workflowQueue.length = 0;

    this.logger.info("Shutting down...");

    // Stop all event sources
    await Promise.all(this.eventSources.map((s) => s.stop()));

    // Stop webhook server
    if (this.webhookServer) {
      this.webhookServer.stop();
    }

    // Wait for running workflows to complete (with timeout)
    if (this.runningWorkflows > 0) {
      this.logger.info("Waiting for running workflows", { count: this.runningWorkflows });
      const timeout = 30_000;
      await Promise.race([
        new Promise<void>((resolve) => {
          this.workflowDoneResolve = resolve;
        }),
        new Promise<void>((resolve) => setTimeout(resolve, timeout)),
      ]);
    }

    // Shut down Core (supervised mode) after workflows have stopped.
    if (this.coreRunner) {
      try {
        await this.coreRunner.shutdown();
      } catch {
        // best-effort
      }
      this.coreRunner = null;
      this.stepRunner = null;
    }

    // Update daemon state
    await this.stateStore.saveDaemonState({
      pid: process.pid,
      startedAt: this.startedAt,
      configName: this.config.name,
      status: "stopped",
    });

    this.logger.info("Stopped.");
  }

  /**
   * Called by TriggerEngine as the onExecute callback.
   * If under capacity, executes immediately. If at capacity, enqueues
   * and throws WorkflowQueuedError so the trigger engine skips state updates.
   */
  private async scheduleWorkflow(
    triggerId: string,
    trigger: TriggerDef,
    event: DaemonEvent,
  ): Promise<WorkflowState> {
    if (this.shutdownRequested) {
      const { WorkflowStatus } = await import("../workflow/types.js");
      return {
        workflowId: `${triggerId}-cancelled-${Date.now()}`,
        name: trigger.workflow,
        status: WorkflowStatus.CANCELLED,
        steps: {},
        startedAt: Date.now(),
        completedAt: Date.now(),
      };
    }

    if (this.runningWorkflows >= this.maxConcurrent) {
      this.enqueueWorkflow(triggerId, trigger, event);
      throw new WorkflowQueuedError();
    }
    return this.executeWorkflow(triggerId, trigger, event);
  }

  private enqueueWorkflow(
    triggerId: string,
    trigger: TriggerDef,
    event: DaemonEvent,
  ): void {
    const maxQueue = trigger.max_queue ?? this.defaultMaxQueue;

    // Count items in queue for this specific trigger
    const triggerQueueCount = this.workflowQueue.filter(
      (item) => item.triggerId === triggerId,
    ).length;

    if (triggerQueueCount >= maxQueue) {
      // Drop oldest item for this trigger to make room
      const oldestIdx = this.workflowQueue.findIndex(
        (item) => item.triggerId === triggerId,
      );
      if (oldestIdx !== -1) {
        this.workflowQueue.splice(oldestIdx, 1);
        this.logger.warn("Queue full, dropping oldest item", {
          triggerId,
          maxQueue,
        });
      }
    }

    this.workflowQueue.push({ triggerId, trigger, event });
  }

  /** Dequeue and execute next queued workflow if capacity allows. */
  private drainQueue(): void {
    if (this.shutdownRequested) return;
    while (
      this.workflowQueue.length > 0 &&
      this.runningWorkflows < this.maxConcurrent
    ) {
      const item = this.workflowQueue.shift()!;
      // Fire-and-forget: executeWorkflow manages runningWorkflows count
      // and will call drainQueue again in its finally block
      void this.executeWorkflow(item.triggerId, item.trigger, item.event).catch(
        (err) => {
          this.logger.error("Dequeued workflow execution failed", {
            triggerId: item.triggerId,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
      // Only start one at a time; executeWorkflow's finally block will
      // call drainQueue again when it completes
      break;
    }
  }

  /** Returns current queue depth (for testing/metrics). */
  get queueSize(): number {
    return this.workflowQueue.length;
  }

  private async executeWorkflow(
    triggerId: string,
    trigger: TriggerDef,
    event: DaemonEvent,
  ): Promise<WorkflowState> {
    if (!this.stepRunner) {
      throw new Error("Daemon step runner not initialized");
    }

    this.runningWorkflows++;
    // Sanitize triggerId to prevent path traversal in file-based state storage
    const safeTriggerId = triggerId.replace(/[\/\\\.]/g, '_');

    try {
      const workspaceDir = this.workspaceDir;

      // 1. Run evaluate gate if defined
      if (trigger.evaluate) {
        const lastResult = await this.stateStore.getLastResult(safeTriggerId);
        const triggerState = await this.stateStore.getTriggerState(safeTriggerId);
        const shouldRun = await this.evaluateGate.shouldRun(
          trigger.evaluate,
          event,
          lastResult,
          workspaceDir,
          safeTriggerId,
          triggerState.executionCount,
          this.supervised ? this.stepRunner : undefined,
          this.shutdownAbortController.signal,
        );
        if (!shouldRun) {
          const { WorkflowStatus } = await import("../workflow/types.js");
          return {
            workflowId: `${safeTriggerId}-skipped-${Date.now()}`,
            name: trigger.workflow,
            status: WorkflowStatus.CANCELLED,
            steps: {},
            startedAt: Date.now(),
            completedAt: Date.now(),
          };
        }
      }

      // 1b. Context injection — build env to pass to executor (not process.env)
      const workflowEnv: Record<string, string> =
        trigger.context?.env ? { ...trigger.context.env } : {};

      const daemonContextDir = path.join(workspaceDir, ".daemon-context");
      await mkdir(daemonContextDir, { recursive: true });

      if (trigger.context?.last_result) {
        const lastResultForCtx = await this.stateStore.getLastResult(safeTriggerId);
        await writeFile(
          path.join(daemonContextDir, "last-result.json"),
          JSON.stringify(lastResultForCtx, null, 2),
        );
      }

      if (trigger.context?.event_payload) {
        await writeFile(
          path.join(daemonContextDir, "event.json"),
          JSON.stringify(event.payload, null, 2),
        );
      }

      // 2. Read and parse the workflow YAML
      const workflowPath = path.resolve(workspaceDir, trigger.workflow);
      const yamlContent = await readFile(workflowPath, "utf-8");
      const agentCatalog = await this.loadAgentCatalogForWorkflow(workflowPath, workflowEnv);
      const definition = parseWorkflow(yamlContent, { agents: agentCatalog });

        const branchContext = await resolveBranchRuntimeContext({
          workspaceDir,
          envBaseBranch: workflowEnv.BASE_BRANCH ?? process.env.BASE_BRANCH,
          envProtectedBranches:
          workflowEnv.ROBOPPI_PROTECTED_BRANCHES ??
          workflowEnv.AGENTCORE_PROTECTED_BRANCHES ??
          process.env.ROBOPPI_PROTECTED_BRANCHES ??
          process.env.AGENTCORE_PROTECTED_BRANCHES,
          envAllowProtectedBranch:
          workflowEnv.ROBOPPI_ALLOW_PROTECTED_BRANCH ??
          workflowEnv.AGENTCORE_ALLOW_PROTECTED_BRANCH ??
          process.env.ROBOPPI_ALLOW_PROTECTED_BRANCH ??
          process.env.AGENTCORE_ALLOW_PROTECTED_BRANCH,
          createBranch: definition.create_branch ?? false,
          expectedWorkBranch: definition.expected_work_branch,
          branchTransitionStep: definition.branch_transition_step,
          stepIds: Object.keys(definition.steps),
        });
      this.logBranchContext(safeTriggerId, branchContext);

      workflowEnv.AGENTCORE_CREATE_BRANCH = branchContext.createBranch ? "1" : "0";
      workflowEnv.ROBOPPI_CREATE_BRANCH = workflowEnv.AGENTCORE_CREATE_BRANCH;
      workflowEnv.AGENTCORE_PROTECTED_BRANCHES = branchContext.protectedBranches.join(",");
      workflowEnv.ROBOPPI_PROTECTED_BRANCHES = workflowEnv.AGENTCORE_PROTECTED_BRANCHES;
      workflowEnv.AGENTCORE_ALLOW_PROTECTED_BRANCH = branchContext.allowProtectedBranch
        ? "1"
        : "0";
      workflowEnv.ROBOPPI_ALLOW_PROTECTED_BRANCH = workflowEnv.AGENTCORE_ALLOW_PROTECTED_BRANCH;
      if (branchContext.effectiveBaseBranch) {
        workflowEnv.BASE_BRANCH = branchContext.effectiveBaseBranch;
        workflowEnv.AGENTCORE_EFFECTIVE_BASE_BRANCH = branchContext.effectiveBaseBranch;
        workflowEnv.ROBOPPI_EFFECTIVE_BASE_BRANCH = branchContext.effectiveBaseBranch;
      }
      if (branchContext.effectiveBaseBranchSource) {
        workflowEnv.AGENTCORE_EFFECTIVE_BASE_BRANCH_SOURCE =
          branchContext.effectiveBaseBranchSource;
        workflowEnv.ROBOPPI_EFFECTIVE_BASE_BRANCH_SOURCE =
          branchContext.effectiveBaseBranchSource;
      }
      if (branchContext.effectiveBaseSha) {
        workflowEnv.AGENTCORE_EFFECTIVE_BASE_SHA = branchContext.effectiveBaseSha;
        workflowEnv.ROBOPPI_EFFECTIVE_BASE_SHA = branchContext.effectiveBaseSha;
      }
      if (branchContext.startupBranch) {
        workflowEnv.AGENTCORE_STARTUP_BRANCH = branchContext.startupBranch;
        workflowEnv.ROBOPPI_STARTUP_BRANCH = branchContext.startupBranch;
      }
      if (branchContext.startupHeadSha) {
        workflowEnv.AGENTCORE_STARTUP_HEAD_SHA = branchContext.startupHeadSha;
        workflowEnv.ROBOPPI_STARTUP_HEAD_SHA = branchContext.startupHeadSha;
      }
      if (branchContext.startupToplevel) {
        workflowEnv.AGENTCORE_STARTUP_TOPLEVEL = branchContext.startupToplevel;
        workflowEnv.ROBOPPI_STARTUP_TOPLEVEL = branchContext.startupToplevel;
      }
      if (branchContext.expectedWorkBranch) {
        workflowEnv.AGENTCORE_EXPECTED_WORK_BRANCH = branchContext.expectedWorkBranch;
        workflowEnv.ROBOPPI_EXPECTED_WORK_BRANCH = branchContext.expectedWorkBranch;
      }
      if (branchContext.expectedCurrentBranch) {
        workflowEnv.AGENTCORE_EXPECTED_CURRENT_BRANCH = branchContext.expectedCurrentBranch;
        workflowEnv.ROBOPPI_EXPECTED_CURRENT_BRANCH = branchContext.expectedCurrentBranch;
      }
      const executorEnv =
        Object.keys(workflowEnv).length > 0 ? workflowEnv : undefined;

      // 3. Setup context dir
      const contextDir = path.join(workspaceDir, "context", safeTriggerId);
      await mkdir(contextDir, { recursive: true });

      // 4. Create executor and run
      const ctx = new ContextManager(contextDir);
      const executor = new WorkflowExecutor(
        definition,
        ctx,
        this.stepRunner,
        workspaceDir,
        executorEnv,
        this.shutdownAbortController.signal,
        branchContext,
      );
      const result = await executor.execute();

      // 5. Run result analyzer if defined
      if (trigger.analyze) {
        const triggerState = await this.stateStore.getTriggerState(safeTriggerId);
        const analyzeOutput = await this.resultAnalyzer.analyze(
          trigger.analyze,
          result,
          contextDir,
          workspaceDir,
          safeTriggerId,
          triggerState.executionCount,
          this.supervised ? this.stepRunner : undefined,
          this.shutdownAbortController.signal,
        );
        if (analyzeOutput) {
          this.logger.info("Analysis result", { triggerId: safeTriggerId, output: analyzeOutput });
        }
      }

      return result;
    } finally {
      this.runningWorkflows--;

      // Drain queued workflows now that we have capacity
      this.drainQueue();

      if (this.runningWorkflows <= 0 && this.workflowQueue.length === 0 && this.workflowDoneResolve) {
        this.workflowDoneResolve();
        this.workflowDoneResolve = null;
      }
    }
  }

  private async loadAgentCatalogForWorkflow(
    workflowPath: string,
    workflowEnv: Record<string, string>,
  ): Promise<AgentCatalog | undefined> {
    const fromProcessEnv = splitPathList(
      process.env.ROBOPPI_AGENTS_FILE ?? process.env.AGENTCORE_AGENTS_FILE,
    );
    const fromConfig = this.config.agents_file ? [this.config.agents_file] : [];
    const fromWorkflowEnv = splitPathList(
      workflowEnv.ROBOPPI_AGENTS_FILE ?? workflowEnv.AGENTCORE_AGENTS_FILE,
    );

    // Precedence: process env (lowest) -> daemon config -> trigger env (highest).
    const explicit = [...fromProcessEnv, ...fromConfig, ...fromWorkflowEnv];

    const resolveFromWorkspace = (p: string): string =>
      path.isAbsolute(p) ? p : path.resolve(this.workspaceDir, p);

    const candidates: string[] = [];
    if (explicit.length > 0) {
      candidates.push(...explicit.map(resolveFromWorkspace));
    } else {
      const dir = path.dirname(workflowPath);
      candidates.push(path.join(dir, "agents.yaml"));
      candidates.push(path.join(dir, "agents.yml"));
    }

    let catalog: AgentCatalog | undefined;
    for (const p of candidates) {
      try {
        const content = await readFile(p, "utf-8");
        const parsed = parseAgentCatalog(content);
        catalog = { ...(catalog ?? {}), ...parsed };
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

  private logBranchContext(triggerId: string, context: BranchRuntimeContext): void {
    if (!context.enabled) {
      for (const warning of context.warnings) {
        if (warning.includes("not a git repository")) {
          this.logger.debug("Branch lock disabled", { triggerId, warning });
        } else {
          this.logger.warn("Branch lock warning", { triggerId, warning });
        }
      }
      return;
    }

    this.logger.info("Branch lock resolved", {
      triggerId,
      startup_branch: context.startupBranch,
      startup_head_sha: context.startupHeadSha,
      startup_toplevel: context.startupToplevel,
      effective_base_branch: context.effectiveBaseBranch,
      effective_base_branch_source: context.effectiveBaseBranchSource,
      effective_base_sha: context.effectiveBaseSha,
      create_branch: context.createBranch,
      expected_work_branch: context.expectedWorkBranch,
      protected_branches: context.protectedBranches,
      protected_branches_source: context.protectedBranchesSource,
      allow_protected_branch: context.allowProtectedBranch,
    });

    for (const warning of context.warnings) {
      this.logger.warn("Branch lock warning", { triggerId, warning });
    }
  }
}
