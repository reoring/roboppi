# Issue Clarification And Waiting-State Design

Status: proposed

Related:
- `docs/design/task-orchestrator.md`
- `docs/design/agent-team-first-task-orchestration.md`
- `docs/design/github-issue-agent-team-orchestration.md`

This document defines how Roboppi should handle GitHub issues whose requested
work is not implementable yet because required information is missing.

The target behavior is:

1. a new issue is picked up by an issue-team instance
2. the lead inspects the issue before implementation begins
3. if the request is materially underspecified, the team asks for clarification
4. the task moves to `waiting_for_input`
5. Roboppi does not continue implementation until a human signal arrives
6. once enough information is available, the task resumes
7. if clarification never arrives, the task escalates to `blocked`

The design goal is not only "write a comment asking for more info". The real
requirement is a reliable pause/resume loop driven by human feedback.

---

## 1. Problem

The current GitHub issue flow assumes that every labeled issue is actionable.
That is not always true.

Common failure modes:

- the issue says "fix this" but does not identify the expected behavior
- multiple valid implementations exist and the choice is product-sensitive
- the requested change may be destructive without additional confirmation
- acceptance criteria are missing, so the team cannot know when it is done

If Roboppi implements anyway, it risks doing the wrong work.
If Roboppi always asks questions, it becomes noisy and unhelpful.

The system therefore needs a first-class clarification state with explicit
resume and escalation policy.

---

## 2. Goals And Non-goals

### 2.1 Goals

1. Let the issue-team lead decide when information is materially insufficient.
2. Ask for clarification through a provider-owned actuator, not from agent
   prompts calling provider APIs directly.
3. Move the task into a stable `waiting_for_input` lifecycle.
4. Prevent further implementation while the task is waiting.
5. Resume automatically when a relevant human update arrives.
6. Escalate to `blocked` after policy-defined delay or retry limits.
7. Keep the mechanism reusable for GitHub today and Linear later.

### 2.2 Non-goals

- Asking clarification for every ambiguous or underspecified issue.
- Replacing human judgment with a fully deterministic ambiguity classifier.
- Treating all comments as resume signals.
- Solving full conversational issue triage in the first slice.

---

## 3. Core Principles

### 3.1 Clarification is different from a blocker

`blocked` means the task cannot currently proceed and needs operator attention,
but not necessarily an explicit question/answer loop.

`waiting_for_input` means:

- Roboppi asked a concrete question
- a human response is expected
- the task should pause rather than continue guessing

### 3.2 Agents decide whether clarification is needed

The lead agent should decide whether the issue is implementable, not a shell
script or provider-specific workflow step.

The agent decides one of:

- `implementable`
- `clarification_needed`
- `blocked`

### 3.3 Runtime owns external side effects

Agents must not call GitHub or Linear APIs directly.

The lead emits a structured internal intent such as
`clarification_request`. The task-orchestrator runtime:

- posts the issue comment
- optionally applies labels
- persists waiting-state metadata

### 3.4 Resume must be driven by human signal, not Roboppi's own comments

When Roboppi writes a clarification comment, GitHub updates the issue. That
must not trigger immediate self-resume.

Resume signals should consider only human-originated updates such as:

- issue body edits by the author or collaborator
- new issue comments by a human responder
- relevant label changes by a maintainer

---

## 4. User Experience

Happy path:

1. issue is created with a matching label
2. issue-team starts and the lead inspects the issue
3. the lead determines that essential information is missing
4. Roboppi posts a clarification comment such as:
   - the missing behavior
   - the concrete question
   - what example or acceptance criteria is needed
5. the issue status comment changes to `waiting_for_input`
6. no implementation PR is created yet
7. the issue author replies with enough detail
8. Roboppi notices the new human signal, resumes the issue-team, and continues

Escalation path:

1. Roboppi asks for clarification
2. no adequate reply arrives within policy
3. Roboppi may post one reminder
4. the task transitions to `blocked`
5. the issue remains open, but status clearly shows why progress stopped

---

## 5. Decision Model

The lead agent should not ask questions for every small uncertainty.

### 5.1 Ask for clarification only when the ambiguity is material

Examples:

- target behavior cannot be derived from the issue and repository context
- multiple plausible implementations would produce materially different results
- a schema, API contract, or UX requirement is missing
- the requested change might delete data, change public behavior, or break
  compatibility without explicit approval

### 5.2 Continue without clarification when the minimal safe interpretation is obvious

Examples:

- typo fixes
- narrow README/doc updates
- repository conventions make the expected change obvious
- a minimal, reversible implementation is clearly the intended one

### 5.3 Escalate to blocked instead of waiting when the task is not actionable in principle

Examples:

- repository access is missing
- required external system credentials are unavailable
- the issue is clearly out of scope for the repository
- the dependency or environment itself is broken

---

## 6. New Internal Concept: Clarification Request Intent

Add a new task intent:

- `clarification_request`

Purpose:

- records that the lead determined more information is required
- materializes the clarification payload into task context
- authorizes the runtime to publish the request to the provider

### 6.1 Canonical payload

```json
{
  "summary": "Need the expected behavior for README update",
  "questions": [
    "What exact text should be added to README.md?",
    "Should the change mention issue #25 explicitly?"
  ],
  "missing_fields": ["expected_text", "acceptance_criteria"],
  "resume_hints": [
    "Reply on this issue with the desired sentence",
    "Or edit the issue body with the exact README wording"
  ],
  "severity": "normal"
}
```

### 6.2 Materialized file

The runtime materializes:

- `context/_task/clarification-request.json`

This file is the inspectable bridge between agent decision and provider-side
publication.

---

## 7. Lifecycle Model

### 7.1 New or clarified transitions

```text
queued/preparing/running
  -> waiting_for_input      (clarification request published)

waiting_for_input
  -> running                (relevant human signal detected)
  -> blocked                (timeout / max rounds reached)
  -> closed_without_landing (issue closed externally)

running
  -> blocked                (environmental or non-conversational blocker)
  -> review_required        (normal implementation handoff)
```

### 7.2 Behavioral meaning of `waiting_for_input`

When a task is in `waiting_for_input`:

- no new implementation run should start
- the issue status comment should show the waiting reason
- the source ack comment may summarize the clarification request
- the orchestrator should continue polling the source for human updates

---

## 8. GitHub-Specific Design

### 8.1 External projection

When a `clarification_request` is accepted, the GitHub bridge should:

1. post an issue comment containing:
   - a short explanation of why implementation is paused
   - the specific questions
   - what kind of response will unblock the task
2. update the status comment to:
   - `Lifecycle: waiting_for_input`
   - `Summary: waiting for clarification`
3. optionally add a `needs-info` label if configured

### 8.2 Distinguish Roboppi-authored comments from human comments

The source must ignore Roboppi's own clarification comment as a resume trigger.

It should consider:

- comment author login
- author association
- optional configured bot identities

### 8.3 Resume signals

For GitHub issues, resume should happen on a revision that includes at least one
human signal:

- new human comment after `waiting_started_at`
- issue body edit after `waiting_started_at`
- relevant label change after `waiting_started_at`

### 8.4 Revision model changes

Current issue revision hashing is based on:

- title
- body
- labels
- state
- requested_by
- assignees
- milestone

That is not enough for clarification loops because human comments are invisible.

The source should be extended to compute an additional human-signal revision
component, for example:

```json
{
  "content_revision": "...",
  "last_human_comment_id": 12345,
  "last_human_comment_at": 1710000000000,
  "last_human_body_edit_at": 1710000000000
}
```

The final source revision should include those human-signal fields while still
excluding Roboppi-authored comments.

---

## 9. Policy Surface

Clarification policy should be declarative and workflow-owned.

Suggested addition:

```yaml
clarification:
  enabled: true
  max_round_trips: 2
  reminder_after: 24h
  block_after: 72h
  accepted_responders: [issue_author, collaborators]
  auto_labels: [needs-info]
  resume_on:
    - human_comment
    - issue_body_edit
    - label_change
  fallback: blocked
```

### 9.1 Meaning

- `max_round_trips`
  - maximum number of clarification cycles before escalation
- `reminder_after`
  - when Roboppi may post one reminder comment
- `block_after`
  - hard deadline for moving to `blocked`
- `accepted_responders`
  - whose updates count as valid human input
- `auto_labels`
  - provider labels to add while waiting
- `resume_on`
  - event classes that can restart execution
- `fallback`
  - target lifecycle when waiting expires

---

## 10. Agent-Team Behavior

### 10.1 Issue lead responsibilities

The issue lead should:

1. inspect the issue and repository context before assigning implementation
2. decide whether clarification is required
3. emit `clarification_request` when necessary
4. stop implementation delegation until the issue resumes

### 10.2 Implementer responsibilities

The implementer should not start mutating the repo when the lead has already
decided that the issue is waiting for human input.

### 10.3 Reporter responsibilities

The reporter may emit an internal activity such as:

- `waiting_for_input`
- `blocker`

but should not publish provider-side comments directly.

### 10.4 Prompt discipline

Lead instructions should explicitly distinguish:

- "ask for clarification and wait"
- "proceed with the minimal safe implementation"
- "escalate as blocked"

This is a policy/prompt problem and must be written down, not left implicit.

---

## 11. Runtime Components To Add

### 11.1 Intent layer

- add `clarification_request` to task intent kinds
- validate payload shape
- materialize `clarification-request.json`

### 11.2 Provider actuator

For GitHub:

- post clarification comment
- optionally add `needs-info`
- optionally post reminder comment later

### 11.3 Waiting-state persistence

Persist waiting metadata, for example:

```json
{
  "version": "1",
  "task_id": "github:issue:owner/repo#123",
  "round_trip": 1,
  "waiting_started_at": 1710000000000,
  "reminder_sent_at": null,
  "block_after_at": 1710259200000,
  "clarification_comment_id": 12345
}
```

Suggested file:

- `.roboppi-task/tasks/<task-id>/waiting-state.json`

### 11.4 Resume detector

The service/source layer should evaluate:

- task lifecycle is `waiting_for_input`
- new human signal exists
- signal occurred after `waiting_started_at`

Then it may re-dispatch the task even if the previous task content hash is
otherwise unchanged.

---

## 12. Service Semantics

The current `shouldSkipUnchangedTask()` behavior is designed to suppress
duplicate runs when the source revision is unchanged.

For waiting tasks, the semantics should become:

- if lifecycle is `waiting_for_input`, unchanged content alone is not enough to
  skip forever
- a new human signal must override the unchanged skip
- a Roboppi-authored comment must not override the skip

This means the skip logic must become lifecycle-aware and signal-aware.

---

## 13. Safety And Noise Control

### 13.1 Avoid question spam

Roboppi should not repeatedly ask the same question.

Controls:

- dedupe clarification payloads
- cap round trips
- send at most one reminder per round
- suppress duplicate provider comments if the rendered body is unchanged

### 13.2 Avoid false resumes

Do not resume on:

- Roboppi status comment updates
- Roboppi ack comments
- unrelated bot comments

### 13.3 Avoid silent stalls

If the task stays `waiting_for_input` too long, it must visibly transition to
`blocked` with rationale.

---

## 14. Example Flow

Issue:

> Update README to describe the new deployment mode.

Repository context does not reveal:

- what deployment mode means
- which section of README should change
- what wording is expected

Lead decision:

- implementation is not safe to guess
- clarification is required

Lead emits:

```json
{
  "kind": "clarification_request",
  "payload": {
    "summary": "Need the exact README change before editing docs",
    "questions": [
      "Which deployment mode should be documented?",
      "Which README section should be updated?",
      "Do you want a short note or a full setup example?"
    ]
  }
}
```

GitHub receives:

- issue comment asking those questions
- status comment updated to `waiting_for_input`

Human replies:

> Add one sentence to the Quickstart section saying local supervised serve is the default.

GitHub source sees a new human comment, revision changes, task resumes, and the
issue-team continues implementation.

---

## 15. Implementation Plan

### Phase 1: Single-round clarification

- add `clarification_request` intent kind
- materialize `clarification-request.json`
- add GitHub clarification comment actuator
- allow workflows to land in `waiting_for_input`
- update issue status projection to show waiting state

### Phase 2: Resume on human comment/body edit

- extend `github_issue` source revision to include human-signal metadata
- persist waiting-state metadata
- re-dispatch waiting tasks when a valid human signal appears

### Phase 3: Reminder and escalation

- add `reminder_after`
- add `block_after`
- transition stale waiting tasks to `blocked`
- optionally apply/remove `needs-info` labels

### Phase 4: Declarative workflow policy

- add `clarification:` config block
- connect accepted responders, label policy, and fallback state

### Phase 5: Multi-provider expansion

- generalize provider actuator interface
- add Linear comment/state mapping on the same internal model

---

## 16. Acceptance Criteria

1. A lead can emit a `clarification_request` without calling provider APIs.
2. GitHub issue receives a clarification comment rendered by the runtime.
3. Task lifecycle moves to `waiting_for_input`.
4. No implementation PR is opened while the task is waiting.
5. A new human comment on the issue causes the task to resume.
6. Roboppi's own comments do not trigger resume.
7. Repeated unanswered clarification requests eventually transition the task to
   `blocked`.
8. Status comments and local task state remain inspectable throughout.

---

## 17. Recommended Next Slice

The first implementation slice should be:

1. `clarification_request` intent
2. GitHub clarification comment actuator
3. `waiting_for_input` lifecycle materialization
4. GitHub issue human-comment-aware revision/resume

Without step 4, the system can ask questions but cannot correctly resume, which
would make the feature incomplete.
