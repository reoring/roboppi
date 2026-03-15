# Task-Oriented Orchestration Design

**A task-driven control plane above Roboppi workflows**

Related:
- `docs/design/github-issue-agent-team-orchestration.md`
- `docs/design/agent-team-first-task-orchestration.md`
- `docs/design/issue-clarification-and-waiting-state.md`

---

## 1. Background and Goals

Roboppi already provides strong execution-control primitives:

- Core-level safety invariants around budgets, cancellation, and worker isolation
- YAML workflows for deterministic multi-step execution
- Daemon mode for long-running, event-driven automation
- Agents for mailbox-based coordination and shared task handling
- Workflow management hooks for runtime adaptation

What Roboppi does **not** provide yet is a first-class way to operate from
an external task system such as GitHub Issues, GitHub PR comments, Linear
issues, or an internal queue of engineering requests.

In practice, many real automation loops are not started by hand from a local
workflow YAML. They start from a task:

- "Implement issue #123"
- "Investigate a flaky test report"
- "Review and land a ready PR"
- "Handle a backlog item matching this label"

This design introduces a **Task Orchestrator**: a higher-level control plane
that converts external tasks into Roboppi workflow executions, tracks their
lifecycle, and records the evidence needed to decide whether the task is done,
blocked, or ready to land.

### 1.1 Design intent

The Task Orchestrator is intentionally **not** a replacement for:

- Core
- Workflow Executor
- Daemon
- Agents

Instead, it is a thin policy layer that sits **above** them.

Roboppi should remain an execution-control runtime first. Task-driven operation
should be implemented by composing existing layers, not by collapsing all
responsibilities into a single always-on agent process.

### 1.2 Problems addressed

| Problem | Approach |
|---|---|
| Workflows must be started manually or via low-level triggers | Introduce task sources and dispatch rules |
| External work items have no first-class lifecycle inside Roboppi | Add a canonical Task Envelope and Task Run state model |
| Different task types need different execution flows | Map task classes to workflow templates and agent teams |
| It is hard to decide when a task is truly done | Standardize evidence capture and completion gates |
| Repo-isolated execution is repetitive and error-prone | Add worktree/branch management as an explicit subsystem |
| Long-running automation lacks an operator-facing task view | Track task state independently of individual workflow runs |

---

## 2. Goals and Non-goals

### 2.1 Goals

1. Allow Roboppi to operate from external task systems, not only direct CLI or
   YAML invocation.
2. Represent external tasks in a normalized, source-agnostic format.
3. Route tasks to the correct workflow template, workspace strategy, and agent
   configuration.
4. Persist task lifecycle state across multiple workflow runs.
5. Capture structured evidence for review, retry, escalation, and landing.
6. Reuse existing Roboppi mechanisms wherever possible.
7. Preserve mechanism/policy separation:
   - Core remains the final authority for safety.
   - Workflow Executor remains the execution engine.
   - Task Orchestrator remains a policy/control layer.

### 2.2 Non-goals

- Replacing workflow YAML with a fully dynamic planner.
- Embedding GitHub- or Linear-specific logic into Core.
- Introducing mandatory distributed infrastructure in v1.
- Guaranteeing autonomous merge/land behavior for every repository.
- Replacing the existing `agents` shared task store with external task objects.
  The two serve different scopes.

---

## 3. Position in the Architecture

The Task Orchestrator adds a new layer above the existing daemon/workflow
surface.

```text
+-------------------------------------------------------------------+
| Task Orchestrator                                                 |
|  - task source polling / ingestion                                |
|  - task normalization                                              |
|  - routing to workflow templates                                  |
|  - task lifecycle + evidence store                                |
|  - worktree / branch policy                                       |
|  - landing / escalation decisions                                 |
+------------------------------+------------------------------------+
                               |
                               v
+-------------------------------------------------------------------+
| Daemon / Runner / Management Agent                                |
|  - trigger evaluation                                             |
|  - workflow launch                                                |
|  - runtime adaptation                                             |
+------------------------------+------------------------------------+
                               |
                               v
+-------------------------------------------------------------------+
| Workflow Executor                                                 |
|  - DAG execution                                                  |
|  - context hand-off                                               |
|  - completion checks / convergence                                |
+------------------------------+------------------------------------+
                               |
                               v
+-------------------------------------------------------------------+
| Core                                                              |
|  - permits                                                        |
|  - cancellation                                                   |
|  - budgets                                                        |
|  - circuit breaker / backpressure                                 |
+------------------------------+------------------------------------+
                               |
                               v
+-------------------------------------------------------------------+
| Workers                                                           |
|  - Codex CLI / Claude Code / OpenCode / CUSTOM                    |
+-------------------------------------------------------------------+
```

Key rule: the Task Orchestrator may choose **what** to run and **when**, but it
must not bypass Core safety mechanisms or mutate workflow execution state
outside supported interfaces.

---

## 4. Core Concepts

### 4.1 Task source

A Task Source is a connector that fetches work items from an external system.

Examples:

- GitHub Issues
- GitHub PR comments or review requests
- Linear issues
- Local file-backed inbox
- Custom command/webhook adapters

Task Sources are responsible only for:

- enumerating candidate tasks
- fetching task metadata
- providing a stable source identifier
- acknowledging or annotating task state back to the origin system when needed

Task Sources must not decide workflow behavior directly.

### 4.2 Task Envelope

The Task Envelope is the canonical normalized representation used by Roboppi.

```json
{
  "version": "1",
  "task_id": "github:issue:owner/repo#123",
  "source": {
    "kind": "github_issue",
    "system_id": "github",
    "external_id": "owner/repo#123",
    "url": "https://example.invalid/task/123"
  },
  "title": "Fix flaky scheduler restart test",
  "body": "task description or normalized markdown",
  "labels": ["bug", "ci-flake"],
  "priority": "normal",
  "repository": {
    "id": "owner/repo",
    "default_branch": "main"
  },
  "requested_action": "implement",
  "requested_by": "octocat",
  "metadata": {
    "milestone": "v0.2",
    "assignee": "robot"
  },
  "timestamps": {
    "created_at": 1710000000000,
    "updated_at": 1710000000000
  }
}
```

Normalization goals:

- source-agnostic routing
- deterministic persistence
- stable audit trails
- independence from any single provider API shape

### 4.3 Task Run

A Task Run is one orchestrated attempt to move a task forward.

A task may have multiple runs over time:

- initial implementation attempt
- retry after failure
- rerun after new comments
- landing run after review approval

Task state must therefore be separate from workflow state.

### 4.4 Evidence bundle

Each Task Run produces a bounded evidence bundle used for operator review and
automated decisions.

Typical evidence:

- workflow result
- changed files summary
- diff/patch references
- test results
- review findings
- completion decision rationale
- links to external artifacts (PR, branch, comments)

This is the main abstraction that makes task-driven automation auditable.

---

## 5. Functional Requirements

### 5.1 Ingestion and deduplication

The orchestrator must:

- poll or receive tasks from one or more Task Sources
- deduplicate tasks by stable source identity
- avoid launching conflicting runs for the same task unless policy allows it
- support cooldown, coalescing, and latest-wins policies

### 5.2 Routing

The orchestrator must map a Task Envelope to:

- a workflow template
- optional agent catalog(s)
- workspace / repository target
- worktree / branch policy
- execution priority and concurrency class

Routing inputs may include:

- source kind
- labels
- repository
- requested action
- changed area or target component

### 5.3 Persistent lifecycle

The orchestrator must track task lifecycle independently from the workflow's
internal step state.

Suggested high-level states:

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

### 5.4 Workspace isolation

Task-driven automation is substantially safer when each active task has its own
isolated workspace.

The orchestrator should support:

- dedicated git worktree per task
- deterministic branch naming
- base branch resolution
- cleanup policies for stale worktrees

### 5.5 Completion and landing

A task should not be marked done merely because a workflow succeeded.

The orchestrator must support a final completion decision that can consider:

- workflow success/failure
- evidence bundle contents
- review outcomes
- origin-system state changes
- landing policy

For example:

- code is implemented but tests failed -> `blocked`
- implementation and review passed but human approval is required -> `review_required`
- implementation passed, PR created, auto-merge disabled -> `ready_to_land`
- PR merged successfully -> `landed`

---

## 6. Architecture Components

### 6.1 Task Source adapters

Task Source adapters expose a common interface:

```typescript
interface TaskSource {
  listCandidates(signal?: AbortSignal): Promise<ExternalTaskRef[]>;
  fetchEnvelope(ref: ExternalTaskRef, signal?: AbortSignal): Promise<TaskEnvelope>;
  ack?(update: TaskSourceUpdate, signal?: AbortSignal): Promise<void>;
}
```

Examples of `ack` behavior:

- add a GitHub comment
- update a label
- move a Linear issue state
- write a local state file

### 6.2 Task Registry

The Task Registry is the local persistent store for normalized tasks and their
current orchestration state.

Responsibilities:

- persist Task Envelopes
- track current lifecycle state
- store run history
- prevent duplicate active runs when policy forbids them

This registry is conceptually similar to daemon state, but task-oriented and
longer-lived.

### 6.3 Router

The Router converts a Task Envelope into a Task Execution Plan.

```typescript
interface TaskExecutionPlan {
  workflow: string;
  agentsFiles?: string[];
  workspaceMode: "shared" | "worktree";
  worktree?: {
    baseRef?: string;
    branchNameTemplate: string;
  };
  env: Record<string, string>;
  priorityClass: "interactive" | "normal" | "background";
  managementEnabled?: boolean;
}
```

The Router must be deterministic and explainable. It should produce a machine-
readable decision artifact that records why a given task was routed to a given
workflow.

### 6.4 Worktree Manager

The Worktree Manager owns repository preparation for task execution.

Responsibilities:

- resolve the target repository path
- create or reuse a per-task worktree
- choose base branch/ref
- ensure branch safety checks are applied
- return workspace paths used by workflow runs

This should integrate with existing branch-safety features instead of creating a
parallel git policy system.

### 6.5 Task Dispatcher

The Task Dispatcher launches the selected workflow run and injects task context.

Responsibilities:

- create run directories
- inject normalized task metadata into workflow context and environment
- start the workflow via the existing runner / daemon pathway
- attach task/run identifiers for traceability

Suggested injected artifacts:

- `context/_task/task.json`
- `context/_task/routing.json`
- `context/_task/source-event.json` when applicable

Suggested environment variables:

- `ROBOPPI_TASK_ID`
- `ROBOPPI_TASK_SOURCE_KIND`
- `ROBOPPI_TASK_EXTERNAL_ID`
- `ROBOPPI_TASK_REQUESTED_ACTION`

### 6.6 Evidence Collector

The Evidence Collector aggregates results from a completed or interrupted
workflow run into a stable Task Run artifact set.

Responsibilities:

- copy or reference important workflow outputs
- summarize test and review outcomes
- record branch/worktree information
- produce a bounded `summary.json`

### 6.7 Landing Controller

The Landing Controller is an optional policy component that decides what to do
after a task reaches a candidate completion state.

Possible actions:

- create/update PR
- request human review
- retry with a different workflow
- mark blocked
- mark ready_to_land
- merge / close when policy permits

Landing must remain opt-in and repository-policy aware.

---

## 7. Storage Layout

The v1 design should prefer a local file-backed layout under a dedicated state
directory, following Roboppi's existing preference for inspectable artifacts.

Suggested layout:

```text
.roboppi-task/
  tasks/
    <task-id>/
      envelope.json
      state.json
      runs/
        <run-id>/
          plan.json
          summary.json
          workflow-result.json
          evidence/
            tests.json
            review.json
            diff.json
          links.json
  indexes/
    active.json
    by-source/
  worktrees/
    <task-id>/
```

Design constraints:

- human-inspectable
- deterministic enough to debug
- safe to clean up by task
- compatible with future migration to SQLite if needed

---

## 8. Integration with Existing Roboppi Features

### 8.1 Daemon

The most natural v1 implementation is to build the Task Orchestrator on top of
Daemon-style long-running execution.

The daemon already solves:

- event loops
- trigger evaluation
- concurrency control
- workflow launch

The orchestrator should therefore reuse daemon process lifetime and scheduling
where practical, rather than introduce a separate always-on runtime by default.

### 8.2 Workflow Executor

The Workflow Executor remains responsible for actual task execution logic.

Task-driven orchestration should not replace workflow YAML. Instead, it should:

- select a workflow
- inject task context
- interpret the resulting evidence

### 8.3 Agents

Roboppi Agents already provide a workflow-scoped shared task list and mailbox.
Those should be treated as **intra-workflow coordination primitives**, not as
the external task system itself.

A useful pattern is:

- external task -> Task Orchestrator
- selected workflow -> Agents team
- Agents shared tasks -> decomposition within that one task run

### 8.4 Workflow Management Agent

The workflow management agent is an optional tool for runtime adaptation within
a single Task Run.

The Task Orchestrator may enable it selectively for:

- long-running implementation loops
- review/fix loops
- tasks with high uncertainty

It should not be required for basic task-driven routing.

---

## 9. Configuration Model

The Task Orchestrator needs its own declarative configuration.

Suggested top-level shape:

```yaml
name: engineering-backlog
version: "1"
state_dir: ./.roboppi-task

sources:
  github-main:
    type: github_issue
    repo: owner/repo
    labels: ["roboppi"]

routes:
  bugfix:
    when:
      source: github_issue
      labels_any: ["bug", "flaky"]
    workflow: examples/agent-pr-loop.yaml
    workspace_mode: worktree
    branch_name: "roboppi/task/{{task.slug}}"
    management:
      enabled: true

landing:
  mode: manual
```

This is intentionally separate from workflow YAML because it answers a
different question:

- workflow YAML = how to execute a multi-step job
- task orchestrator config = which external tasks should launch which workflows

---

## 10. Lifecycle Flow

### 10.1 Happy path

1. A Task Source yields a candidate task.
2. The task is normalized into a Task Envelope.
3. The Task Registry deduplicates and records the task.
4. The Router selects a workflow template and workspace policy.
5. The Worktree Manager prepares an isolated workspace.
6. The Task Dispatcher launches the workflow with injected task context.
7. The workflow runs using existing Roboppi runtime features.
8. The Evidence Collector summarizes the outcome.
9. The Landing Controller decides whether to retry, block, request review, or land.
10. The Task Registry persists the final state transition.

### 10.2 Update / rerun flow

When the source task changes while a run is active:

- coalesce the update into the existing task record
- record a source revision marker
- either ignore, queue a rerun, or interrupt the current run based on policy

### 10.3 Failure flow

On workflow failure:

- persist evidence and failure classification
- keep the task lifecycle state explicit (`failed` or `blocked`)
- optionally requeue according to route policy
- never lose the task merely because one workflow run failed

---

## 11. Safety and Guardrails

Task-driven systems are prone to accidental over-automation. The following
guardrails are required:

- hard cap on concurrent active tasks
- per-route concurrency classes
- worktree quota / stale cleanup policy
- landing actions disabled by default
- bounded evidence size
- source-specific rate limits
- explicit state transitions with append-only run history

Important: "task closed" and "workflow succeeded" must never be treated as
synonyms.

---

## 12. Implementation Strategy

### 12.1 Phase 1: local file-backed task orchestration

Scope:

- local state store
- one or two Task Sources
- deterministic router
- workflow dispatch with task context injection
- evidence summary
- manual landing only

This phase proves the architecture without expanding repository risk.

### 12.2 Phase 2: richer source and landing integrations

Possible additions:

- GitHub comments / PR review flows
- Linear integration
- PR creation/update helpers
- richer branch/worktree policies

### 12.3 Phase 3: operator UX

Possible additions:

- TUI task view
- CLI inspection commands
- filtered task queries
- replay/debug helpers for a single task run

---

## 13. Open Questions

1. Should the v1 registry stay file-backed, or should it move directly to
   SQLite for stronger indexing and concurrent access?
2. How much source-specific acknowledgment should happen automatically versus
   only through explicit landing policy?
3. Should worktree management be part of the orchestrator, or factored into a
   reusable branch/workspace service?
4. How should task-level lifecycle appear in the existing TUI without
   overloading workflow step views?
5. What is the minimum evidence schema that is stable enough to support routing,
   retries, and review without becoming provider-specific?

---

## 14. Summary

The Task Orchestrator adds a missing control plane to Roboppi:

- external task ingestion
- normalized task state
- workflow routing
- workspace isolation
- evidence-driven completion

It should be built as a narrow layer above the existing runtime, not as a
replacement for Core, workflows, daemon, or agents.

That direction keeps Roboppi's strongest property intact: it remains a rigorous
execution-control runtime, while gaining a practical task-driven operating
model for real engineering workflows.
