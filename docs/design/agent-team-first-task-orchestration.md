# Agent-Team-First Task Orchestration

Status: proposed

Related:
- `docs/design/task-orchestrator.md`
- `docs/design/github-issue-agent-team-orchestration.md`
- `docs/design/issue-clarification-and-waiting-state.md`
- `docs/features/agents.md`
- `docs/features/agents-resident-lead-dynamic-members.md`

This document refines the GitHub/Linear task-orchestration design with one
specific goal:

- the agent team should do the actual work and make the meaningful decisions
- the runtime should apply those decisions safely and deterministically

The immediate trigger for this design is that the current live examples rely on
too many `CUSTOM` steps for review/merge/reporting. Those examples are useful as
integration scaffolding, but they undercut the intended value of Roboppi's
agent-team model.

This document defines the target architecture for moving from:

- workflow-driven shell glue with some agents

to:

- agent-team-driven execution with a thin deterministic actuation layer

---

## 1. Problem

The current task-orchestrator slices prove that Roboppi can:

- pick up GitHub issues and PRs
- dispatch issue/PR workflows
- run agent teams
- project progress back to GitHub
- land linked issue state from a merged PR

However, the current implementation still has an unhealthy split of
responsibility:

- agents do some coordination and judgment
- `CUSTOM` steps still perform too much orchestration logic
- GitHub review/merge/reporting behavior is partially encoded in workflow shell
- "who is allowed to do what" is not expressed as a first-class team policy

That creates four problems.

### 1.1 The agent team is not actually the primary execution model

If review, merge, final landing, and external reporting all happen in
workflow-level `CUSTOM` steps, the "team" becomes advisory rather than primary.

### 1.2 External-system logic leaks into workflow YAML

Commands like `gh pr review`, `gh pr merge`, and provider-specific status
formatting show up in workflow definitions. This makes workflows harder to
reason about, harder to port to other sinks, and harder to constrain safely.

### 1.3 Reporting and actuation are conflated

Publishing a status update, recording a review verdict, and actually merging a
PR are different operations, but they are currently too close together in the
execution model.

### 1.4 Authorization is implicit instead of declarative

Today a member can do something because its prompt says so. That is too weak.
The runtime should be able to enforce:

- which members may publish external progress
- which members may record review verdicts
- which members may request landing or merge
- which external sinks are enabled for the workflow

---

## 2. Goals and Non-goals

### 2.1 Goals

1. Make the agent team the primary owner of issue and PR execution.
2. Keep GitHub/Linear-specific API details out of agent prompts.
3. Reduce `CUSTOM` steps to deterministic infrastructure operations only.
4. Introduce a first-class internal intent layer between agents and external
   actuators.
5. Make permissions declarative in `workflow.yaml` and member roles.
6. Keep local inspectability via `_task/*.json` and `.roboppi-task/`.
7. Support the target operating model:
   - issue created
   - issue team works
   - PR opened
   - review team reviews
   - progress is reflected externally
   - PR lands
   - linked issue is closed and finalized

### 2.2 Non-goals

- Eliminating all deterministic steps. Branch preparation and some completion
  guards should remain deterministic.
- Making agents call provider APIs directly.
- Hiding git from agents. Repo-local git work is still part of the agent job.
- Solving cross-host distributed leases in this document.

---

## 3. Core Principles

### 3.1 Agents decide, runtime applies

Agents should decide:

- what progress is worth reporting
- whether a PR is acceptable
- whether a task is blocked
- whether a task is ready for review or landing

The runtime should apply:

- status comment updates
- issue comments
- PR review submission
- PR merge
- issue close/reopen

### 3.2 Provider APIs are hidden behind Roboppi tools

Agents should not need to know:

- `gh api`
- `gh pr review`
- `gh pr merge`
- Linear endpoint details

Instead, agents should use Roboppi-provided internal tools such as:

- `task.report_activity`
- `task.record_review_verdict`
- `task.record_landing_decision`
- `task.request_merge`
- `task.request_external_publish`

### 3.3 `CUSTOM` remains only for deterministic infrastructure

Allowed `CUSTOM` responsibilities:

- prepare branch/worktree
- deterministic repository checks
- completion assertions
- intent-actuation loops owned by the runtime

Disallowed target state for `CUSTOM`:

- deciding approval vs changes requested
- deciding what external summary to publish
- deciding whether a task is blocked
- synthesizing team-level status by itself

### 3.4 Reporting is sink-agnostic

Agents emit internal activity and publishable summaries. The task-orchestrator
projects them to:

- GitHub
- Linear
- future sinks such as Slack

without changing agent prompts per sink.

### 3.5 Team policy is declarative and enforceable

The workflow definition must declare:

- which roles may emit which intents
- which member is the default publisher
- which sinks are enabled
- which event classes are externally visible

The runtime must reject unauthorized intent emission.

---

## 4. Proposed Layering

```text
+------------------------------------------------------------------+
| Agent Team                                                       |
|  - lead                                                          |
|  - implementer / reviewer                                        |
|  - reporter / publisher                                          |
|                                                                  |
| agents produce internal intents, not provider API calls          |
+------------------------------+-----------------------------------+
                               |
                               v
+------------------------------------------------------------------+
| Internal Task Tools / MCP                                        |
|  - report_activity()                                             |
|  - record_review_verdict()                                       |
|  - record_landing_decision()                                     |
|  - request_merge()                                               |
|  - request_external_publish()                                    |
+------------------------------+-----------------------------------+
                               |
                               v
+------------------------------------------------------------------+
| Task Intent Store                                                |
|  - append-only intent log                                        |
|  - latest materialized state                                     |
|  - authorization checks                                          |
+------------------------------+-----------------------------------+
                     |                              |
                     v                              v
+--------------------------------+   +--------------------------------+
| External Projection Bridge     |   | External Actuator              |
|  - status comment projection   |   |  - submit GitHub review        |
|  - milestone comments          |   |  - merge PR                    |
|  - Linear comments             |   |  - close/reopen issue          |
+--------------------------------+   +--------------------------------+
```

This preserves a clean separation:

- agent team = cognition and judgment
- intent store = durable control surface
- bridge/actuator = deterministic side effects

---

## 5. New Concept: Task Intent

A **Task Intent** is a structured request emitted by an authorized agent member.
It is the canonical interface between the team and the task-orchestrator.

Examples:

- "publish this progress update"
- "this PR should be approved"
- "this task is ready for review"
- "this PR should be merged"
- "this task is blocked for reason X"

### 5.1 Intent classes

The initial intent classes should be:

1. `activity`
2. `review_verdict`
3. `landing_decision`
4. `merge_request`
5. `external_publish`

### 5.2 Intent schema

Canonical envelope:

```json
{
  "version": "1",
  "intent_id": "uuid",
  "task_id": "github:pull_request:owner/repo#45",
  "run_id": "uuid",
  "member_id": "reviewer",
  "member_roles": ["reviewer"],
  "kind": "review_verdict",
  "payload": {
    "decision": "approve",
    "rationale": "Reviewed the PR and found no blocking issues"
  },
  "created_at": 1710000000000
}
```

### 5.3 Storage

Per run:

```text
context/_task/intents.jsonl
context/_task/activity.jsonl
context/_task/review-verdict.json
context/_task/landing.json
context/_task/publish-summary.json
```

Rules:

- `intents.jsonl` is append-only and auditable
- materialized files hold the latest accepted state for easy consumption
- runtime-generated actuator results are stored separately from raw intents

---

## 6. Agent-Facing Tool Surface

The intent layer should be exposed as Roboppi-native tools. The transport may
be CLI initially and MCP next, but the contract should be stable.

### 6.1 Required tools

#### `task.report_activity`

Purpose:

- report structured progress/blocker/review milestones

Example payload:

```json
{
  "kind": "progress",
  "phase": "implement",
  "message": "Prepared the README change and started local validation"
}
```

#### `task.record_review_verdict`

Purpose:

- let a reviewer or lead record `approve` or `changes_requested`

Example payload:

```json
{
  "decision": "approve",
  "rationale": "README change is correct and validation passed"
}
```

#### `task.record_landing_decision`

Purpose:

- let the lead mark `review_required`, `blocked`, `ready_to_land`, `landed`, or
  `closed_without_landing`

#### `task.request_merge`

Purpose:

- let the lead request merge after an accepted review verdict

Example payload:

```json
{
  "strategy": "squash",
  "rationale": "Approved by review team and ready to land"
}
```

#### `task.request_external_publish`

Purpose:

- let an authorized publisher request that a specific summary be projected to
  enabled sinks

### 6.2 Transport

Two valid implementations:

- v1: `roboppi task-orchestrator intent emit ...`
- v2: `roboppi task-orchestrator mcp`

The CLI should remain as a fallback/debugging surface. The preferred agent
experience should be MCP because it gives:

- structured payloads
- capability gating
- better UX than shell command templates

### 6.3 Skills

An optional Roboppi skill may teach members:

- when to emit progress
- when to avoid noisy updates
- how to write concise external summaries
- how to distinguish internal findings from external operator-facing status

Skills are guidance only. They are not the enforcement layer.

---

## 7. Declarative Workflow Policy

The workflow definition needs a first-class task policy section.

Proposed shape:

```yaml
agents:
  enabled: true
  team_name: "issue-team"
  members:
    lead:
      agent: issue_lead
      roles: [lead, publisher]
    implementer:
      agent: issue_implementer
      roles: [implementer]
    reviewer:
      agent: pr_reviewer
      roles: [reviewer]
    reporter:
      agent: status_reporter
      roles: [publisher]

task_policy:
  intents:
    activity:
      allowed_members: [lead, implementer, reviewer, reporter]
      allowed_roles: [lead, implementer, reviewer, publisher]
    review_verdict:
      allowed_members: [reviewer, lead]
      allowed_roles: [reviewer, lead]
    landing_decision:
      allowed_members: [lead]
      allowed_roles: [lead]
    merge_request:
      allowed_members: [lead]
      allowed_roles: [lead]
    external_publish:
      allowed_members: [lead, reporter]
      allowed_roles: [publisher]

reporting:
  default_publisher: lead
  sinks:
    github:
      enabled: true
      publisher_member: reporter
      allowed_members: [lead, reporter]
      allowed_roles: [publisher]
      events: [progress, blocker, review_required, landed]
      projection: status_comment
      aggregate: latest
    linear:
      enabled: false
      publisher_member: reporter
```

Runtime behavior:

- reject unauthorized intent emission
- record rejection reason in the run artifacts
- do not project rejected intents externally

---

## 8. Workflow Shapes

### 8.1 Issue workflow

Issue workflow target shape:

1. deterministic branch/worktree preparation
2. lead coordinates implementer and reporter
3. implementer edits, tests, commits, pushes, and requests PR creation
4. lead records `review_required`
5. reporter publishes progress summaries via internal tools

What stays deterministic:

- branch preparation
- repo cleanliness checks
- completion check that a valid landing decision exists

What moves to agents:

- deciding what changed
- deciding whether the issue is blocked
- deciding when the issue is ready for review
- deciding what operator-facing summary should be published

### 8.2 PR review workflow

PR review workflow target shape:

1. reviewer inspects diff and validation evidence
2. reviewer records `review_verdict`
3. lead decides whether to request merge
4. reporter publishes concise review progress externally
5. runtime actuator submits the provider review and merge
6. runtime records `landed` or `blocked`

What stays deterministic:

- completion check that an accepted verdict or explicit block exists
- provider-side application of review/merge
- verification that merge actually happened

What moves to agents:

- review judgment
- blocker explanation
- merge recommendation
- operator-facing explanation of the result

---

## 9. External Sink and Actuation Model

We need to distinguish two categories of side effects.

### 9.1 Projection side effects

Projection means reflecting internal state outward:

- update GitHub status comment
- append milestone comment
- append Linear comment

Projection consumes:

- accepted `activity` intents
- accepted `external_publish` intents
- task state transitions

Projection should be idempotent and coalescing.

### 9.2 Actuation side effects

Actuation means changing provider state:

- submit GitHub PR approval
- submit changes requested
- merge PR
- close linked issue
- reopen issue

Actuation consumes:

- accepted `review_verdict`
- accepted `merge_request`
- accepted `landing_decision`

Actuation rules:

- deterministic
- idempotent where possible
- permission-checked
- recorded with durable results

Proposed artifacts:

```text
context/_task/actuation-results.jsonl
context/_task/projection-results.jsonl
```

---

## 10. Why This Is Better Than `CUSTOM`-Heavy Workflows

This model fixes the current weakness directly.

With the proposed model:

- the reviewer agent decides approval
- the lead agent decides merge intent
- the reporter agent decides publishable summaries
- the runtime merely applies accepted intents

That means the "team" is doing the work, not just feeding a shell wrapper.

It also gives cleaner portability:

- GitHub -> Linear does not require rewriting prompts
- workflow YAML stops embedding provider commands
- authorization moves out of prompt text into runtime policy

---

## 11. Minimal Viable Slice

The first slice should be intentionally narrow.

### 11.1 In scope

1. Add intent store and CLI surface.
2. Add workflow-level `task_policy.intents`.
3. Add agent-member authorization checks.
4. Add GitHub actuation for:
   - `review_verdict`
   - `merge_request`
   - linked issue close/finalize
5. Update the live GitHub example to:
   - keep branch prep deterministic
   - remove `gh pr review` and `gh pr merge` from agent prompts
   - remove review/merge `CUSTOM` decision logic

### 11.2 Explicitly deferred

- full Linear actuator
- bidirectional operator-comment ingestion
- distributed host coordination
- rich batching/throttling of publish events

---

## 12. Implementation Plan

### Phase 1: Intent infrastructure

Add:

- `src/task-orchestrator/intent-log.ts`
- `src/task-orchestrator/intent-policy.ts`
- `roboppi task-orchestrator intent emit ...`

Deliverables:

- append-only intent log
- materialized current review/landing state
- authorization checks based on workflow policy

### Phase 2: Agent-facing tool surface

Add:

- CLI wrappers for `activity`, `review_verdict`, `landing_decision`, `merge_request`
- optional MCP server exposing the same primitives

Deliverables:

- agents stop writing raw `_task/*.json` files directly
- agents stop embedding provider shell commands for task-level state changes

### Phase 3: GitHub actuator

Add:

- review actuator from `review_verdict`
- merge actuator from `merge_request`
- linked-issue finalization from landed PR state

Deliverables:

- PR review appears in GitHub review history
- PR merge is runtime-applied from accepted intent
- linked issue lands and closes coherently

### Phase 4: Example rewrite

Rewrite live examples so that:

- agents emit intents
- runtime applies them
- `CUSTOM` remains only for branch prep and completion checks

### Phase 5: Linear sink

Reuse the same intent and reporting surface with:

- Linear comment projection
- optional status updates

---

## 13. Acceptance Criteria

The design is successful when all of the following are true.

1. In the live GitHub issue-to-PR-to-merge example, the reviewer agent records
   a review verdict through Roboppi tooling, not provider shell commands.
2. The lead agent requests merge through Roboppi tooling, not provider shell
   commands.
3. GitHub shows a real PR review record.
4. GitHub shows a merged PR.
5. The linked issue shows:
   - progress updates during implementation
   - final landed state
   - closed state after the PR lands
6. Workflow YAML contains only deterministic `CUSTOM` steps.
7. Replacing GitHub with another sink does not require changing agent prompts,
   only sink/bridge configuration and actuator implementation.

---

## 14. Open Questions

### 14.1 Should PR creation also move behind an internal tool?

Probably yes, but it is not required for the first slice. The implementer can
continue to use git and `gh pr create` initially. The stronger abstraction is:

- agent proposes PR title/body/base
- runtime opens the PR

That is likely Phase 6, not Phase 1.

### 14.2 Should publisher be a separate member?

Not always. The design should support:

- `lead` as publisher for small teams
- dedicated `reporter` for larger or higher-noise teams

### 14.3 Should intent tools be available as CLI only or MCP first?

Recommended answer:

- CLI first for implementation speed and debuggability
- MCP immediately after, then prefer MCP in examples

---

## 15. Summary

The target architecture is not "fewer agents and more shell", and it is not
"agents directly calling GitHub APIs".

It is:

- agents own judgment and team coordination
- Roboppi-native tools capture that judgment as structured intents
- the runtime applies external side effects deterministically
- provider-specific behavior lives in bridges/actuators, not in prompts

That is the shape that makes the agent team real rather than cosmetic while
keeping the system inspectable, enforceable, and portable.
