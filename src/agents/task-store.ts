/**
 * Agent Task Store — race-free task state transitions via rename().
 *
 * See `docs/features/agents.md` §5.3 and §6.1.2.
 */
import { mkdir, readdir, readFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { isAbsolute } from "node:path";
import { atomicJsonWrite } from "./fs-atomic.js";
import { appendTaskEvent } from "./events.js";
import { tasksStatusDir, tasksTmp } from "./paths.js";
import { MAX_TASK_BYTES } from "./constants.js";
import type { AgentTask, TaskStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Artifact path validation
// ---------------------------------------------------------------------------

/**
 * Validate artifact paths: must be relative and must not contain `..`
 * segments.  This prevents path-traversal when `roboppi agents` is exposed
 * as a restricted tool.
 */
export function validateArtifactPath(p: string): void {
  if (isAbsolute(p)) {
    throw new Error(`Artifact path must be relative, got absolute path: ${p}`);
  }
  const segments = p.split("/");
  if (segments.some((s) => s === "..")) {
    throw new Error(`Artifact path must not contain '..': ${p}`);
  }
}

// ---------------------------------------------------------------------------
// Add task
// ---------------------------------------------------------------------------

export interface AddTaskOptions {
  contextDir: string;
  taskId?: string;
  title: string;
  description: string;
  dependsOn?: string[];
  assignedTo?: string;
  tags?: string[];
  requiresPlanApproval?: boolean;
}

export async function addTask(opts: AddTaskOptions): Promise<{ taskId: string }> {
  const taskId = opts.taskId ?? randomUUID();
  const now = Date.now();

  const task: AgentTask = {
    version: "1",
    task_id: taskId,
    title: opts.title,
    description: opts.description,
    status: "pending",
    depends_on: opts.dependsOn ?? [],
    created_at: now,
    updated_at: now,
    assigned_to: opts.assignedTo ?? null,
    claimed_by: null,
    claimed_at: null,
    completed_at: null,
    superseded_at: null,
    superseded_by: null,
    supersede_reason: null,
    replacement_task_id: null,
    artifacts: [],
    tags: opts.tags ?? [],
    requires_plan_approval: opts.requiresPlanApproval ?? false,
  };

  const json = JSON.stringify(task, null, 2);
  if (Buffer.byteLength(json, "utf-8") > MAX_TASK_BYTES) {
    throw new Error(`Task file exceeds max size (${MAX_TASK_BYTES} bytes)`);
  }

  const pendingDir = tasksStatusDir(opts.contextDir, "pending");
  await mkdir(pendingDir, { recursive: true });
  const destPath = resolve(pendingDir, `${taskId}.json`);
  const tmpDir = tasksTmp(opts.contextDir);

  await atomicJsonWrite(tmpDir, destPath, task);

  await appendTaskEvent(opts.contextDir, {
    ts: now,
    type: "task_added",
    task_id: taskId,
    title: opts.title,
  });

  return { taskId };
}

// ---------------------------------------------------------------------------
// List tasks
// ---------------------------------------------------------------------------

export async function listTasks(
  contextDir: string,
  status?: TaskStatus,
): Promise<AgentTask[]> {
  const statuses: TaskStatus[] = status
    ? [status]
    : ["pending", "in_progress", "completed", "blocked", "superseded"];

  const tasks: AgentTask[] = [];

  for (const s of statuses) {
    const dir = tasksStatusDir(contextDir, s);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }

    entries.sort();
    for (const filename of entries) {
      if (!filename.endsWith(".json")) continue;
      try {
        const raw = await readFile(resolve(dir, filename), "utf-8");
        const task = JSON.parse(raw) as AgentTask;
        tasks.push(task);
      } catch {
        // corrupted — skip
      }
    }
  }

  return tasks;
}

export function isTaskClaimableBy(
  task: Pick<AgentTask, "assigned_to" | "claimed_by">,
  memberId: string,
): boolean {
  if (task.claimed_by) {
    return task.claimed_by === memberId;
  }
  return task.assigned_to === null || task.assigned_to === memberId;
}

export function areTaskDependenciesSatisfied(
  task: Pick<AgentTask, "depends_on">,
  taskStates: ReadonlyMap<string, Pick<AgentTask, "status" | "replacement_task_id">>,
): boolean {
  return task.depends_on.every((dep) => isDependencyResolved(dep, taskStates));
}

function isDependencyResolved(
  taskId: string,
  taskStates: ReadonlyMap<string, Pick<AgentTask, "status" | "replacement_task_id">>,
  visiting: Set<string> = new Set(),
): boolean {
  const state = taskStates.get(taskId);
  if (!state) return false;
  if (state.status === "completed") return true;
  if (state.status !== "superseded") return false;
  if (!state.replacement_task_id) return true;
  if (visiting.has(taskId)) return false;
  visiting.add(taskId);
  const resolved = isDependencyResolved(state.replacement_task_id, taskStates, visiting);
  visiting.delete(taskId);
  return resolved;
}

async function readTaskDependencyStates(
  contextDir: string,
): Promise<Map<string, Pick<AgentTask, "status" | "replacement_task_id">>> {
  const tasks = await listTasks(contextDir);
  return new Map(
    tasks.map((task) => [
      task.task_id,
      {
        status: task.status,
        replacement_task_id: task.replacement_task_id,
      },
    ]),
  );
}

async function unblockSatisfiedBlockedTasks(contextDir: string): Promise<number> {
  const blocked = await listTasks(contextDir, "blocked");
  if (blocked.length === 0) return 0;

  const taskStates = await readTaskDependencyStates(contextDir);
  const blockedDir = tasksStatusDir(contextDir, "blocked");
  const pendingDir = tasksStatusDir(contextDir, "pending");
  const tmpDir = tasksTmp(contextDir);
  await mkdir(pendingDir, { recursive: true });

  let unblocked = 0;
  for (const task of blocked) {
    if (!areTaskDependenciesSatisfied(task, taskStates)) continue;

    const filename = `${task.task_id}.json`;
    const blockedPath = resolve(blockedDir, filename);
    const pendingPath = resolve(pendingDir, filename);
    const now = Date.now();
    task.status = "pending";
    task.updated_at = now;
    task.claimed_by = null;
    task.claimed_at = null;

    try {
      await atomicJsonWrite(tmpDir, blockedPath, task);
      await rename(blockedPath, pendingPath);
    } catch {
      continue;
    }

    taskStates.set(task.task_id, {
      status: "pending",
      replacement_task_id: task.replacement_task_id,
    });

    await appendTaskEvent(contextDir, {
      ts: now,
      type: "task_requeued",
      task_id: task.task_id,
      title: task.title,
    });
    unblocked++;
  }

  return unblocked;
}

export async function hasActionableTaskForMember(
  contextDir: string,
  memberId: string,
): Promise<boolean> {
  await unblockSatisfiedBlockedTasks(contextDir);

  const inProgress = await listTasks(contextDir, "in_progress");
  if (inProgress.some((task) => task.claimed_by === memberId)) {
    return true;
  }

  const pending = await listTasks(contextDir, "pending");
  const claimablePending = pending.filter((task) => isTaskClaimableBy(task, memberId));
  if (claimablePending.length === 0) {
    return false;
  }

  const taskStates = await readTaskDependencyStates(contextDir);
  return claimablePending.some((task) =>
    areTaskDependenciesSatisfied(task, taskStates),
  );
}

// ---------------------------------------------------------------------------
// Claim task
// ---------------------------------------------------------------------------

/**
 * Race-free claim:
 * 1. rename(pending/<id>.json, in_progress/<id>.json) — wins the race
 * 2. read in_progress/<id>.json
 * 3. write updated JSON to tasks/tmp/<id>.<uuid>.json
 * 4. rename(tasks/tmp/<id>.<uuid>.json, in_progress/<id>.json) — atomic replace
 */
export async function claimTask(
  contextDir: string,
  taskId: string,
  memberId: string,
): Promise<{ ok: boolean; error?: string }> {
  const pendingDir = tasksStatusDir(contextDir, "pending");
  const inProgressDir = tasksStatusDir(contextDir, "in_progress");
  const blockedDir = tasksStatusDir(contextDir, "blocked");

  await mkdir(inProgressDir, { recursive: true });
  await mkdir(blockedDir, { recursive: true });

  const filename = `${taskId}.json`;
  const srcPath = resolve(pendingDir, filename);
  const destPath = resolve(inProgressDir, filename);

  // Step 1: atomic rename wins the race
  try {
    await rename(srcPath, destPath);
  } catch {
    return { ok: false, error: "Task not found in pending/ or already claimed by another" };
  }

  // Step 2: read & validate dependencies
  let task: AgentTask;
  try {
    const raw = await readFile(destPath, "utf-8");
    task = JSON.parse(raw) as AgentTask;
  } catch {
    return { ok: false, error: "Failed to read claimed task" };
  }

  if (!isTaskClaimableBy(task, memberId)) {
    try {
      await rename(destPath, srcPath);
    } catch {
      // best-effort rollback
    }
    if (task.assigned_to) {
      return {
        ok: false,
        error: `Task is assigned to "${task.assigned_to}" and cannot be claimed by "${memberId}"`,
      };
    }
    return { ok: false, error: `Task cannot be claimed by "${memberId}"` };
  }

  // Check dependencies
  if (task.depends_on.length > 0) {
    const taskStates = await readTaskDependencyStates(contextDir);
    const unmet = task.depends_on.filter((dep) => !isDependencyResolved(dep, taskStates));
    if (unmet.length > 0) {
      // Move to blocked/
      const blockedPath = resolve(blockedDir, filename);
      try {
        task.status = "blocked";
        task.updated_at = Date.now();
        const tmpDir = tasksTmp(contextDir);
        await atomicJsonWrite(tmpDir, resolve(inProgressDir, filename), task);
        await rename(resolve(inProgressDir, filename), blockedPath);
      } catch {
        // best-effort
      }

      await appendTaskEvent(contextDir, {
        ts: Date.now(),
        type: "task_blocked",
        task_id: taskId,
        title: task.title,
        by: memberId,
      });

      return { ok: false, error: `Unmet dependencies: ${unmet.join(", ")}` };
    }
  }

  // Step 3-4: rewrite with claim metadata
  const now = Date.now();
  task.status = "in_progress";
  task.claimed_by = memberId;
  task.claimed_at = now;
  task.updated_at = now;

  // Enforce max task file size
  const claimJson = JSON.stringify(task, null, 2);
  if (Buffer.byteLength(claimJson, "utf-8") > MAX_TASK_BYTES) {
    // Move back to pending since we can't write oversized data
    try {
      await rename(destPath, srcPath);
    } catch { /* best-effort */ }
    return { ok: false, error: `Task file exceeds max size (${MAX_TASK_BYTES} bytes) after claim update` };
  }

  const tmpDir = tasksTmp(contextDir);
  await atomicJsonWrite(tmpDir, destPath, task);

  await appendTaskEvent(contextDir, {
    ts: now,
    type: "task_claimed",
    task_id: taskId,
    title: task.title,
    by: memberId,
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Complete task
// ---------------------------------------------------------------------------

export async function completeTask(
  contextDir: string,
  taskId: string,
  memberId: string,
  artifacts?: string[],
): Promise<{ ok: boolean; error?: string }> {
  const inProgressDir = tasksStatusDir(contextDir, "in_progress");
  const completedDir = tasksStatusDir(contextDir, "completed");

  await mkdir(completedDir, { recursive: true });

  const filename = `${taskId}.json`;
  const srcPath = resolve(inProgressDir, filename);
  const destPath = resolve(completedDir, filename);

  // Step 1: atomic rename
  try {
    await rename(srcPath, destPath);
  } catch {
    return { ok: false, error: "Task not found in in_progress/ or already completed" };
  }

  // Step 2: read and update
  let task: AgentTask;
  try {
    const raw = await readFile(destPath, "utf-8");
    task = JSON.parse(raw) as AgentTask;
  } catch {
    return { ok: false, error: "Failed to read completed task" };
  }

  if (task.claimed_by && task.claimed_by !== memberId) {
    try {
      await rename(destPath, srcPath);
    } catch {
      // best-effort rollback
    }
    return {
      ok: false,
      error: `Task is claimed by "${task.claimed_by}" and cannot be completed by "${memberId}"`,
    };
  }

  // Validate artifact paths before writing
  if (artifacts) {
    for (const a of artifacts) {
      try {
        validateArtifactPath(a);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }

  const now = Date.now();
  task.status = "completed";
  task.completed_at = now;
  task.updated_at = now;
  if (artifacts) {
    task.artifacts = [...task.artifacts, ...artifacts];
  }

  // Enforce max task file size
  const completeJson = JSON.stringify(task, null, 2);
  if (Buffer.byteLength(completeJson, "utf-8") > MAX_TASK_BYTES) {
    // Move back to in_progress since we can't write oversized data
    try {
      await rename(destPath, srcPath);
    } catch { /* best-effort */ }
    return { ok: false, error: `Task file exceeds max size (${MAX_TASK_BYTES} bytes) after complete update` };
  }

  const tmpDir = tasksTmp(contextDir);
  await atomicJsonWrite(tmpDir, destPath, task);

  await appendTaskEvent(contextDir, {
    ts: now,
    type: "task_completed",
    task_id: taskId,
    title: task.title,
    by: memberId,
  });

  await unblockSatisfiedBlockedTasks(contextDir);

  return { ok: true };
}


export async function supersedeTask(
  contextDir: string,
  taskId: string,
  memberId: string,
  reason?: string,
  replacementTaskId?: string,
): Promise<{ ok: boolean; error?: string }> {
  const activeStatuses: TaskStatus[] = ["pending", "in_progress", "blocked"];
  const supersededDir = tasksStatusDir(contextDir, "superseded");

  await mkdir(supersededDir, { recursive: true });

  const filename = `${taskId}.json`;
  const destPath = resolve(supersededDir, filename);

  let fromStatus: TaskStatus | null = null;
  for (const status of activeStatuses) {
    const srcPath = resolve(tasksStatusDir(contextDir, status), filename);
    try {
      await rename(srcPath, destPath);
      fromStatus = status;
      break;
    } catch {
      // try next status
    }
  }

  if (fromStatus === null) {
    return { ok: false, error: "Task not found in pending/, in_progress/, or blocked/" };
  }

  let task: AgentTask;
  try {
    const raw = await readFile(destPath, "utf-8");
    task = JSON.parse(raw) as AgentTask;
  } catch {
    return { ok: false, error: "Failed to read superseded task" };
  }

  const now = Date.now();
  task.status = "superseded";
  task.updated_at = now;
  task.superseded_at = now;
  task.superseded_by = memberId;
  task.supersede_reason = reason ?? null;
  task.replacement_task_id = replacementTaskId ?? null;

  const supersedeJson = JSON.stringify(task, null, 2);
  if (Buffer.byteLength(supersedeJson, "utf-8") > MAX_TASK_BYTES) {
    const rollbackPath = resolve(tasksStatusDir(contextDir, fromStatus), filename);
    try {
      await rename(destPath, rollbackPath);
    } catch { /* best-effort */ }
    return { ok: false, error: `Task file exceeds max size (${MAX_TASK_BYTES} bytes) after supersede update` };
  }

  const tmpDir = tasksTmp(contextDir);
  await atomicJsonWrite(tmpDir, destPath, task);

  await appendTaskEvent(contextDir, {
    ts: now,
    type: "task_superseded",
    task_id: taskId,
    title: task.title,
    by: memberId,
    reason,
    replacement_task_id: replacementTaskId,
  });

  await unblockSatisfiedBlockedTasks(contextDir);

  return { ok: true };
}
