import { parseDuration } from "../workflow/duration.js";
import { GitHubIssueBridge } from "./github-issue-bridge.js";
import { TaskOrchestratorService, type TaskOrchestratorBackgroundEvent, type TaskOrchestratorRunResult, type TaskOrchestratorServiceOptions } from "./service.js";
import type { TaskOrchestratorConfig } from "./types.js";

export interface TaskOrchestratorServerOptions extends TaskOrchestratorServiceOptions {
  pollEveryMs?: number;
  maxActiveInstances?: number;
  onCycle?: (result: TaskOrchestratorRunResult) => void | Promise<void>;
  onBackgroundEvent?: (
    event: TaskOrchestratorBackgroundEvent,
  ) => void | Promise<void>;
}

export class TaskOrchestratorServer {
  readonly service: TaskOrchestratorService;
  readonly pollEveryMs: number;
  readonly maxActiveInstances?: number;
  readonly githubBridge?: GitHubIssueBridge;
  private readonly abortSignal?: AbortSignal;
  private readonly onCycle?: (result: TaskOrchestratorRunResult) => void | Promise<void>;
  private readonly onBackgroundEvent?: (
    event: TaskOrchestratorBackgroundEvent,
  ) => void | Promise<void>;

  constructor(
    config: TaskOrchestratorConfig,
    options: TaskOrchestratorServerOptions,
  ) {
    this.service = new TaskOrchestratorService(config, options);
    this.pollEveryMs =
      options.pollEveryMs ?? parseDuration(config.runtime.poll_every);
    this.maxActiveInstances =
      options.maxActiveInstances ?? config.runtime.max_active_instances;
    this.githubBridge = config.activity.github.enabled
      ? new GitHubIssueBridge({
          registry: this.service.registry,
          abortSignal: options.abortSignal,
        })
      : undefined;
    this.abortSignal = options.abortSignal;
    this.onCycle = options.onCycle;
    this.onBackgroundEvent = options.onBackgroundEvent;
  }

  async serve(): Promise<void> {
    while (!this.abortSignal?.aborted) {
      if (await this.isAtCapacity()) {
        await sleep(this.pollEveryMs, this.abortSignal);
        continue;
      }

      const result = await this.service.runOnce({
        detachDispatch: true,
        onBackgroundEvent: async (event) => {
          if (this.githubBridge) {
            await this.githubBridge.syncTask(event.taskId);
          }
          await this.onBackgroundEvent?.(event);
        },
      });
      if (this.githubBridge) {
        await this.githubBridge.syncActiveTasks();
        await this.githubBridge.syncTasksByLifecycle(["waiting_for_input", "blocked"]);
      }
      await this.onCycle?.(result);

      if (this.abortSignal?.aborted) {
        break;
      }
      await sleep(this.pollEveryMs, this.abortSignal);
    }

    await this.service.waitForBackgroundDispatches();
  }

  private async isAtCapacity(): Promise<boolean> {
    if (this.maxActiveInstances === undefined) {
      return false;
    }
    const activeTasks = await this.service.registry.listActiveTasks();
    return activeTasks.length >= this.maxActiveInstances;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
