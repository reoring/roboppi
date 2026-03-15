import path from "node:path";
import type {
  AgentMemberConfig,
  WorkflowDefinition,
  WorkflowReportingEvent,
} from "../workflow/types.js";
import type {
  TaskActivityEvent,
  TaskActivityKind,
  TaskReportingAggregate,
  TaskReportingPolicy,
  TaskReportingProjection,
  TaskReportingSinkId,
  TaskReportingSinkPolicy,
} from "./types.js";

const ALL_ACTIVITY_KINDS: TaskActivityKind[] = [
  "progress",
  "blocker",
  "waiting_for_input",
  "review_required",
  "ready_to_land",
  "landed",
  "commit_created",
  "push_completed",
];

export function buildTaskReportingPolicy(
  definition: WorkflowDefinition,
): TaskReportingPolicy | null {
  if (!definition.reporting) return null;

  const members = Object.fromEntries(
    Object.entries(definition.agents?.members ?? {}).map(([memberId, memberConfig]) => [
      memberId,
      {
        roles: collectMemberRoles(memberConfig),
      },
    ]),
  );

  const policy: TaskReportingPolicy = {
    version: "1",
    default_publisher: definition.reporting.default_publisher ?? null,
    members,
    sinks: {},
  };

  for (const sinkId of ["github", "linear"] as const) {
    const sink = definition.reporting.sinks?.[sinkId];
    if (!sink) continue;
    policy.sinks[sinkId] = {
      enabled: sink.enabled !== false,
      publisher_member:
        sink.publisher_member ?? definition.reporting.default_publisher ?? null,
      allowed_members: [...(sink.allowed_members ?? [])],
      allowed_roles: [...(sink.allowed_roles ?? [])],
      events: [...(sink.events ?? ALL_ACTIVITY_KINDS)],
      projection: (sink.projection ?? defaultProjectionForSink(sinkId)) as TaskReportingProjection,
      aggregate: (sink.aggregate ?? "latest") as TaskReportingAggregate,
    };
  }

  return policy;
}

export async function readTaskReportingPolicy(
  contextDir: string,
): Promise<TaskReportingPolicy | null> {
  const filePath = reportingPolicyPath(contextDir);
  const text = await Bun.file(filePath).text().catch(() => "");
  if (text.trim() === "") return null;
  return JSON.parse(text) as TaskReportingPolicy;
}

export function reportingPolicyPath(contextDir: string): string {
  return path.join(contextDir, "_task", "reporting.json");
}

export function selectSinkActivities(
  policy: TaskReportingPolicy | null,
  sinkId: TaskReportingSinkId,
  events: TaskActivityEvent[],
): TaskActivityEvent[] {
  if (policy === null) {
    return events.length > 0 ? [events[events.length - 1]!] : [];
  }

  const sink = policy.sinks[sinkId];
  if (!sink || !sink.enabled) {
    return [];
  }

  const filtered = events.filter((event) => {
    if (!sink.events.includes(event.kind)) {
      return false;
    }
    return isEmitterAllowed(policy, sink, event);
  });
  if (filtered.length === 0) {
    return [];
  }

  switch (sink.aggregate) {
    case "latest":
      return [filtered[filtered.length - 1]!];
    case "latest_per_phase":
      return latestPerPhase(filtered);
    case "summary":
      return [...filtered].sort((a, b) => b.ts - a.ts).slice(0, 5);
  }
}

function isEmitterAllowed(
  policy: TaskReportingPolicy,
  sink: TaskReportingSinkPolicy,
  event: TaskActivityEvent,
): boolean {
  const restrictByMember = sink.allowed_members.length > 0;
  const restrictByRole = sink.allowed_roles.length > 0;
  if (!restrictByMember && !restrictByRole) {
    return true;
  }

  if (!event.member_id) {
    return false;
  }
  if (sink.allowed_members.includes(event.member_id)) {
    return true;
  }
  const memberRoles = policy.members[event.member_id]?.roles ?? [];
  return memberRoles.some((role) => sink.allowed_roles.includes(role));
}

function latestPerPhase(events: TaskActivityEvent[]): TaskActivityEvent[] {
  const byPhase = new Map<string, TaskActivityEvent>();
  for (const event of events) {
    const key = event.phase?.trim() || "_default";
    const existing = byPhase.get(key);
    if (!existing || existing.ts <= event.ts) {
      byPhase.set(key, event);
    }
  }
  return [...byPhase.values()].sort((a, b) => b.ts - a.ts);
}

function defaultProjectionForSink(
  sinkId: TaskReportingSinkId,
): TaskReportingProjection {
  return sinkId === "github" ? "status_comment" : "comment";
}

export function toTaskActivityKinds(
  events: WorkflowReportingEvent[] | undefined,
): TaskActivityKind[] {
  return [...(events ?? ALL_ACTIVITY_KINDS)];
}

function collectMemberRoles(memberConfig: AgentMemberConfig): string[] {
  const roles = new Set<string>();
  if (memberConfig.role) {
    roles.add(memberConfig.role);
  }
  for (const role of memberConfig.roles ?? []) {
    roles.add(role);
  }
  return [...roles];
}
