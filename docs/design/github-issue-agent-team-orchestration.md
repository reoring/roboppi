# GitHub Issue-Scoped Agent Team Orchestration

Status: proposed

Related:
- `docs/design/task-orchestrator.md`
- `docs/design/agent-team-first-task-orchestration.md`
- `docs/design/issue-clarification-and-waiting-state.md`
- `docs/features/agents.md`
- `docs/features/agents-resident-lead-dynamic-members.md`

This document describes a GitHub-centric orchestration mode for Roboppi where:

1. A GitHub issue becomes the source of work.
2. Exactly one Roboppi issue instance is active for that issue at a time.
3. That instance runs a resident agent team for the lifetime of the issue work.
4. Progress, blockers, commits, and pushes are reported back into the same GitHub issue.

The intent is to turn a GitHub issue into both:

- the trigger for starting work
- the operator-facing status surface for ongoing work

without collapsing Roboppi into a GitHub-specific monolith.

---

## 1. Problem

The current Task Orchestrator can poll GitHub issues and launch a workflow, but
it is still fundamentally a one-shot execution model:

- detect issue
- launch a workflow run
- persist task/run state
- ack back to GitHub

That is useful for simple task dispatch, but it is not enough for the target
operating model:

- issue created -> a dedicated development instance starts
- that instance owns the issue until it is blocked, completed, or stopped
- the instance runs an agent team, not a single short-lived worker
- GitHub issue comments show ongoing progress, branch state, commits, and pushes
- operators can monitor the issue directly without opening Roboppi local state

The missing capability is therefore not just "another source type". It is a
resident, issue-scoped orchestration model with a GitHub activity bridge.

---

## 2. Goals and Non-goals

### 2.1 Goals

1. Start Roboppi work automatically when a GitHub issue enters a matching state.
2. Guarantee at most one active Roboppi instance per GitHub issue.
3. Run a resident agent team for the issue rather than only a short one-shot workflow.
4. Reflect instance progress back to the same GitHub issue in near real time.
5. Reflect commit and push activity back to the issue in a structured, low-noise way.
6. Reuse existing Roboppi layers where possible:
   - Task Orchestrator for task normalization and routing
   - Agents for team coordination
   - Workflow Executor for actual execution
   - Daemon-style resident process management for long-lived operation
7. Keep the GitHub integration outside Core.

### 2.2 Non-goals

- Requiring GitHub webhooks in v1. Polling is acceptable initially.
- Making every agent member push directly to the canonical remote branch.
- Full GitHub PR automation in the first slice.
- Replacing the file-backed Agents mailbox/task store with GitHub-native coordination.
- Solving cross-host distributed locking in v1.

---

## 3. Desired User Experience

Target happy path:

1. A new GitHub issue is opened with labels that match a Roboppi route.
2. The resident orchestrator notices it and creates an issue-scoped instance.
3. That instance prepares a dedicated workspace and starts an agent team.
4. The issue receives:
   - a "claimed by Roboppi" comment
   - an updatable status comment
   - milestone comments for major state changes
5. As the team works:
   - progress updates appear on the issue
   - blockers appear on the issue
   - commits and pushes are reported on the issue
6. When the work reaches a candidate end state:
   - the issue status comment shows `review_required`, `ready_to_land`, `blocked`, or `landed`
   - the local task registry remains the source of truth for detailed state

This gives the operator two complementary views:

- GitHub issue: concise operational status
- local `.roboppi-task`: detailed inspectable execution state

---

## 4. Key Design Decisions

### 4.1 This feature requires a resident runtime

The existing `runOnce()` model is not enough for this use case. A cron-triggered
one-shot orchestrator can start work, but it cannot itself be the long-lived
issue instance.

Therefore this feature introduces a resident mode above the existing Task
Orchestrator model:

- `run`: one-shot ingestion/dispatch
- `serve`: resident ingestion + issue instance supervision

Polling remains acceptable for ingress. The new requirement is not webhook
delivery but process lifetime.

### 4.2 One GitHub issue maps to one active Roboppi issue instance

The invariant is:

- at most one active instance per `repo#issue_number`

This is stronger than "one active task run" in the current one-shot model,
because the instance is long-lived and is expected to survive multiple internal
agent actions.

We will reuse the Task Registry as the canonical local coordinator for this
invariant, extending it with resident-instance metadata rather than introducing
a second independent registry.

### 4.3 The issue instance is a workflow run with a resident agent team

The system should not invent a second execution engine.

Instead:

- the issue instance is still represented by a task run
- the run uses a workflow template designed for resident agent-team execution
- the workflow uses existing Agents primitives for lead/teammate coordination
- the resident orchestrator supervises the workflow and its heartbeat

This preserves the existing layering:

- Task Orchestrator decides what to start
- Workflow Executor runs it
- Agents coordinates members inside it

### 4.4 GitHub issue comments are an operator surface, not the source of truth

GitHub comments are useful for visibility, but they are not reliable enough to
be the authoritative state machine.

Source of truth remains local:

- task state in `.roboppi-task`
- agent mailbox/task state in `context/_agents`
- workflow outputs in `context/_task`

GitHub receives a materialized projection of that state:

- status comment
- milestone comments
- progress comments
- push comments

### 4.5 Canonical remote branch ownership stays with the instance lead

Allowing every team member to commit and push directly to one shared remote
branch is high-risk and noisy.

The safer default is:

- one canonical issue branch per issue instance
- the lead/integrator member owns commits pushed to that canonical branch
- specialist members may use local/member worktrees, patches, or subordinate branches
- GitHub issue updates are emitted at the instance level, not per-member remote branch

This keeps "team works in parallel" without turning git history into a race.

---

## 5. Architecture Overview

```text
+------------------------------------------------------------------+
| Resident Task Orchestrator (serve mode)                          |
|  - poll GitHub issues                                            |
|  - dedupe + route                                                |
|  - enforce one active instance per issue                         |
|  - supervise issue instances                                     |
+----------------------------+-------------------------------------+
                             |
                             v
+------------------------------------------------------------------+
| Issue Instance Supervisor                                        |
|  - create/resume resident task run                               |
|  - heartbeat + lease management                                  |
|  - restart policy                                                 |
|  - shutdown on completion / operator stop                        |
+----------------------------+-------------------------------------+
                             |
                             v
+------------------------------------------------------------------+
| Issue Team Workflow                                              |
|  - dedicated issue worktree                                      |
|  - lead agent + dynamic teammates                                |
|  - shared mailbox + shared task list                             |
|  - emits activity events                                         |
+----------------------------+-------------------------------------+
               |                                   |
               v                                   v
+------------------------------+      +------------------------------+
| Agents Mailbox / Tasks       |      | Task Context / Activity      |
|  - member coordination       |      |  - _task/task.json           |
|  - task claim/complete       |      |  - _task/activity.jsonl      |
|  - inbox summary             |      |  - _task/landing.json        |
+------------------------------+      +------------------------------+
               \                                   /
                \                                 /
                 v                               v
+------------------------------------------------------------------+
| GitHub Activity Bridge                                            |
|  - coalesce local events                                          |
|  - update status comment                                          |
|  - append milestone / push comments                               |
|  - ingest operator comments (future slice)                        |
+------------------------------------------------------------------+
```

---

## 6. Major Components

### 6.1 GitHub Issue Ingress

This extends the existing `github_issue` source behavior.

Responsibilities:

- list candidate issues
- fetch normalized issue envelopes
- detect issue revisions
- feed task routing

Additional resident-mode behavior:

- treat issue creation/reopen/relabel as start/resume signals
- detect already-active local instances and avoid duplicate starts
- optionally ingest issue comments as operator messages in a later slice

Ingress modes:

- v1: polling via `gh api`
- later: webhook adapter that feeds the same normalized event shape

### 6.2 Resident Instance Registry

The current Task Registry already tracks:

- task lifecycle
- active run id
- run history

For issue-scoped resident instances, extend the active run record with:

- `execution_mode: "resident_issue_team"`
- `lease_owner_id`
- `lease_expires_at`
- `heartbeat_at`
- `team_id`
- `workspace_dir`
- `canonical_branch`
- `github.status_comment_id`
- `github.last_activity_at`
- `github.last_push_sha`

This lets the system keep "one issue = one active instance" without creating a
parallel registry concept.

### 6.3 Issue Instance Supervisor

New runner-owned component.

Responsibilities:

- start a routed issue workflow as a resident run
- renew the instance lease periodically
- detect stale/crashed instances
- decide resume vs restart
- stop the instance when task lifecycle becomes terminal

Suggested failure policy:

- if heartbeat is fresh: do not start another instance
- if heartbeat is stale and process is gone: reclaim the lease and start a new run
- always preserve run history; do not overwrite prior sessions

### 6.4 Issue Team Workflow

The workflow template for this mode is long-lived and issue-centric.

It should:

- bootstrap issue context
- create or reuse an issue-scoped worktree
- start a lead agent
- allow dynamic teammates
- create and track internal implementation tasks
- periodically emit progress summaries
- emit landing directives when reaching candidate completion states

The workflow is responsible for doing engineering work.
The resident orchestrator is responsible for process lifetime and external sync.

### 6.5 GitHub Activity Bridge

New adapter layer that turns local activity into GitHub issue updates.

Responsibilities:

- read local activity events
- maintain one updatable status comment
- append milestone comments for important transitions
- append push comments for canonical branch pushes
- suppress noise via throttling/coalescing

Important: the bridge does not decide what happened. It renders already-decided
local events onto GitHub.

### 6.6 Issue Activity Emitter

To avoid hard-coding GitHub logic into workflow steps, introduce a generic local
activity emission mechanism.

Suggested local interface:

- CLI:
  - `roboppi task-orchestrator activity emit ...`
- file:
  - append normalized JSON events to `context/_task/activity.jsonl`

Any workflow step or helper script can emit:

- progress updates
- blocker notices
- commit/push events
- review-needed markers
- human-input-needed markers

The GitHub bridge consumes this file and decides how to materialize it.

### 6.7 Operator Comment Ingestor

This is required for the full "GitHub issue as operator surface" story, but can
follow the initial resident runtime slice.

Responsibilities:

- detect new human comments on the issue
- normalize them into operator messages
- route them into the lead inbox or task context

Recommended model:

- non-command comments become lead mailbox messages
- explicit slash commands are parsed separately

Examples:

- `/roboppi status`
- `/roboppi pause`
- `/roboppi resume`
- `/roboppi retry`

---

## 7. State Model

### 7.1 Task lifecycle

Continue using the existing task lifecycle model:

- `queued`
- `preparing`
- `running`
- `waiting_for_input`
- `review_required`
- `blocked`
- `failed`
- `ready_to_land`
- `landed`
- `closed_without_landing`

### 7.2 Resident instance lifecycle

Add an instance/session-oriented substate on the active run:

- `starting`
- `active`
- `draining`
- `stopped`
- `stale`

This is operational metadata, not a replacement for task lifecycle.

### 7.3 GitHub projection state

The bridge maintains a projection state for rendering:

- `status_comment_id`
- `status_comment_revision`
- `last_rendered_lifecycle`
- `last_rendered_summary_hash`
- `last_rendered_push_sha`
- `last_seen_issue_comment_id`

This allows idempotent comment updates and restart-safe resume.

---

## 8. Data Model

### 8.1 Extended active run metadata

Suggested run metadata extension:

```json
{
  "execution_mode": "resident_issue_team",
  "lease_owner_id": "host:pid-or-instance-id",
  "lease_expires_at": 1710000000000,
  "heartbeat_at": 1710000000000,
  "team_id": "uuid",
  "workspace_dir": "/abs/path/to/worktree",
  "canonical_branch": "roboppi/issue/123",
  "github": {
    "status_comment_id": 1234567890,
    "last_activity_at": 1710000000000,
    "last_push_sha": "abc123"
  }
}
```

### 8.2 Issue activity event

Suggested normalized local event schema:

```json
{
  "version": "1",
  "ts": 1710000000000,
  "task_id": "github:issue:owner/repo#123",
  "run_id": "uuid",
  "kind": "progress",
  "member_id": "lead",
  "phase": "implement",
  "message": "Implementation phase started",
  "metadata": {
    "todo_completed": 3,
    "todo_total": 8
  }
}
```

Important kinds:

- `instance_started`
- `progress`
- `blocker`
- `waiting_for_input`
- `task_claimed`
- `task_completed`
- `commit_created`
- `push_completed`
- `review_required`
- `ready_to_land`
- `landed`

### 8.3 Status comment marker

Status comments should carry a machine-readable marker:

```html
<!-- roboppi:issue-status task_id=github:issue:owner/repo#123 run_id=<uuid> rev=7 -->
```

This allows:

- update-in-place behavior
- restart-safe lookup
- human-readable content with machine-readable identity

---

## 9. GitHub Comment Policy

GitHub issue comments can become noisy quickly, so the bridge needs explicit policy.

### 9.1 One updatable status comment

Maintain exactly one status comment per active issue instance.

It should include:

- current lifecycle
- current phase
- canonical branch
- latest push SHA
- active members
- latest summary timestamp
- current blocker or waiting reason when present

This comment is updated in place.

### 9.2 Append-only milestone comments

Append a new comment for important transitions only:

- instance claimed / started
- blocked
- waiting for human input
- review required
- ready to land
- landed
- instance stopped / resumed after crash

These comments form the historical audit trail visible on the issue.

### 9.3 Push comments

When the canonical branch is pushed:

- append a push comment with branch and SHA
- optionally include compare URL or PR URL if available

Suggested content:

```text
Roboppi pushed updates.

- Branch: `roboppi/issue/123`
- Commit: `abc1234`
- Summary: implemented parser and added unit tests
```

### 9.4 Coalescing rules

Recommended defaults:

- progress events: coalesce into status comment, not new comments
- push events: append comment, but suppress duplicates by SHA
- repeated blockers: update status comment, append a new comment only when the blocker meaning changes

---

## 10. Runtime Flows

### 10.1 Issue opened

1. GitHub issue ingress sees a matching issue.
2. Task Envelope is created or refreshed.
3. Router resolves the issue-team workflow.
4. Registry checks for an existing active resident run.
5. If none exists, supervisor creates a resident run and starts the workflow.
6. GitHub bridge posts:
   - claim/start milestone comment
   - initial status comment

### 10.2 Steady-state development

1. Lead agent creates internal tasks and may add dynamic teammates.
2. Agents mailbox/tasks evolve under `context/_agents`.
3. Workflow steps or helper scripts emit activity events.
4. Bridge coalesces those into the status comment.
5. Important transitions become milestone comments.

### 10.3 Commit and push

1. Canonical branch owner commits locally.
2. Push helper emits `commit_created` and `push_completed` events.
3. Bridge checks whether the pushed SHA is new.
4. If new, append one issue comment for the push and update status comment.

### 10.4 Human comments on the issue

Initial slice:

- comments are visible on GitHub but do not automatically enter the workflow

Follow-up slice:

1. comment ingestor detects new human comments
2. comment is normalized
3. lead inbox receives an operator message
4. status comment reflects `waiting_for_input` or a response when relevant

### 10.5 Crash and resume

1. Resident supervisor restarts.
2. Registry is scanned for resident runs with non-terminal lifecycle.
3. Fresh heartbeats are left alone.
4. Stale heartbeats are reclaimed.
5. Reclaimed issue instances are resumed or restarted according to policy.
6. GitHub receives a milestone comment only if an actual takeover/restart occurred.

---

## 11. Configuration Sketch

This should remain an extension of Task Orchestrator config, not a new unrelated format.

Example sketch:

```yaml
name: github-issue-teams
version: "1"
state_dir: ./.roboppi-task

runtime:
  mode: resident
  poll_every: "30s"
  lease_ttl: "5m"
  heartbeat_every: "30s"
  max_active_instances: 8

sources:
  github-main:
    type: github_issue
    repo: owner/repo
    labels: ["roboppi"]

routes:
  issue-team:
    when:
      source: github_issue
      repository: owner/repo
      labels_all: ["roboppi"]
    workflow: ./workflows/github-issue-team.yaml
    agents_files:
      - ./agents/github-issue-team.yaml
    workspace_mode: worktree
    branch_name: "roboppi/issue/{{task.slug}}"
    management:
      enabled: true

activity:
  github:
    enabled: true
    status_comment: update
    progress_comments: coalesce
    push_comments: append
    command_prefix: "/roboppi"
    push_comment_max_per_hour: 20

landing:
  mode: manual
```

Notes:

- `runtime.mode: resident` is the key new capability
- `activity.github` controls projection policy, not workflow execution
- the route still chooses workflow and worktree policy, preserving the existing model

---

## 12. Integration with Existing Roboppi Features

### 12.1 Task Orchestrator

Task Orchestrator remains the ingress and routing layer.

Changes:

- add resident `serve` mode
- extend registry/run metadata for leases/heartbeats
- add activity outbox support
- add GitHub projection bridge

### 12.2 Agents

Agents becomes the in-instance coordination substrate.

No conceptual change is needed:

- mailbox stays file-backed
- shared task list stays local
- resident lead and dynamic members are already aligned with this model

What changes is the outer lifetime:

- instead of "workflow-scoped team for one run only"
- we now intentionally use a long-lived, issue-scoped workflow run

### 12.3 Workflow Executor

Workflow Executor remains the execution engine.

Needed additions are small and generic:

- support long-lived issue-team workflow templates
- surface `ROBOPPI_TASK_*` context as today
- optionally expose a helper CLI for activity emission

### 12.4 Daemon / scheduler

The resident issue orchestrator is daemon-like in behavior.

The most natural implementation is:

- Task Orchestrator `serve` built on the existing daemon-style loop and supervision patterns

This avoids creating another bespoke always-on runtime.

---

## 13. Implementation Plan

### Phase 1: resident issue instances

Goal:

- one issue -> one active resident instance
- status comment projection

Scope:

- `task-orchestrator serve`
- lease/heartbeat metadata on active runs
- resident supervisor
- issue-team workflow template
- one updatable status comment
- start/stop milestone comments

No operator comment ingestion yet.
No per-push comments yet.

### Phase 2: activity bridge and push reporting

Goal:

- meaningful issue visibility during development

Scope:

- `activity emit` CLI or file outbox
- progress event coalescing
- blocker/waiting reporting
- commit/push event reporting
- canonical branch + latest SHA in status comment

### Phase 3: operator interaction via issue comments

Goal:

- GitHub issue becomes a real operator interface

Scope:

- comment ingestor
- slash commands
- lead inbox mirroring for human comments
- `waiting_for_input` transitions tied to operator replies

### Phase 4: richer team workspace strategies

Goal:

- safer parallel git behavior for larger teams

Scope:

- member sub-worktrees
- subordinate member branches
- lead integration flow
- richer PR/update flows

---

## 14. Risks and Open Questions

### 14.1 Resident workflows are qualitatively different from one-shot workflows

This is the biggest design shift. The system must treat resident issue-team runs
as first-class, restartable long-lived sessions.

### 14.2 GitHub comment noise can get out of control

Without explicit coalescing policy, the issue becomes unreadable. The bridge
must prefer:

- one mutable status comment
- append-only comments only for milestones and pushes

### 14.3 Resume semantics need to be explicit

On crash/restart, the system must define whether it:

- resumes the existing workflow session
- starts a fresh workflow run but preserves task history

The likely v1 answer is "start a fresh resident run after reclaim", because
true workflow checkpoint/resume is a larger problem.

### 14.4 Human comments need trust boundaries

If issue comments are ingested into the lead inbox, the system needs clear rules
for:

- who is allowed to issue control commands
- how to distinguish commands from ordinary discussion
- whether operator comments are treated as trusted instructions

### 14.5 Git push ownership must stay simple

If every member starts pushing directly, the design becomes much harder to make
predictable. The default should remain:

- one canonical branch
- one canonical remote push owner per issue instance

---

## 15. Acceptance Criteria

The design is successful when all of the following are true:

1. A matching GitHub issue can start a resident Roboppi issue instance automatically.
2. The system guarantees at most one active local instance per issue.
3. The issue instance runs a resident agent team, not just a one-shot worker.
4. The GitHub issue shows a persistent updatable status comment for the instance.
5. Major lifecycle transitions are visible as milestone comments on the issue.
6. Canonical branch pushes are reflected on the issue without duplicate spam.
7. Local task/run state remains the source of truth and survives restarts.
8. The architecture remains layered:
   - GitHub logic stays out of Core
   - Task Orchestrator still does routing/policy
   - Agents still handles intra-team coordination
   - Workflow Executor still performs execution

---

## 16. Summary

This design extends Roboppi from "task-triggered workflow dispatch" to
"issue-scoped resident agent teams".

The key move is not adding more GitHub-specific code to one-shot runs. It is
introducing a resident orchestration mode where:

- Task Orchestrator owns issue detection and instance uniqueness
- a resident workflow run owns the issue work
- Agents provides the team substrate
- GitHub receives a structured projection of progress and push activity

That gives a coherent path to the target behavior:

- issue created
- one instance starts
- the team works the issue
- GitHub stays updated as the operator-facing surface
