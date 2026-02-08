import type {
  DaemonConfig,
  DaemonEvent,
  FilterValue,
  TriggerAction,
  TriggerDef,
  TriggerState,
} from "./types.js";
import type { DaemonStateStore } from "./state-store.js";
import type { WorkflowState } from "../workflow/types.js";
import { WorkflowStatus } from "../workflow/types.js";
import { parseDuration } from "../workflow/duration.js";

export type OnExecuteFn = (
  triggerId: string,
  trigger: TriggerDef,
  event: DaemonEvent,
) => Promise<WorkflowState>;

export class TriggerEngine {
  private readonly config: DaemonConfig;
  private readonly stateStore: DaemonStateStore;
  private readonly onExecute: OnExecuteFn;

  constructor(
    config: DaemonConfig,
    stateStore: DaemonStateStore,
    onExecute: OnExecuteFn,
  ) {
    this.config = config;
    this.stateStore = stateStore;
    this.onExecute = onExecute;
  }

  async handleEvent(event: DaemonEvent): Promise<TriggerAction[]> {
    const actions: TriggerAction[] = [];

    for (const [triggerId, trigger] of Object.entries(this.config.triggers)) {
      if (trigger.on !== event.sourceId) continue;
      const action = await this.processTrigger(triggerId, trigger, event);
      actions.push(action);
    }

    return actions;
  }

  private async processTrigger(
    triggerId: string,
    trigger: TriggerDef,
    event: DaemonEvent,
  ): Promise<TriggerAction> {
    const triggerState = await this.stateStore.getTriggerState(triggerId);

    // 1. Check enabled
    if (!triggerState.enabled || trigger.enabled === false) {
      return { action: "disabled" };
    }

    // 2. Check filter match
    if (trigger.filter && !matchFilter(trigger.filter, event)) {
      return { action: "filtered" };
    }

    // 3. Check debounce
    if (trigger.debounce && triggerState.lastFiredAt !== null) {
      const debounceMs = parseDuration(trigger.debounce);
      if (event.timestamp < triggerState.lastFiredAt + debounceMs) {
        return { action: "debounced" };
      }
    }

    // 4. Check cooldown
    if (triggerState.cooldownUntil !== null && Date.now() < triggerState.cooldownUntil) {
      return { action: "cooldown" };
    }

    // 5. Execute workflow
    const startedAt = Date.now();
    let result: WorkflowState;
    try {
      result = await this.onExecute(triggerId, trigger, event);
    } catch (err) {
      // Treat execution error as a failed workflow
      result = {
        workflowId: `${triggerId}-error-${startedAt}`,
        name: trigger.workflow,
        status: WorkflowStatus.FAILED,
        steps: {},
        startedAt,
        completedAt: Date.now(),
      };
    }

    const completedAt = Date.now();
    const succeeded = result.status === WorkflowStatus.SUCCEEDED;

    // 6. Update trigger state
    const updatedState: TriggerState = {
      enabled: triggerState.enabled,
      lastFiredAt: event.timestamp,
      cooldownUntil: succeeded && trigger.cooldown
        ? completedAt + parseDuration(trigger.cooldown)
        : triggerState.cooldownUntil,
      executionCount: triggerState.executionCount + 1,
      consecutiveFailures: succeeded
        ? 0
        : triggerState.consecutiveFailures + 1,
    };

    // Handle pause_trigger on failure
    if (
      !succeeded &&
      trigger.on_workflow_failure === "pause_trigger" &&
      updatedState.consecutiveFailures >= (trigger.max_retries ?? 3)
    ) {
      updatedState.enabled = false;
    }

    await this.stateStore.saveTriggerState(triggerId, updatedState);

    // 7. Save last result
    await this.stateStore.saveLastResult(triggerId, result);

    // 8. Record execution
    await this.stateStore.recordExecution({
      triggerId,
      event,
      workflowResult: result,
      startedAt,
      completedAt,
    });

    return { action: "executed", result };
  }
}

// ---------------------------------------------------------------------------
// Filter matching
// ---------------------------------------------------------------------------

function matchFilter(
  filter: Record<string, FilterValue>,
  event: DaemonEvent,
): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    const actual = resolveField(key, event);
    if (!matchValue(actual, expected)) return false;
  }
  return true;
}

function resolveField(dotPath: string, obj: unknown): unknown {
  const parts = dotPath.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function matchValue(actual: unknown, expected: FilterValue): boolean {
  if (typeof expected === "object" && expected !== null) {
    if ("pattern" in expected) {
      if (typeof actual !== "string") return false;
      const regex = new RegExp(expected.pattern);
      return regex.test(actual);
    }
    if ("in" in expected) {
      return expected.in.some((v) => v === actual);
    }
  }
  // Primitive equality (use String coercion to handle numeric string vs number)
  return String(actual) === String(expected);
}
