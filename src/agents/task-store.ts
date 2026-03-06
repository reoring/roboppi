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
  title: string;
  description: string;
  dependsOn?: string[];
  assignedTo?: string;
  tags?: string[];
  requiresPlanApproval?: boolean;
}

export async function addTask(opts: AddTaskOptions): Promise<{ taskId: string }> {
  const taskId = randomUUID();
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
    : ["pending", "in_progress", "completed", "blocked"];

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

  // Check dependencies
  if (task.depends_on.length > 0) {
    const completedDir = tasksStatusDir(contextDir, "completed");
    let completedEntries: string[];
    try {
      completedEntries = await readdir(completedDir);
    } catch {
      completedEntries = [];
    }
    const completedIds = new Set(
      completedEntries
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", "")),
    );

    const unmet = task.depends_on.filter((dep) => !completedIds.has(dep));
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

  return { ok: true };
}
