import path from "node:path";
import type {
  WorkflowDefinition,
  AgentMemberConfig,
} from "../workflow/types.js";
import type {
  TaskIntentKind,
  TaskIntentPolicy,
} from "./types.js";

export interface TaskIntentAuthorizationResult {
  accepted: boolean;
  memberRoles: string[];
  rejectionReason?: string;
}

export function buildTaskIntentPolicy(
  definition: WorkflowDefinition,
): TaskIntentPolicy | null {
  if (!definition.task_policy) return null;

  const members = Object.fromEntries(
    Object.entries(definition.agents?.members ?? {}).map(([memberId, memberConfig]) => [
      memberId,
      {
        roles: collectMemberRoles(memberConfig),
      },
    ]),
  );

  const intents = Object.fromEntries(
    Object.entries(definition.task_policy.intents ?? {}).map(([kind, rule]) => [
      kind,
      {
        allowed_members: [...(rule?.allowed_members ?? [])],
        allowed_roles: [...(rule?.allowed_roles ?? [])],
      },
    ]),
  ) as TaskIntentPolicy["intents"];

  return {
    version: "1",
    members,
    intents,
  };
}

export async function readTaskIntentPolicy(
  contextDir: string,
): Promise<TaskIntentPolicy | null> {
  const filePath = taskIntentPolicyPath(contextDir);
  const text = await Bun.file(filePath).text().catch(() => "");
  if (text.trim() === "") return null;
  return JSON.parse(text) as TaskIntentPolicy;
}

export function taskIntentPolicyPath(contextDir: string): string {
  return path.join(contextDir, "_task", "task-policy.json");
}

export function authorizeTaskIntentMember(
  policy: TaskIntentPolicy | null,
  kind: TaskIntentKind,
  memberId: string,
): TaskIntentAuthorizationResult {
  if (policy === null) {
    return { accepted: true, memberRoles: [] };
  }

  const member = policy.members[memberId];
  if (!member) {
    return {
      accepted: false,
      memberRoles: [],
      rejectionReason: `member "${memberId}" is not declared in task policy`,
    };
  }

  const rule = policy.intents[kind];
  if (!rule) {
    return {
      accepted: false,
      memberRoles: member.roles,
      rejectionReason: `intent "${kind}" is not enabled by task policy`,
    };
  }

  const restrictByMember = rule.allowed_members.length > 0;
  const restrictByRole = rule.allowed_roles.length > 0;
  if (!restrictByMember && !restrictByRole) {
    return {
      accepted: true,
      memberRoles: member.roles,
    };
  }

  if (rule.allowed_members.includes(memberId)) {
    return {
      accepted: true,
      memberRoles: member.roles,
    };
  }
  if (member.roles.some((role) => rule.allowed_roles.includes(role))) {
    return {
      accepted: true,
      memberRoles: member.roles,
    };
  }

  return {
    accepted: false,
    memberRoles: member.roles,
    rejectionReason:
      `member "${memberId}" is not authorized for intent "${kind}"`,
  };
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
