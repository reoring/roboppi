import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
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
import { WorkflowExecutor } from "../workflow/executor.js";
import { MultiWorkerStepRunner } from "../workflow/multi-worker-step-runner.js";
import { ContextManager } from "../workflow/context-manager.js";
import { Logger } from "../core/observability.js";

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
  private shutdownRequested = false;
  private runningWorkflows = 0;
  private readonly maxConcurrent: number;
  private readonly workflowQueue: QueuedItem[] = [];
  private readonly defaultMaxQueue: number = 10;
  private workflowDoneResolve: (() => void) | null = null;
  private startedAt: number = 0;

  constructor(config: DaemonConfig, logger?: Logger) {
    this.config = config;
    this.logger = logger ?? new Logger("daemon");
    const stateDir = config.state_dir ?? path.join(config.workspace, ".daemon-state");
    this.stateStore = new DaemonStateStore(stateDir);
    this.evaluateGate = new EvaluateGate();
    this.resultAnalyzer = new ResultAnalyzer();
    this.maxConcurrent = config.max_concurrent_workflows ?? 5;
  }

  async start(): Promise<void> {
    // 1. Ensure workspace and state dirs exist
    await mkdir(this.config.workspace, { recursive: true });
    const stateDir = this.config.state_dir ?? path.join(this.config.workspace, ".daemon-state");
    await mkdir(stateDir, { recursive: true });

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
          this.eventSources.push(new FSWatchSource(eventId, eventDef));
          break;
        case "webhook":
          if (!this.webhookServer) {
            this.webhookServer = new WebhookServer();
          }
          this.eventSources.push(new WebhookSource(eventId, eventDef, this.webhookServer));
          break;
        case "command":
          this.eventSources.push(new CommandSource(eventId, eventDef));
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

    this.logger.info("Event loop started, waiting for events...");

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
  }

  async stop(): Promise<void> {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;

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
    this.runningWorkflows++;
    // Sanitize triggerId to prevent path traversal in file-based state storage
    const safeTriggerId = triggerId.replace(/[\/\\\.]/g, '_');

    try {
      const workspaceDir = path.resolve(this.config.workspace);

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
      const workflowEnv: Record<string, string> | undefined =
        trigger.context?.env ? { ...trigger.context.env } : undefined;

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
      const definition = parseWorkflow(yamlContent);

      // 3. Setup context dir
      const contextDir = path.join(workspaceDir, "context", safeTriggerId);
      await mkdir(contextDir, { recursive: true });

      // 4. Create executor and run
      const ctx = new ContextManager(contextDir);
      const runner = new MultiWorkerStepRunner(false);
      const executor = new WorkflowExecutor(definition, ctx, runner, workspaceDir, workflowEnv);
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
}
