# Agents: Resident Lead Inbox + Dynamic Members (Workflow-Scoped)

Status: implemented

Related:
- Issue 21: "Agents: make lead a persistent inbox actor (auto-consume messages)"
- `docs/features/agents.md`

This document extends the Agents design with two capabilities:

1) A runner-owned **resident lead inbox broker** that continuously consumes the lead's mailbox and maintains a stable "latest agents context" artifact.
2) **Dynamic team membership** during a workflow run, driven by a file-backed desired-state config and reconciled by the runner.

This design intentionally keeps these behaviors **workflow-scoped** (only while a workflow is executing).

---

## 1. Problem

Agents teammates can be long-lived workers that continuously send findings to the lead. Today, the lead (the workflow itself) is not a resident actor, so receiving/triaging messages requires embedding explicit polling into step prompts (brittle, easy to forget).

Additionally, some workflows need to **change the team** based on runtime evidence (e.g. spawn a k8s-focused investigator when cluster-level symptoms appear). We want to allow the lead to do this directly, even if it is operationally risky.

---

## 2. Goals / Non-goals

Goals:
- With Agents enabled, lead inbox messages are processed even when no lead step is currently executing.
- Provide a stable artifact under `context_dir` for "latest agents context".
- Allow the lead to modify team membership during workflow execution via `roboppi agents members ...`.
- Deterministic shutdown: broker + dynamically spawned teammates stop cleanly when the workflow ends.

Non-goals (v1 of this doc):
- LLM-based triage/decision making for inbox messages (no automatic management hook trigger).
- Cross-workflow persistence (daemon-style always-on lead/teammates).
- Distributed agents across multiple hosts.

---

## 3. Architecture Overview

We introduce two runner-owned components and one store/CLI extension.

### 3.1 LeadInboxBroker (runner-owned)

New component:
- `LeadInboxBroker` (suggested path: `src/agents/lead-inbox-broker.ts`)

Responsibilities:
- Poll/consume the lead's mailbox using Agent Store primitives (`recvMessages` + claim tokens + ack).
- Update a bounded, secret-safe summary artifact.
- Optionally emit lightweight `ExecEventSink` warnings/notifications when new actionable messages arrive.

Key property:
- It is runner-owned and runs independently of step execution, so the lead behaves like a resident actor for inbox processing.

### 3.2 Dynamic membership reconcile loop (runner-owned)

Extend `AgentCoordinator` (or add a `AgentsTeamController`) to reconcile "desired members" from disk:

- The lead updates desired membership via CLI (see 3.3).
- The coordinator periodically reads desired state and applies diffs:
  - spawn missing teammates
  - request shutdown for removed teammates

This keeps process management centralized and ensures deterministic workflow shutdown.

### 3.3 CLI + store extensions for membership mutation

Extend the Agents CLI (`src/agents/cli.ts`) with membership mutation commands that update the desired-state file atomically.

The lead can call these commands directly (danger accepted) to reshape the team at runtime.

---

## 4. Disk Artifacts

### 4.1 Lead inbox summary artifact

New stable artifact:

- `context/_agents/inbox-summary.json`

Design constraints:
- Bounded size (both message count and per-entry size).
- Secret-safe by default: do not copy full message bodies.
- Provide pointers so a lead step can open the original message file if needed.

Suggested schema:

```json
{
  "version": "1",
  "team_id": "uuid",
  "lead_member_id": "lead",
  "updated_at": 1710000000000,
  "unread_count": 3,
  "entries": [
    {
      "message_id": "uuid",
      "ts": 1710000000000,
      "from": "researcher",
      "topic": "findings",
      "kind": "text",
      "body_preview": "First 200 bytes...",
      "mailbox_path": "_agents/mailbox/inbox/lead/cur/<ts>-<id>.json"
    }
  ]
}
```

Notes:
- `mailbox_path` is workspace-relative (context-relative) so it can be opened via READ.
- `body_preview` is optional; if present, it MUST be short and safe.

### 4.2 Desired membership state

We need a runner-readable desired-state file that the lead can update.

Option (preferred): extend `_agents/members.json` entries with an optional `agent` field.

- Existing type: `src/agents/types.ts` `MemberEntry`
- Proposed addition: `agent?: string` (agent catalog id)

This keeps one canonical membership file and avoids adding another config file.

---

## 5. Runtime Flows

### 5.1 Workflow start

When `agents.enabled: true`:
- `WorkflowExecutor` initializes agents context (`initAgentsContext`) and starts `AgentCoordinator`.
- `WorkflowExecutor` starts `LeadInboxBroker` with the resolved `contextDir`, `teamId`, and `leadMemberId`.

### 5.2 Inbox consumption loop

The broker loops until workflow abort/shutdown:

1) `recvMessages({ memberId: leadMemberId, claim: true, max: N })`
2) For each claimed message:
   - append/update `inbox-summary.json`
   - `ackMessageByClaimToken(...)`
3) Sleep (poll interval) and repeat

Backpressure defaults:
- `N` small (e.g. 10)
- poll interval small but bounded (e.g. 1-2s)
- summary bounded (e.g. keep last 100 entries; truncate previews)

Crash/interrupt safety:
- Claimed-but-not-acked messages remain in `processing/` and will be requeued by existing housekeeping.

### 5.3 Dynamic membership mutation

The lead updates desired membership by writing to the Agent Store via CLI.

Example (conceptual):
- `roboppi agents members upsert --member k8s --agent k8s-investigator`

Coordinator reconciliation loop:
- On an interval (e.g. 2s), read desired membership from disk.
- Compute diff against currently running teammate handles.
- Apply:
  - spawn: create `_agent:<memberId>` long-lived worker task
  - remove: send `shutdown_request` message and then abort after a wait

Determinism:
- Reconcile is idempotent.
- Member ordering is deterministic (sort by `member_id`).

---

## 6. CLI Surface (Additions)

Add new subcommands under `roboppi agents members`:

- `roboppi agents members set --context <dir> --json-stdin`
  - Replaces the full desired member list (atomic).

- `roboppi agents members upsert --context <dir> --member <id> --agent <agentId> [--name <n>] [--role <r>]`
  - Adds or updates a member entry.

- `roboppi agents members remove --context <dir> --member <id>`
  - Removes a member entry.

Behavior constraints:
- All stdout remains JSON-only.
- Member mutation is restricted to the lead identity by default:
  - compare `team.json.lead_member_id` and `ROBOPPI_AGENTS_MEMBER_ID`
  - if mismatch: error

---

## 7. Safety and Guardrails (Explicitly Risky Feature)

Dynamic membership is operationally risky (can spawn many long-lived workers with `RUN_COMMANDS`). We still add a few guardrails to prevent accidental runaway:

- Explicit opt-in (recommended): `agents.dynamic_members.enabled: true` (DSL extension) OR env flag `ROBOPPI_AGENTS_DYNAMIC_MEMBERS=1`.
- Hard caps:
  - `max_teammates` (default small)
  - spawn rate limit (e.g. N per minute)
- Deterministic shutdown always wins:
  - on workflow end, coordinator stops all teammates regardless of desired state

---

## 8. Acceptance Criteria

- With `agents.enabled: true`, teammate messages to the lead are consumed without embedding `roboppi agents message recv ...` into step prompts.
- `context/_agents/inbox-summary.json` exists and is updated as messages arrive.
- Lead can modify team membership during workflow execution via `roboppi agents members ...`.
- Coordinator spawns/removes teammates to match desired state within a bounded time.
- Workflow shutdown stops broker + teammates deterministically.

---

## 9. Testing Strategy

Unit:
- LeadInboxBroker summarization bounds (max entries, preview truncation).
- Broker claim/ack behavior (ack by claim token).
- Store writes for membership mutation are atomic.

Integration:
- Spawn agents with 1 teammate, send messages, verify summary artifact updates without lead polling.
- During run, mutate membership to add/remove a teammate; verify coordinator spawns/stops.
- Shutdown behavior: workflow end stops broker and all teammates; no lingering timers.

---

## 10. Implementation Notes (Where Changes Landed)

Touch points:
- `src/agents/lead-inbox-broker.ts`: new `LeadInboxBroker` class — runner-owned, polls lead inbox via claim+ack, writes bounded `inbox-summary.json`.
- `src/workflow/executor.ts`: starts/stops `LeadInboxBroker` alongside `AgentCoordinator`; writes `MemberEntry.agent` from `WorkflowDefinition.agents.members`.
- `src/agents/coordinator.ts`: reconcile loop periodically reads desired membership from `members.json`, spawns missing non-lead members, shuts down removed members; runaway guards (max teammates cap + spawn rate limit).
- `src/agents/store.ts`: atomic membership mutation helpers — `writeMembersConfig()`, `upsertMember()`, `removeMember()`.
- `src/agents/cli.ts`: new `members set|upsert|remove` subcommands with lead identity restriction.
- `src/agents/types.ts`: `MemberEntry.agent?: string` for desired-state membership.
- `src/agents/paths.ts`: `inboxSummaryPath()` for `_agents/inbox-summary.json`.
- `src/agents/constants.ts`: broker and reconcile defaults (poll intervals, summary bounds, max teammates, spawn rate limit).

Core (`src/core/*`) remains unchanged: Agents is runner-owned policy orchestration built on mechanism-grade file operations.
