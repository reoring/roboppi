import type {
  TaskEnvelope,
  TaskExecutionPlan,
  TaskOrchestratorConfig,
  TaskRouteDef,
  TaskRoutingDecision,
} from "./types.js";

export class TaskRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRoutingError";
  }
}

export class TaskRouter {
  constructor(private readonly config: TaskOrchestratorConfig) {}

  route(task: TaskEnvelope, decidedAt: number = Date.now()): TaskRoutingDecision {
    for (const [routeId, route] of Object.entries(this.config.routes)) {
      const matchedOn = explainRouteMatch(task, route);
      if (!matchedOn) continue;

      return {
        version: "1",
        task_id: task.task_id,
        route_id: routeId,
        decided_at: decidedAt,
        matched_on: matchedOn,
        plan: buildExecutionPlan(task, route),
      };
    }

    throw new TaskRoutingError(
      `No route matched task "${task.task_id}" (${task.source.kind}, action=${task.requested_action})`,
    );
  }
}

function explainRouteMatch(task: TaskEnvelope, route: TaskRouteDef): string[] | null {
  const when = route.when;
  if (!when) {
    return ["default route"];
  }

  const reasons: string[] = [];

  if (when.source !== undefined) {
    if (task.source.kind !== when.source) return null;
    reasons.push(`source=${when.source}`);
  }

  if (when.repository !== undefined) {
    if (task.repository?.id !== when.repository) return null;
    reasons.push(`repository=${when.repository}`);
  }

  if (when.requested_action !== undefined) {
    if (task.requested_action !== when.requested_action) return null;
    reasons.push(`requested_action=${when.requested_action}`);
  }

  if (when.labels_any !== undefined) {
    const matched = when.labels_any.filter((label) => task.labels.includes(label));
    if (matched.length === 0) return null;
    reasons.push(`labels_any=${matched.join(",")}`);
  }

  if (when.labels_all !== undefined) {
    const missing = when.labels_all.filter((label) => !task.labels.includes(label));
    if (missing.length > 0) return null;
    reasons.push(`labels_all=${when.labels_all.join(",")}`);
  }

  return reasons.length > 0 ? reasons : ["route.when empty"];
}

function buildExecutionPlan(task: TaskEnvelope, route: TaskRouteDef): TaskExecutionPlan {
  const env = {
    ...(route.env ?? {}),
    ...buildTaskEnv(task),
  };

  return {
    workflow: route.workflow,
    agentsFiles: route.agents_files,
    workspaceMode: route.workspace_mode,
    worktree:
      route.workspace_mode === "worktree"
        ? {
            baseRef: route.base_ref,
            branchNameTemplate: route.branch_name!,
          }
        : undefined,
    env,
    priorityClass: route.priority_class ?? "normal",
    managementEnabled: route.management?.enabled ?? false,
  };
}

function buildTaskEnv(task: TaskEnvelope): Record<string, string> {
  const env: Record<string, string> = {
    ROBOPPI_TASK_ID: task.task_id,
    ROBOPPI_TASK_SOURCE_KIND: task.source.kind,
    ROBOPPI_TASK_EXTERNAL_ID: task.source.external_id,
    ROBOPPI_TASK_REQUESTED_ACTION: task.requested_action,
    ROBOPPI_TASK_PRIORITY: task.priority,
    ROBOPPI_TASK_SLUG: taskSlug(task),
  };
  if (task.repository?.id) {
    env.ROBOPPI_TASK_REPOSITORY = task.repository.id;
  }
  if (task.requested_by) {
    env.ROBOPPI_TASK_REQUESTED_BY = task.requested_by;
  }
  return env;
}

function taskSlug(task: TaskEnvelope): string {
  const sourceTail = task.source.external_id.split(/[#:\/]/).filter(Boolean).pop() ?? task.task_id;
  const seed = task.title.trim() || sourceTail;
  const slug = seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (slug.length > 0) return slug;
  return sourceTail.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "task";
}
