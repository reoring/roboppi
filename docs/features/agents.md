# Agents: Agent Teams With a File-Backed Mailbox (Design)

Status: proposed (design)

This document proposes a "Agents" feature for Roboppi: coordinated teams of
agentic worker sessions that can communicate via a reliable, file-backed
mailbox.

This is inspired by Claude Code "agent teams" (team lead + teammates + shared
task list + mailbox). Reference:

- https://code.claude.com/docs/en/agent-teams

Roboppi already supports running multiple workers (Claude Code / OpenCode /
Codex CLI / Custom) and supervising execution via Core permits. What is missing
today is a first-class, reliable coordination substrate that multiple agents can
use to:

- message each other directly (point-to-point and broadcast)
- coordinate work via a shared task list with race-free claiming
- shut down / clean up deterministically

The key design goal is to keep the underlying persistence "file mailbox" (so it
works locally without extra infrastructure), while providing Roboppi-side
mechanisms (Core/Runner services + model-facing tools) so that agents do not
need to implement filesystem locking protocols themselves.

---

## 1. Problem Statement

Roboppi workflows can already run steps concurrently, but each worker task is
largely isolated:

- there is no standard way to send structured messages between workers
- there is no shared task list abstraction (only the workflow DAG itself)
- coordination today is implicit ("write a file" or "print output"), which is
  brittle under concurrency and hard to observe

For "agent team" style work (parallel exploration + debate + integration), we
need a mailbox that is:

- reliable under multiple writers and multiple readers
- deterministic enough to debug (stable artifacts)
- secret-safe by default (no accidental leakage into logs)
- easy for models to use (a dedicated tool, not ad-hoc file edits)

---

## 2. Goals / Non-goals

### Goals

1. Provide a robust mailbox abstraction for inter-agent messaging.
2. Keep persistence file-backed (local FS), but hide locking/atomicity from
   agents behind Roboppi-provided tools.
3. Support:
   - message: agent -> agent
   - broadcast: agent -> all team members
   - notifications: idle / shutdown requests / plan approvals
4. Provide a shared task list with race-free claim/complete transitions.
5. Integrate with existing Roboppi layers:
   - Workflow runner and TUI (observability)
   - Core permits and cancellation (safety)
   - Worker adapters and capability gating (tool exposure)

### Non-goals (v1)

- Distributed (multi-host) agentss.
- Nested agentss (teammates spawning their own teams).
- Perfect prevention of edit conflicts in a shared repo. (We will provide
  best-practice and optional worktree automation, but do not attempt per-file
  locking in v1.)
- Full interactive multi-pane UI parity with Claude Code team split panes.

---

## 3. Architecture Overview

Agents introduces three cooperating pieces:

1. **Agent Coordinator (Runner-owned)**
   - Creates the team config + resources (task list + mailbox directories)
   - Spawns teammates as worker tasks (supervised via Core when enabled)
   - Bridges mailbox events into the existing `ExecEventSink` for TUI/logging

2. **Agent Store (file-backed, deterministic)**
   - Defines on-disk layout and atomic operations for:
     - messages
     - task state transitions
     - membership config
   - Uses file-system primitives (atomic rename + directory moves) to avoid
     multi-process write corruption.

3. **Agents Tools (model-facing)**
   - A constrained interface that agents use instead of editing mailbox files.
   - Exposed via:
     - a Roboppi CLI subcommand (`roboppi agents ...`), callable via a restricted
       `Bash(roboppi agents:*)` tool in Claude Code
     - optionally, a dedicated tool transport (future): MCP server

The Coordinator is responsible for lifecycle management (spawn/shutdown/cleanup).
The Store is responsible for correctness. Tools are responsible for usability and
capability gating.

### Layering and "Core" integration

Roboppi's design principle is mechanism/policy separation (see `docs/design.md`).
Agents is primarily policy-layer orchestration, but it needs a mechanism-grade
mailbox with correctness under concurrency. We therefore treat the Agent Store +
message/task operations as a "Core-adjacent" mechanism that:

- can be used by supervised Core runs (CoreIpcStepRunner)
- can also run in-process in the workflow runner for unsupervised runs

In practice:

- **Recommended**: Agents requires `--supervised` (CoreIpcStepRunner) so the
  Coordinator can cancel/timeout teammates safely and stream events into the TUI.
- **Fallback**: In unsupervised mode, Agents still works, but safety and
  observability are reduced.

---

## 4. Disk Layout (File Mailbox + Task Store)

Agents resources are stored under the workflow `context_dir` so that:

- state is per-workflow-run (cleanly isolated)
- artifacts are inspectable and auditable
- cleanup is deterministic (delete the context dir)

Directory root:

```
<context_dir>/_agents/
  team.json
  members.json
  mailbox/
    inbox/<memberId>/{new,processing,cur,dead}/
    tmp/
    sent/<memberId>/
    _events.jsonl
  tasks/
    pending/
    in_progress/
    completed/
    blocked/
    superseded/
    tmp/
    _events.jsonl
  locks/
    (optional lock files)
```

This layout is inspired by "maildir" semantics:

- a sender delivers by atomically moving a file into `inbox/<id>/new/`
- a receiver claims by atomically moving into `processing/`
- a receiver acks by atomically moving into `cur/`

This avoids shared-file append races and works across multiple processes.

### 4.1 Team config files

`team.json`:

```json
{
  "version": "1",
  "team_id": "uuid",
  "name": "my-team",
  "created_at": 1710000000000,
  "context_dir": "/abs/path/to/context",
  "lead_member_id": "lead",
  "cleanup_policy": {
    "retain_mailbox": false,
    "retain_tasks": true
  }
}
```

`members.json`:

```json
{
  "version": "1",
  "members": [
    {
      "member_id": "lead",
      "name": "Lead",
      "role": "team_lead",
      "worker": { "kind": "CLAUDE_CODE", "model": "sonnet" },
      "capabilities": ["READ", "EDIT", "RUN_TESTS"],
      "workspace": "/abs/path/to/worktree/lead"
    },
    {
      "member_id": "researcher",
      "name": "Research",
      "role": "research",
      "worker": { "kind": "OPENCODE" },
      "capabilities": ["READ"],
      "workspace": "/abs/path/to/worktree/researcher"
    }
  ]
}
```

Notes:

- `members.json` is the authoritative source of membership (similar to Claude's
  team config containing a `members` array).
- Teammates can discover other teammates by reading `members.json`.

### 4.2 Message files

Message filename format (lexicographically sortable):

```
<ts_ms>-<msg_id>.json
```

Message schema:

```json
{
  "version": "1",
  "team_id": "uuid",
  "message_id": "uuid",
  "ts": 1710000000000,
  "from": { "member_id": "researcher", "name": "Research" },
  "to": { "type": "member", "member_id": "lead" },
  "kind": "text",
  "topic": "findings",
  "body": "I found...",
  "correlation_id": "uuid-or-null",
  "reply_to": "message_id-or-null",
  "metadata": {
    "severity": "info"
  }
}
```

Supported `to` values:

- `{ "type": "member", "member_id": "..." }`
- `{ "type": "broadcast" }`

Supported `kind` values (extensible):

- `text`
- `task_update`
- `idle`
- `shutdown_request`
- `shutdown_ack`
- `plan_request`
- `plan_approved`
- `plan_rejected`

### 4.3 Task files

Each task is a single JSON file, moved between status directories.

Task schema:

```json
{
  "version": "1",
  "task_id": "uuid",
  "title": "Review authentication module",
  "description": "Focus on token handling, session management...",
  "status": "pending",
  "depends_on": ["uuid"],
  "created_at": 1710000000000,
  "updated_at": 1710000000000,
  "assigned_to": null,
  "claimed_by": null,
  "claimed_at": null,
  "completed_at": null,
  "artifacts": [],
  "tags": ["security"],
  "requires_plan_approval": false
}
```

Task transitions are represented by moving the file:

- `pending/<taskId>.json` -> `in_progress/<taskId>.json`
- `in_progress/<taskId>.json` -> `completed/<taskId>.json`
- `pending|in_progress|blocked/<taskId>.json` -> `superseded/<taskId>.json`

Blocked tasks can be stored in `blocked/` to make discovery fast, and stale coordination tasks can be moved to `superseded/` to preserve audit history without leaving them claimable.

### 4.4 Event logs

Mailbox and task operations SHOULD emit append-only event logs for debugging and
audit. These logs MUST be safe by default.

`_agents/mailbox/_events.jsonl` (metadata only by default):

```json
{ "ts": 1710000000000, "type": "message_delivered", "message_id": "...", "from": "researcher", "to": "lead", "topic": "findings" }
{ "ts": 1710000001000, "type": "message_claimed", "message_id": "...", "by": "lead" }
{ "ts": 1710000002000, "type": "message_acked", "message_id": "...", "by": "lead" }
```

`_agents/tasks/_events.jsonl`:

```json
{ "ts": 1710000000000, "type": "task_added", "task_id": "...", "title": "..." }
{ "ts": 1710000005000, "type": "task_claimed", "task_id": "...", "by": "researcher" }
{ "ts": 1710000010000, "type": "task_completed", "task_id": "...", "by": "researcher" }
{ "ts": 1710000015000, "type": "task_superseded", "task_id": "...", "by": "lead", "reason": "stale contract" }
```

The full message body SHOULD NOT be copied into `_events.jsonl` unless explicitly
enabled, to reduce accidental leakage.

---

## 5. Atomicity and Concurrency Semantics

### 5.1 Why "directory moves" instead of JSONL append

Appending to a shared JSONL file from multiple processes can corrupt output if
writes interleave. A maildir-style store avoids this by ensuring each message is
written exactly once as its own file and then atomically moved into place.

This yields:

- atomic deliver (rename into inbox)
- atomic claim (rename into processing)
- atomic ack (rename into cur)

All operations are implementable with standard Node/Bun FS operations.

### 5.2 Delivery semantics

We aim for **at-least-once delivery** with explicit ack, and an implementation
that is deterministic to recover after crashes.

Definitions:

- Delivered: message file exists in recipient `new/`.
- Claimed: moved to recipient `processing/`.
- Acked: moved to recipient `cur/`.

If an agent crashes after claiming but before acking, messages may be stuck in
`processing/`. The Coordinator MUST periodically requeue stale processing files
by moving them back to `new/` (with a bounded retry count) or into `dead/`.

### 5.3 Task claim semantics

Claiming is race-free by construction:

- the claimant attempts `rename(pending/<id>.json, in_progress/<id>.json)`
- only one process can succeed

Completing is also race-free:

- `rename(in_progress/<id>.json, completed/<id>.json)`

If tasks have dependencies:

- the Coordinator (or tool) SHOULD refuse claim when dependencies are not
  completed
- if a race causes an invalid claim, the Coordinator MAY move the task back to
  `blocked/` and notify the claimant

### 5.4 Housekeeping and crash recovery

The Store MUST be recoverable after crashes.

Messages:

- If a message remains in `processing/` beyond a TTL (e.g. 10 minutes), it is
  considered stale.
- Housekeeping requeues stale messages by moving them back to `new/`.
- To avoid infinite loops, the housekeeping process SHOULD increment a
  `delivery_attempt` counter by rewriting the JSON body (atomic replace) or by
  encoding attempt count in the filename. After `max_attempts`, the message MUST
  be moved to `dead/` and a warning emitted.

Tasks:

- If a task remains in `in_progress/` beyond a TTL, the Coordinator MAY mark it
  as orphaned and move it back to `pending/` (or to a dedicated `orphaned/`
  directory) after notifying the lead.

Housekeeping triggers:

- periodic timer in the Agent Coordinator
- explicit CLI: `roboppi agents housekeep --context <dir>`

---

## 6. Model-Facing Tooling

Agents should not manipulate `_agents/` files directly. Instead, Roboppi exposes
Agents operations as a tool.

### 6.1 CLI tool surface (v1)

Add a `roboppi agents` CLI group:

- `roboppi agents init --context <dir> --team <name>`
- `roboppi agents members list --context <dir>`
- `roboppi agents message send --context <dir> --from <memberId> --to <memberId> --topic <t> --body <text>`
- `roboppi agents message broadcast --context <dir> --from <memberId> --topic <t> --body <text>`
- `roboppi agents message recv --context <dir> --for <memberId> [--claim] [--max N] [--wait-ms M]`
- `roboppi agents message ack --context <dir> --for <memberId> --message-id <uuid>`

- `roboppi agents tasks add --context <dir> --title ... --description ... [--depends-on ...]`
- `roboppi agents tasks list --context <dir> [--status pending|in_progress|completed|blocked|superseded]`
- `roboppi agents tasks claim --context <dir> --task-id <uuid> --member <memberId>`
- `roboppi agents tasks complete --context <dir> --task-id <uuid> --member <memberId> [--artifact <path>]`
- `roboppi agents tasks supersede --context <dir> --task-id <uuid> --member <memberId> [--reason <text>] [--replacement-task-id <uuid>]`

Return values MUST be JSON so workers can parse them reliably.

Example send output:

```json
{ "ok": true, "message_id": "...", "delivered": ["lead"] }
```

Example recv output:

```json
{
  "ok": true,
  "messages": [
    {
      "message_id": "...",
      "from": "researcher",
      "topic": "findings",
      "body": "...",
      "claim": { "token": "<opaque>", "expires_at": 1710000600000 }
    }
  ]
}
```

Ack SHOULD use the claim token rather than scanning directories for message ids:

```
roboppi agents message ack --context <dir> --for lead --claim-token <opaque>
```

### 6.1.1 Tool correctness requirements

The CLI tools MUST:

- create missing directories lazily (idempotent)
- validate `memberId` against `members.json`
- bound inputs:
  - max message size (e.g. 64KB)
  - max task file size (e.g. 256KB)
- use atomic write patterns:
  - write temp file under `tmp/`
  - `rename()` into final location
- never partially overwrite a visible message/task file

### 6.1.2 Task state mutation

Because tasks must update fields (`claimed_by`, timestamps, etc.), the tool MUST
rewrite the JSON on transitions. Recommended algorithm (claim):

1. `rename(pending/<id>.json, in_progress/<id>.json)` (wins the race)
2. read `in_progress/<id>.json`
3. write updated JSON to `tasks/tmp/<id>.<uuid>.json`
4. `rename(tasks/tmp/<id>.<uuid>.json, in_progress/<id>.json)` (atomic replace)

Completing uses the same pattern, replacing the file in `completed/`.

### 6.2 Exposing the CLI as a restricted tool (Claude Code)

Claude Code supports limiting command execution via tool allowlists.
Roboppi should add a new capability that maps to a constrained Bash tool:

- New `WorkerCapability`: `MAILBOX` (and optionally `TASKS`)
- In `src/worker/adapters/claude-code-adapter.ts`, map `MAILBOX` to
  `Bash(roboppi agents:*)` (or `Bash(roboppi mailbox:*)`)

This allows a teammate to message without granting full `Bash`.

Implementation note:

- Keep the command surface narrow so it can be safely allowlisted.
- Prefer `roboppi agents message ...` subcommands that accept structured JSON via
  stdin (`--json-stdin`) to avoid quoting errors.

### 6.3 MCP server

For better ergonomics (no shell quoting, richer schemas), `roboppi agents mcp`
exposes a stdio MCP server with tools:

- `agents_send_message`
- `agents_broadcast`
- `agents_recv`
- `agents_ack`
- `agents_list_members`
- `agents_tasks_list`
- `agents_tasks_claim`
- `agents_tasks_complete`
- `agents_tasks_supersede`
- `agents_status_get`
- `agents_status_set`
- `agents_specialist_activate`
- `agents_specialist_deactivate`

Teammate sessions (Claude Code) already load MCP servers as part of context.
This aligns with the Claude agent teams note that teammates "load the same
project context ... MCP servers".

---

## 7. Spawning and Lifecycle

### 7.1 Team creation

The Coordinator creates `_agents/` directories and writes `team.json` +
`members.json` before any teammate starts.

### 7.2 Teammate processes

Teammates are standard Roboppi worker tasks with additional environment:

- `ROBOPPI_AGENTS_CONTEXT_DIR=<context_dir>`
- `ROBOPPI_AGENTS_TEAM_ID=<team_id>`
- `ROBOPPI_AGENTS_MEMBER_ID=<member_id>`
- `ROBOPPI_AGENTS_MEMBERS_FILE=<context_dir>/_agents/members.json`

Each teammate runs a long-lived prompt (single worker task with many turns)
whose job is:

1. claim tasks
2. do work
3. send messages
4. wait for new messages/tasks

This approximates Claude's "independent context window" property: the teammate
process can maintain its own context across multiple mailbox interactions within
its own run budget.

Coordinator responsibilities while teammates run:

- optionally create a periodic "heartbeat" task/message so idle teammates can
  prove liveness
- run housekeeping (requeue stale processing messages, detect orphaned tasks)
- surface mailbox activity to the TUI

### 7.3 Idle notifications

When a teammate has no claimable tasks and no messages to act on, it SHOULD send
an `idle` message to the lead.

### 7.4 Shutdown and cleanup

To end an agents deterministically:

1. Lead sends `shutdown_request` to each teammate.
2. Teammates respond with `shutdown_ack` and exit.
3. Coordinator verifies no teammates are running.
4. Coordinator runs cleanup:
   - optionally delete `mailbox/` and/or `tasks/`
   - always write a final `_events.jsonl` entry documenting cleanup

This mirrors the Claude guidance: "Always use the lead to clean up".

---

## 8. Workflow DSL Integration (Optional)

Agents can be used in workflows in two ways.

### 8.1 Agents as a top-level workflow feature

Add optional `agents:` config to `WorkflowDefinition`:

```yaml
agents:
  enabled: true
  team_name: "my-team"
  members:
    lead:
      agent: lead
    researcher:
      agent: research
    reviewer:
      agent: reviewer
  tasks:
    - title: "Investigate failure"
      description: "Look at logs and propose hypotheses"
      assigned_to: researcher
```

The runner creates the team at workflow start and tears it down at workflow end.

### 8.2 Agents as an explicit step

Add a new step type (discriminated union at some future refactor):

- `agents:` step that runs the Coordinator as a step, and completes when tasks
  are all completed.

This keeps Agents opt-in and contained.

### 8.3 Workspace isolation (recommended)

Two teammates editing the same files can conflict. To reduce this, Agents SHOULD
support (optionally) creating a git worktree per teammate:

- `<context_dir>/_agents/worktrees/<memberId>/`

Each teammate's `workspace` in `members.json` points to its own worktree.

This aligns with the Claude guidance to avoid file conflicts and is a practical
way to enable true parallel work.

---

## 9. Observability

Agents MUST be observable through existing mechanisms:

- Append-only event logs:
  - `_agents/mailbox/_events.jsonl`
  - `_agents/tasks/_events.jsonl`
- Optional `ExecEventSink` events (TUI):
  - `agent_message_sent`
  - `agent_message_received`
  - `agent_task_claimed`
  - `agent_task_completed`

The Coordinator is responsible for emitting these events so that:

- the workflow TUI can show team activity
- postmortems can be done from context artifacts

### 9.1 "Automatic delivery" for the lead

Claude agent teams emphasize that the lead does not need to poll for teammate
messages. Roboppi should provide the same UX in TUI mode:

- the Coordinator watches inbox directories (or periodically scans)
- on new messages, it emits an `ExecEvent` immediately
- the TUI surfaces a notification and allows inspecting the message metadata

Additionally, a **runner-owned `LeadInboxBroker`** continuously consumes the
lead's mailbox during workflow execution and maintains a bounded, secret-safe
summary artifact at `_agents/inbox-summary.json`.  The lead can also
**dynamically change team membership** via `roboppi agents members set|upsert|remove`
during execution, with the coordinator reconciling desired state.
See `docs/features/agents-resident-lead-dynamic-members.md` for details.

---

## 10. Security and Safety

### 10.1 Secret safety

- Messages and tasks are stored on disk. By default, Agents MUST treat message
  bodies as potentially sensitive and avoid copying them into higher-level logs.
- Event logs SHOULD record metadata (ids, timestamps, from/to, topic) but not
  full bodies unless explicitly enabled.

### 10.2 Path traversal

- All tool commands that accept paths MUST validate they stay within
  `<context_dir>/_agents`.

### 10.3 Capability gating

- Message/task tools MUST be separately gateable from `RUN_COMMANDS`.
- For Claude Code, prefer allowing only `roboppi agents:*` rather than full bash.

### 10.4 Identity and spoofing (local trust model)

Agents is designed for local, same-user processes. We assume cooperative agents,
not adversarial isolation. However, the tool SHOULD reduce accidental spoofing:

- default `--from` to `ROBOPPI_AGENTS_MEMBER_ID`
- validate `--from` exists in `members.json`
- optionally require a per-member token file readable only by the current user
  (best-effort)

---

## 11. Testing Strategy

1. Unit tests (file store semantics):
   - message send -> appears in inbox/new
   - recv claim -> moves to processing
   - ack -> moves to cur
   - requeue stale processing -> returns to new
   - broadcast -> delivers to N recipients

2. Concurrency tests:
   - N parallel senders deliver to one inbox without corruption
   - N claimers contend for one task; exactly one wins

3. Integration tests (supervised mode):
   - spawn two CUSTOM worker steps that message each other using `roboppi agents`
   - verify TUI/ExecEvent events are emitted (or at least files exist)

---

## 12. Limitations and Future Work

Known limitations (aligned with Claude agent teams limitations):

- Agents state is local; resumption/replay semantics are not guaranteed in v1.
- Task status can lag if a teammate crashes; Coordinator must provide requeue.
- Shutdown may be slow because teammates finish their current tool call.

Future work:

1. MCP tool transport for richer tool calls.
2. Optional automatic git worktree creation per teammate to reduce conflicts.
3. Plan approval mode for risky tasks (spawn teammate read-only, then restart
   with write permissions after approval).
4. TUI affordances for selecting a teammate and sending direct messages.
