# Implement loop lacks self-healing (repeating INCOMPLETE / failure to converge)

Status: partially implemented (Convergence Controller: stall detection / staged strategy switching / diagnostic output + scope guard; baseline diff is not implemented yet)

## Problem

In the 2026-02-14 run (`/home/reoring/appthrust/platform/.roboppi-loop/run-local-workflow-20260214-214510.log`), the following were observed:

- no `completion decision` parse failure (`expected COMPLETE/INCOMPLETE marker`) in that log
  - `completion decision: incomplete source=file-text` appears multiple times
  - parse failures exist in other runs and are handled by a separate earlier issue
- `implement` keeps iterating on `INCOMPLETE` (weak convergence control)
- at least one test failure was observed
  - `go test ./...` failed at `template_test.go:104` (`gateway-api-crds-template should contain standard install header`)
  - subsequent `go test ./...` could pass, yet the loop can still continue with `INCOMPLETE` (e.g. compatibility verdict remains FAIL / scope violation remains)

In other words, decision stability is improving, but controls to "make INCOMPLETE converge on its own" are still insufficient.

## Current Behavior (Key points)

1. `implement` performs changes
2. `completion_check` decides `COMPLETE/INCOMPLETE` from verdict/markers
3. if `INCOMPLETE`, proceed to the next iteration
4. even if the same failure (or same verdict) repeats, strategy switching and stop conditions are weak, so the loop can continue repeating

## Root Causes

1. completion is basically binary (complete/incomplete) and does not treat failure identity ("is it the same failure repeating?") as state
2. no baseline diff gate (existing failures vs newly introduced failures)
3. no accumulation/comparison of failure fingerprints (no stall detection)
4. weak detection/suppression of out-of-scope changes (violating allowed paths), making fixes sprawl
5. stop conditions are weak beyond a simple iteration cap (lack of fail-fast with diagnosis)

## Goals

1. automatically detect repeated failures and switch strategies in stages
2. when convergence is impossible, stop early with a clear reason (fail-fast with diagnosis)
3. stabilize completion decisions using baseline diffs
4. suppress out-of-scope changes and keep milestone diffs small

## Approach (AgentCore/Supervisor side)

Core idea: add a Convergence Controller on the Supervisor side to the loop (`completion_check` + `max_iterations`).

- purpose: mechanically detect "same INCOMPLETE repeats"
  - raise the stage and tighten constraints (= strategy switch)
  - if still no progress, stop with diagnostics
- workflow compatibility: default behavior remains as-is (opt-in), then expand gradually

## 1) Extend the Structured Decision Contract (reasons / fingerprints)

Move completion decisions away from free text and toward machine-generated JSON as the primary path.

- recommended `decision_file` example:
  - `{"decision":"complete|incomplete","check_id":"...","reasons":[...],"fingerprints":[...]}`
- `check_id` prevents stale-file mixing without timestamp comparisons
- keep legacy compatibility (`PASS/FAIL`, `COMPLETE/INCOMPLETE`) for now

This self-healing work uses `reasons` / `fingerprints` as primary signals.

## 2) Introduce Failure Fingerprints

Normalize test failures into stable signatures and compare across iterations.

- example components: `command + package + testName + errorSignature + file:line`
- output: `fingerprint_id` (hash)
- maintain consecutive counts for identical fingerprints in state

## 3) Add a Baseline-diff gate

Capture a baseline before `implement`, and decide completion based on "presence of new failures".

- baseline example: the set of failures from `go test ./...`
- completion conditions (example):
  - `new_failures == 0`
  - `scope_violation == false`

Implementation notes:

- baseline must not be taken on a dirty, already-mutated workspace (it can be contaminated). Prefer creating a clean working tree (e.g. `git worktree`) and taking the baseline there.
- if baseline capture fails, do not downgrade to a warning; fail fast with a clear reason.

## 4) Staged strategy switching on stalls (Convergence Controller)

If the same fingerprint (or the same failure set) repeats, switch behavior in stages:

- Stage 1: normal fix
- Stage 2: minimal-change mode (enforce diff budget / allowed_paths; prioritize rolling back unnecessary changes)
- Stage 3: emit diagnostic artifacts and return `FAILED` (explicit reasons + attach fingerprints and stall evidence)

This prevents near-infinite repetition.

## 5) Scope guard (allowed_paths + diff budget)

Define `allowed_paths` in the workflow; if a change outside scope is detected, return `INCOMPLETE` with explicit reasons.

- example: if the milestone is around the controller, changes under `charts/` are warned/blocked

Implementation notes:

- in a git repo, collect changed files via `git status --porcelain` / `git diff --name-only` and check against `allowed_paths`
- exclude workflow-generated artifacts (e.g. `context/`, `.roboppi-loop/`) from scope checks to avoid false positives

## 6) Make Completion Check fully machine-decided

Make `decision_file` (structured JSON) the primary path rather than LLM free text.

- restrict the LLM to "proposal generation + JSON output"
- keep marker searching only for compatibility, but fix the algorithm to file-first

## 7) Standardize diagnostic artifacts

Persist artifacts that make convergence visible:

- `baseline_failures.json`
- `current_failures.json`
- `failure_fingerprint_history.json`
- `completion_reasons.json`

Recommended location:

- `context/<step>/...` within the workflow workspace (easy for runner collection)
- optionally also under `.roboppi-loop/` (assuming `.gitignore`)

## Implementation Plan

1. add a failure analysis module
- e.g. `src/workflow/quality/failure-fingerprint.ts`

2. extend state (Convergence Controller)
- keep fingerprint history, consecutive counts, failure-set hash, diff hash, and strategy stage
- depending on stage, automatically enforce/override/append instructions for the implement step (minimal-change mode, etc.)

3. add a baseline step
- capture baseline before `implement` (ideally in a clean worktree)

4. extend completion decisions
- add `reasons` / `fingerprints` to the `decision_file` JSON
- extend existing resolver (`resolveCompletionDecision`)

5. implement scope guard
- add `allowed_paths` to workflow definition and validate
- also record scope violations as fingerprints to feed stall detection

6. tests
- unit: fingerprint normalization, equality behavior, stage transitions, allowed_paths checks
- integration: stage advances when the same failure set repeats; ultimately stops with diagnostics

## Acceptance Criteria

1. stage transitions occur when identical fingerprints repeat
2. when stage cap is reached, `FAILED` includes explicit reasons (fingerprints/reasons)
3. only `new_failures == 0` results in `COMPLETE` under baseline-diff rules
4. changes outside `allowed_paths` are detected and recorded
5. keep compatibility with existing workflows (legacy verdict formats)

## Non-goals

- automatically fixing arbitrary implementation bugs in all cases
- guaranteeing LLM code quality

## Known Risks & Mitigations

1. non-deterministic tests can cause fingerprint drift
- mitigation: normalize messages/noise; observe multiple times

2. baseline problems distort decisions
- mitigation: fail fast when baseline capture fails

3. increased runtime
- mitigation: make baseline scope configurable; require explicit opt-in for heavy tests

## Related

- earlier issue: `docs/issues/0003-completion-check-decision-stability.ja.md`
  - focuses on decision parsing stability
  - this issue is the next step: convergence control and self-healing
