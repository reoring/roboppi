import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ContextManager } from "../workflow/context-manager.js";
import {
  WorkflowExecutor,
  type StepRunner,
} from "../workflow/executor.js";
import { loadWorkflow } from "../workflow/workflow-loader.js";
import {
  resolveBranchRuntimeContext,
  type BranchRuntimeContext,
} from "../workflow/branch-context.js";
import {
  WorkflowStatus,
  type WorkflowState,
} from "../workflow/types.js";
import type { ExecEventSink } from "../tui/exec-event.js";
import { NoopExecEventSink } from "../tui/noop-sink.js";
import { resolveLandingDecision } from "./landing-controller.js";
import { buildTaskIntentPolicy } from "./intent-policy.js";
import { buildTaskReportingPolicy } from "./reporting-policy.js";
import type {
  TaskEnvelope,
  TaskIntentPolicy,
  TaskLandingConfig,
  TaskLifecycleState,
  TaskReportingPolicy,
  TaskRoutingDecision,
  TaskRunSummary,
} from "./types.js";
import { TaskRegistryStore } from "./state-store.js";

export interface TaskDispatchOptions {
  registry: TaskRegistryStore;
  task: TaskEnvelope;
  decision: TaskRoutingDecision;
  workspaceDir: string;
  stepRunner: StepRunner;
  abortSignal?: AbortSignal;
  sink?: ExecEventSink;
  supervised?: boolean;
  sourceEvent?: unknown;
  successLifecycle?: TaskLifecycleState;
  failureLifecycle?: TaskLifecycleState;
  cancelLifecycle?: TaskLifecycleState;
  cliBaseBranch?: string;
  cliProtectedBranches?: string;
  cliAllowProtectedBranch?: boolean;
  landing?: TaskLandingConfig;
}

export interface TaskDispatchResult {
  taskId: string;
  runId: string;
  workflowPath: string;
  workspaceDir: string;
  contextDir: string;
  workflowState: WorkflowState;
  branchContext: BranchRuntimeContext;
}

export class TaskDispatchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "TaskDispatchError";
  }
}

export class TaskDispatcher {
  async dispatch(options: TaskDispatchOptions): Promise<TaskDispatchResult> {
    const {
      registry,
      task,
      decision,
      workspaceDir,
      stepRunner,
      abortSignal,
      sourceEvent,
    } = options;

    const run = await registry.createRun(task.task_id, {
      workflow: decision.plan.workflow,
      sourceRevision: task.source.revision ?? null,
    });
    await registry.saveRunPlan(task.task_id, run.run_id, decision.plan);

    const workflowPath = path.resolve(workspaceDir, decision.plan.workflow);
    const contextDir = path.join(
      registry.getRunDirectory(task.task_id, run.run_id),
      "context",
    );
    const taskEnv = buildDispatchEnv(task, decision, run.run_id, contextDir);

    try {
      const agentsFiles = decision.plan.agentsFiles?.map((filePath) =>
        path.isAbsolute(filePath) ? filePath : path.resolve(workspaceDir, filePath),
      );
      const { definition, definitionPath, agentCatalog } = await loadWorkflow(workflowPath, {
        explicitAgentsPaths: agentsFiles,
      });
      const taskIntentPolicy = buildTaskIntentPolicy(definition);
      const reportingPolicy = buildTaskReportingPolicy(definition);

      const executorEnv = {
        ...decision.plan.env,
        ...taskEnv,
      };
      if (decision.plan.worktree?.baseRef && executorEnv.BASE_BRANCH === undefined) {
        executorEnv.BASE_BRANCH = decision.plan.worktree.baseRef;
      } else if (executorEnv.BASE_BRANCH === undefined) {
        const defaultBaseBranch = resolveDefaultBaseBranch(task);
        if (defaultBaseBranch) {
          executorEnv.BASE_BRANCH = defaultBaseBranch;
        }
      }
      if (decision.plan.worktree?.branchNameTemplate) {
        executorEnv.ROBOPPI_TASK_BRANCH_TEMPLATE = decision.plan.worktree.branchNameTemplate;
      }
      executorEnv.ROBOPPI_TASK_ROUTE_ID = decision.route_id;

      const branchContext = await resolveBranchRuntimeContext({
        workspaceDir,
        cliBaseBranch: options.cliBaseBranch,
        envBaseBranch: executorEnv.BASE_BRANCH,
        cliProtectedBranches: options.cliProtectedBranches,
        envProtectedBranches: executorEnv.ROBOPPI_PROTECTED_BRANCHES,
        cliAllowProtectedBranch: options.cliAllowProtectedBranch,
        envAllowProtectedBranch: executorEnv.ROBOPPI_ALLOW_PROTECTED_BRANCH,
        createBranch:
          definition.create_branch ?? decision.plan.workspaceMode === "worktree",
        expectedWorkBranch: definition.expected_work_branch,
        branchTransitionStep: definition.branch_transition_step,
        stepIds: Object.keys(definition.steps),
      });

      await writeTaskContextArtifacts({
        contextDir,
        task,
        decision,
        taskIntentPolicy,
        reportingPolicy,
        sourceEvent,
        runId: run.run_id,
        workflowPath,
        workspaceDir,
      });

      await registry.markRunRunning(task.task_id, run.run_id);

      const executor = new WorkflowExecutor(
        definition,
        new ContextManager(contextDir),
        stepRunner,
        workspaceDir,
        executorEnv,
        abortSignal,
        branchContext,
        options.supervised ?? false,
        options.sink ?? new NoopExecEventSink(),
        {
          definitionPath,
          workflowCallStack: [definitionPath],
          agentCatalog,
        },
      );
      const workflowState = await executor.execute();

      await registry.saveWorkflowResult(task.task_id, run.run_id, workflowState);
      const completed = deriveCompletion(
        workflowState.status,
        options.successLifecycle,
        options.failureLifecycle,
        options.cancelLifecycle,
      );
      const landingDecision = await resolveLandingDecision({
        contextDir,
        landing: options.landing,
        defaultLifecycle: completed.lifecycle,
        defaultRationale: completed.rationale,
        allowWorkflowDirective: completed.runStatus === "completed",
      });
      await registry.saveLandingDecision(task.task_id, run.run_id, landingDecision);
      await registry.finishRun(task.task_id, run.run_id, {
        status: completed.runStatus,
        lifecycle: landingDecision.lifecycle,
        completedAt: workflowState.completedAt ?? Date.now(),
        workflowId: workflowState.workflowId,
        workflowStatus: workflowState.status,
      });
      await registry.saveRunSummary(
        task.task_id,
        run.run_id,
        buildRunSummary(
          task.task_id,
          run.run_id,
          landingDecision.lifecycle,
          workflowState.status,
          landingDecision.rationale ?? completed.rationale,
          {
            route_id: decision.route_id,
            workflow: decision.plan.workflow,
            context_dir: contextDir,
            workspace_dir: workspaceDir,
            landing: landingDecision,
          },
        ),
      );

      return {
        taskId: task.task_id,
        runId: run.run_id,
        workflowPath,
        workspaceDir,
        contextDir,
        workflowState,
        branchContext,
      };
    } catch (err) {
      const isCancelled = abortSignal?.aborted === true;
      const lifecycle = isCancelled
        ? options.cancelLifecycle ?? "blocked"
        : options.failureLifecycle ?? "failed";
      const runStatus = isCancelled ? "cancelled" : "failed";
      const message = err instanceof Error ? err.message : String(err);

      await registry.finishRun(task.task_id, run.run_id, {
        status: runStatus,
        lifecycle,
        completedAt: Date.now(),
        error: message,
      });
      await registry.saveRunSummary(
        task.task_id,
        run.run_id,
        buildRunSummary(
          task.task_id,
          run.run_id,
          lifecycle,
          undefined,
          message,
          {
            route_id: decision.route_id,
            workflow: decision.plan.workflow,
            context_dir: contextDir,
            workspace_dir: workspaceDir,
          },
        ),
      );

      throw new TaskDispatchError(
        `Failed to dispatch task "${task.task_id}" via route "${decision.route_id}"`,
        err,
      );
    }
  }
}

function buildDispatchEnv(
  task: TaskEnvelope,
  decision: TaskRoutingDecision,
  runId: string,
  contextDir: string,
): Record<string, string> {
  const env: Record<string, string> = {
    ROBOPPI_TASK_ID: task.task_id,
    ROBOPPI_TASK_SOURCE_KIND: task.source.kind,
    ROBOPPI_TASK_EXTERNAL_ID: task.source.external_id,
    ROBOPPI_TASK_URL: task.source.url ?? "",
    ROBOPPI_TASK_REQUESTED_ACTION: task.requested_action,
    ROBOPPI_TASK_RUN_ID: runId,
    ROBOPPI_TASK_CONTEXT_DIR: contextDir,
    ROBOPPI_TASK_ROUTE_ID: decision.route_id,
    ROBOPPI_TASK_TITLE: task.title,
  };
  if (task.repository?.id) {
    env.ROBOPPI_TASK_REPOSITORY = task.repository.id;
  }
  if (task.repository?.default_branch) {
    env.ROBOPPI_TASK_REPOSITORY_DEFAULT_BRANCH = task.repository.default_branch;
  }
  if (task.requested_by) {
    env.ROBOPPI_TASK_REQUESTED_BY = task.requested_by;
  }
  const taskNumber = parseTaskNumber(task.source.external_id);
  if (taskNumber) {
    if (task.source.kind === "github_issue") {
      env.ROBOPPI_TASK_ISSUE_NUMBER = taskNumber;
    } else if (task.source.kind === "github_pull_request") {
      env.ROBOPPI_TASK_PULL_REQUEST_NUMBER = taskNumber;
    }
  }
  const baseRef = getTaskMetadataString(task, "base_ref");
  if (baseRef) {
    env.ROBOPPI_TASK_BASE_REF = baseRef;
  }
  const headRef = getTaskMetadataString(task, "head_ref");
  if (headRef) {
    env.ROBOPPI_TASK_HEAD_REF = headRef;
  }
  const headSha = getTaskMetadataString(task, "head_sha");
  if (headSha) {
    env.ROBOPPI_TASK_HEAD_SHA = headSha;
  }
  return env;
}

function resolveDefaultBaseBranch(task: TaskEnvelope): string | undefined {
  const metadataBaseRef = getTaskMetadataString(task, "base_ref");
  if (metadataBaseRef) {
    return metadataBaseRef;
  }
  return task.repository?.default_branch;
}

function getTaskMetadataString(task: TaskEnvelope, key: string): string | undefined {
  const value = task.metadata?.[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseTaskNumber(externalId: string): string | undefined {
  const hashIndex = externalId.lastIndexOf("#");
  if (hashIndex < 0 || hashIndex === externalId.length - 1) {
    return undefined;
  }
  const raw = externalId.slice(hashIndex + 1).trim();
  return /^\d+$/.test(raw) ? raw : undefined;
}

async function writeTaskContextArtifacts(args: {
  contextDir: string;
  task: TaskEnvelope;
  decision: TaskRoutingDecision;
  taskIntentPolicy: TaskIntentPolicy | null;
  reportingPolicy: TaskReportingPolicy | null;
  sourceEvent?: unknown;
  runId: string;
  workflowPath: string;
  workspaceDir: string;
}): Promise<void> {
  const taskDir = path.join(args.contextDir, "_task");
  await mkdir(taskDir, { recursive: true });
  await writeJson(path.join(taskDir, "task.json"), args.task);
  await writeJson(path.join(taskDir, "routing.json"), args.decision);
  await writeJson(path.join(taskDir, "run.json"), {
    version: "1",
    task_id: args.task.task_id,
    run_id: args.runId,
    workflow: args.decision.plan.workflow,
    workflow_path: args.workflowPath,
    workspace_dir: args.workspaceDir,
    context_dir: args.contextDir,
  });
  if (args.taskIntentPolicy) {
    await writeJson(path.join(taskDir, "task-policy.json"), args.taskIntentPolicy);
  }
  if (args.reportingPolicy) {
    await writeJson(path.join(taskDir, "reporting.json"), args.reportingPolicy);
  }
  if (args.sourceEvent !== undefined) {
    await writeJson(path.join(taskDir, "source-event.json"), args.sourceEvent);
  }
}

function deriveCompletion(
  workflowStatus: WorkflowStatus,
  successLifecycle?: TaskLifecycleState,
  failureLifecycle?: TaskLifecycleState,
  cancelLifecycle?: TaskLifecycleState,
): {
  runStatus: "completed" | "failed" | "cancelled";
  lifecycle: TaskLifecycleState;
  rationale: string;
} {
  switch (workflowStatus) {
    case WorkflowStatus.SUCCEEDED:
      return {
        runStatus: "completed",
        lifecycle: successLifecycle ?? "review_required",
        rationale: "Workflow succeeded; awaiting task-level review.",
      };
    case WorkflowStatus.CANCELLED:
      return {
        runStatus: "cancelled",
        lifecycle: cancelLifecycle ?? "blocked",
        rationale: "Workflow was cancelled before task completion.",
      };
    case WorkflowStatus.FAILED:
    case WorkflowStatus.TIMED_OUT:
      return {
        runStatus: "failed",
        lifecycle: failureLifecycle ?? "failed",
        rationale: `Workflow ended with status ${workflowStatus}.`,
      };
    case WorkflowStatus.PENDING:
    case WorkflowStatus.RUNNING:
      return {
        runStatus: "failed",
        lifecycle: failureLifecycle ?? "failed",
        rationale: `Workflow returned unexpected terminal status ${workflowStatus}.`,
      };
  }
}

function buildRunSummary(
  taskId: string,
  runId: string,
  lifecycle: TaskLifecycleState,
  workflowStatus: string | undefined,
  rationale: string,
  metadata: Record<string, unknown>,
): TaskRunSummary {
  return {
    version: "1",
    task_id: taskId,
    run_id: runId,
    generated_at: Date.now(),
    final_lifecycle: lifecycle,
    workflow_status: workflowStatus,
    rationale,
    metadata,
  };
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, JSON.stringify(data, null, 2) + "\n");
}
