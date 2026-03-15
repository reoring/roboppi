import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { TaskActivityEvent, TaskActivityKind, TaskRunId } from "./types.js";
import {
  authorizeTaskIntentMember,
  readTaskIntentPolicy,
} from "./intent-policy.js";

export interface EmitTaskActivityOptions {
  contextDir: string;
  kind: TaskActivityKind;
  message: string;
  phase?: string;
  memberId?: string;
  metadata?: Record<string, unknown>;
  ts?: number;
}

interface TaskRunContextDoc {
  task_id?: unknown;
  run_id?: unknown;
}

export async function emitTaskActivity(
  options: EmitTaskActivityOptions,
): Promise<TaskActivityEvent> {
  const policy = await readTaskIntentPolicy(options.contextDir);
  if (policy !== null) {
    if (!options.memberId || options.memberId.trim() === "") {
      throw new Error(
        "activity emit requires memberId when task policy is configured",
      );
    }
    const authorization = authorizeTaskIntentMember(
      policy,
      "activity",
      options.memberId,
    );
    if (!authorization.accepted) {
      throw new Error(
        authorization.rejectionReason ?? "activity emission was rejected by task policy",
      );
    }
  }

  const runDoc = await readRunContext(options.contextDir);
  const event: TaskActivityEvent = {
    version: "1",
    ts: options.ts ?? Date.now(),
    task_id: runDoc.task_id,
    run_id: runDoc.run_id,
    kind: options.kind,
    message: options.message,
    phase: options.phase,
    member_id: options.memberId,
    metadata: options.metadata,
  };

  const filePath = activityLogPath(options.contextDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, JSON.stringify(event) + "\n");
  return event;
}

export async function readTaskActivityEvents(
  contextDir: string,
): Promise<TaskActivityEvent[]> {
  const text = await Bun.file(activityLogPath(contextDir)).text().catch(() => "");
  if (text.trim() === "") return [];

  const events: TaskActivityEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed = JSON.parse(trimmed) as TaskActivityEvent;
    events.push(parsed);
  }
  return events.sort((a, b) => a.ts - b.ts);
}

export async function readLatestTaskActivity(
  contextDir: string,
): Promise<TaskActivityEvent | null> {
  const events = await readTaskActivityEvents(contextDir);
  return events.length > 0 ? events[events.length - 1]! : null;
}

export function activityLogPath(contextDir: string): string {
  return path.join(contextDir, "_task", "activity.jsonl");
}

async function readRunContext(
  contextDir: string,
): Promise<{ task_id: string; run_id: TaskRunId }> {
  const filePath = path.join(contextDir, "_task", "run.json");
  const parsed = JSON.parse(await Bun.file(filePath).text()) as TaskRunContextDoc;
  if (typeof parsed.task_id !== "string" || parsed.task_id.trim() === "") {
    throw new Error(`Invalid task context: missing task_id in ${filePath}`);
  }
  if (typeof parsed.run_id !== "string" || parsed.run_id.trim() === "") {
    throw new Error(`Invalid task context: missing run_id in ${filePath}`);
  }
  return {
    task_id: parsed.task_id,
    run_id: parsed.run_id,
  };
}
