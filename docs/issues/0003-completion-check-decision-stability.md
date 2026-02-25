# Completion Check decision instability (COMPLETE/INCOMPLETE parse failure)

Status: in progress (core completion decision unification + `decision_file` hardening)

## Problem

`completion_check` can fail like this:

```
Completion check failed: could not parse completion decision (expected COMPLETE/INCOMPLETE marker)
```

Observed in real runs:

- parse failure occurs even when worker output contains `INCOMPLETE`
- `.roboppi-loop/review.verdict` may contain `FAIL`, but the decision is not used
- as a result, the workflow can become `FAILED` before reaching `max_iterations`

Because prompt tweaks in the workflow can re-introduce this class of failures, the fix must be in AgentCore/Supervisor decision handling.

## Current Behavior (Key points)

Relevant implementations:

- `src/workflow/core-ipc-step-runner.ts`
- `src/workflow/multi-worker-step-runner.ts`
- `src/workflow/completion-decision.ts`
- `src/worker/adapters/opencode-adapter.ts`

Current decision path:

1. if `decision_file` exists, read the decision from the file (`PASS/FAIL`, `COMPLETE/INCOMPLETE`)
2. otherwise, search for markers in worker free-text output
3. if no decision is found, fail the step as `NON_RETRYABLE`

## Root Causes

1. the decision channel depends on free-text
- if the LLM output format shifts, the decision becomes unparseable

2. `decision_file` freshness relies on time heuristics
- relying on `mtime` leaves room for false negatives

3. runner implementations are duplicated, creating behavior drift
- similar logic exists in both `core-ipc-step-runner` and `multi-worker-step-runner`

4. inability to decide triggers immediate hard failure
- a temporary mismatch in the decision channel can bring down the whole workflow

## Goals

1. make completion decisions deterministic
2. avoid unnecessary hard-fail when a decision cannot be parsed
3. unify decision logic into a single implementation
4. keep backwards compatibility with existing workflows

## Implementation Notes (2026-02-14)

- `src/workflow/completion-decision.ts`
  - introduced a shared resolver `resolveCompletionDecision` that reads `decision_file` as JSON or legacy text
  - added `check_id` safety by matching `ROBOPPI_COMPLETION_CHECK_ID`
  - accepts `PASS/FAIL` / `COMPLETE/INCOMPLETE` and JSON like `{"decision":"...","check_id":"..."}`
- `src/workflow/core-ipc-step-runner.ts` and `src/workflow/multi-worker-step-runner.ts`
  - unified `decision_file` handling
  - changed "cannot decide" to `checkResult.failed: false` (treat as INCOMPLETE) to avoid hard failure
  - in verbose mode, log `decision_source` / `check_id_match`

## Proposed Approach (Core changes)

## 1) Introduce a Structured Decision Contract

Structure the completion decision.

- New format (recommended):
  - write JSON to `decision_file`
  - example: `{"decision":"complete","check_id":"...","reasons":[...],"fingerprints":[...]}`
- Legacy format (compatibility):
  - `PASS/FAIL`
  - `COMPLETE/INCOMPLETE`

Use `check_id` to prevent stale decision files from previous runs without relying on timestamps.

## 2) Fix the algorithm as file-first

Make priority explicit and single-sourced:

1. `decision_file` (structured JSON)
2. `decision_file` (legacy text)
3. worker output marker (compat fallback)

Marker searching stays only for backward compatibility; the intended main path is `decision_file`.

## 3) Treat "cannot decide" as INCOMPLETE

Stop hard-failing on parse errors.

- before: cannot parse => `FAILED (NON_RETRYABLE)`
- after: cannot parse => `INCOMPLETE` (eligible for loop retry)

Bounding rules:

- stop at `max_iterations`
- additionally, keep a parse-failure counter and return a clear failure reason when a threshold is exceeded

## 4) Consolidate runner logic into a shared module

Create a shared module and remove duplication.

- example: `src/workflow/completion-resolution.ts`
- both `core-ipc-step-runner.ts` and `multi-worker-step-runner.ts` use the module

## 5) Improve debuggability

Log at least:

- `decision_source` (`file-json` / `file-text` / `marker` / `none`)
- whether `check_id` matches
- parse failure reason ("missing decision", "invalid json", etc.)

## Implementation Plan

1. extend types/spec
- add structured decision spec comments to `CompletionCheckDef`
- finalize `check_id` generation/propagation

2. implement a shared decision module
- add structured support to `parseCompletionDecisionFromFile`
- consolidate decision priority

3. replace runner implementations
- migrate `core-ipc-step-runner.ts` to the shared module
- migrate `multi-worker-step-runner.ts` to the shared module

4. adjust failure semantics
- treat parse failure as `INCOMPLETE`
- add a parse-failure counter to step state if needed

5. tests
- unit:
  - structured file decisions (complete/incomplete)
  - legacy text decisions (PASS/FAIL)
  - marker fallback
  - stale file (`check_id` mismatch)
  - invalid json
- integration:
  - complete loop for `FAIL -> fix -> PASS` similar to `examples/agent-pr-loop.yaml`
  - keep legacy marker-only compatibility

6. update samples
- migrate `examples/agent-pr-loop.yaml` to structured decision
- keep existing samples with a migration guide

## Acceptance Criteria

1. no immediate hard failures due to parse errors for `INCOMPLETE`/`FAIL` decisions
2. stable looping when `review.verdict` (or structured decision file) exists
3. identical decisions for identical inputs across `core-ipc` and `multi-worker`
4. existing workflows using `PASS/FAIL` and `COMPLETE/INCOMPLETE` keep working

## Non-goals

- guaranteeing LLM review quality (correctness of the decision itself)
- auto-fixing flawed workflow design that is permanently failing

## Known Risks & Mitigations

1. treating parse failures as `INCOMPLETE` can lengthen loops
- mitigation: rely on `max_iterations` and log parse-failure thresholds

2. confusion during migration with mixed legacy/structured formats
- mitigation: fix file-first priority and log `decision_source`

3. breaking compatibility with existing workflows
- mitigation: keep supporting legacy text decisions (`PASS/FAIL`, etc.)

## Short-term plan

1. implement shared decision module + structured file support
2. treat parse failures as `INCOMPLETE`
3. migrate `examples/agent-pr-loop.yaml` to structured decisions
4. re-validate using real environments that previously reproduced the issue
