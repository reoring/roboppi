# Branch drift & unintended changes due to BASE_BRANCH dependence

Status: proposal

## Problem

When running the controller loop, the workflow assumes `BASE_BRANCH` is manually specified. If it is missing or incorrect, the workflow can proceed from an unintended branch (e.g. `main`).

This can result in:

- unrelated diffs or deletions showing up
- having to abort and re-run
- high cognitive load to understand "which branch is the actual base"

## Observed Symptoms

- the branch assumed at startup and the branch actually touched by bootstrap/implement can diverge
- needing to re-specify `BASE_BRANCH` or edit the run script repeatedly
- logs alone do not make the effective base branch immediately obvious

## Root Causes

1. base-branch resolution sources are scattered (script/env/workflow defaults)
2. the startup "current branch" is not treated as a safe default
3. fail-fast guards for branch drift during a run are weak
4. observability for the resolved branch (startup logs/artifacts) is insufficient
5. the meaning of `BASE_BRANCH` (diff base vs new-branch parent) is ambiguous and operational interpretation varies

## Terminology / Assumptions

In this issue, branch drift means: the repo/branch/commit expected at startup differs from what is used at execution time.

- `startup_toplevel`: `git rev-parse --show-toplevel` at startup
- `startup_branch`: branch name at startup (can be `HEAD` in detached state)
- `startup_head_sha`: `HEAD` commit SHA at startup
- `effective_base_branch`: resolved base branch (fixed once at startup)
- `effective_base_branch_source`: which source won (`cli|env|current`)
- `effective_base_sha`: commit SHA of `effective_base_branch` at startup (fixed for reproducibility)
- `expected_work_branch`: the branch where edits/commands are executed
- `expected_current_branch`: branch expected right before step execution (helper to make transitions explicit)
- `protected_branches`: branches that should not be modified by default (e.g. `main`, `master`, `release/*`)
- `protected_branches_source`: which source won (`default|env|cli`)
- `allow_protected_branch`: explicit override to disable the guard (dangerous; opt-in)

Also, `BASE_BRANCH` can carry at least two responsibilities; the implementation must make this explicit:

1. parent branch used when `create_branch=true`
2. base for diffs/comparisons/safety guards

(If these need to be split in the future, that is out of scope for this issue.)

## Goals

1. Move default behavior toward the safe side (use the startup current branch as the base)
2. Keep explicit override (`BASE_BRANCH`)
3. Detect branch drift early and stop the run
4. Make effective branch configuration traceable via logs and artifacts
5. Persist both the "source" and the exact base commit SHA so the run can be reproduced later

## Approach

## 1) Make the BASE_BRANCH resolution order explicit

Fix a single priority order:

1. explicit specification (CLI option or `BASE_BRANCH`)
2. if unspecified, use `git rev-parse --abbrev-ref HEAD` (startup current branch)

Additionally, require:

- persist `effective_base_branch_source` alongside the resolved branch (`cli|env|current`)
- record `effective_base_sha` into context at startup (do not rely on branch name only)
- if in detached HEAD and base is unspecified, fail fast (require a normal branch checkout)
- if `BASE_BRANCH` is specified and differs from `startup_branch`, print a warning ("diff base is X, startup branch is Y")

## 2) Introduce a Branch Lock

- fix `effective_base_branch` at startup and persist it into context
- validate the current branch before each step (bootstrap/implement, etc.)
- on mismatch, immediately `FAILED` with a reason and recovery steps

Validation must not be limited to branch name:

- capture `startup_toplevel` / `startup_branch` / `startup_head_sha` at startup
- before each step, verify the run is occurring in the same repo (`startup_toplevel`) (detect wrong worktree)
- keep `expected_work_branch` (or per-step `expected_current_branch`) in context and validate it before each step
- if `create_branch=true` legitimately transitions branches, update `expected_*` at the transition point and make allowed transitions explicit

## 3) Make branch creation policy explicit

- document workflow-specific defaults and semantics for `create_branch`
- if `create_branch=false`, run only on an existing branch
- if `create_branch=true`, log the destination and parent branch at startup

Add safety guards:

- if `create_branch=false` and `expected_work_branch` matches `protected_branches`, stop by default (allow only with explicit override)
- if `create_branch=true`, ensure artifacts/logs guarantee the branch was created from `effective_base_sha` (not just by name)

Fix defaults and override mechanisms for `protected_branches`:

- default: `protected_branches = ["main", "master", "release/*"]`
  - goal: prevent direct edits on main/master and reduce accidental edits on release branches
  - guard target: `expected_work_branch` (the branch being modified), not `effective_base_branch`
- pattern semantics: if a string contains `*`, treat it as a glob (e.g. `release/*`); otherwise require exact match
- configuration (list override):
  - CLI: `--protected-branches <csv>` (e.g. `main,master,release/*`)
  - env: `ROBOPPI_PROTECTED_BRANCHES=<csv>`
  - priority: CLI > env > default
- temporary override (disable guard; must be explicit):
  - CLI: `--allow-protected-branch`
  - env: `ROBOPPI_ALLOW_PROTECTED_BRANCH=1`
  - even when enabled, persist `allow_protected_branch: true` into startup logs/context and emit a strong warning

## 4) Improve observability

Immediately after startup, print at least:

- `startup_branch`
- `startup_head_sha`
- `startup_toplevel`
- `effective_base_branch`
- `effective_base_branch_source`
- `effective_base_sha`
- `create_branch`
- `expected_work_branch` (when needed)
- `protected_branches` / `protected_branches_source`
- `allow_protected_branch` (when needed)

Also persist the same information in an artifact such as `context/_workflow.json`.

## Implementation Plan

1. commonize branch resolution at run startup
2. persist `effective_base_branch` into workflow context
3. add a pre-step hook to validate branch state
4. standardize mismatch error messages
5. update run scripts/docs to assume "current branch by default"
6. add schema/artifacts for `effective_base_branch_source` / `effective_base_sha` / `startup_head_sha` / `startup_toplevel`
7. add a `protected_branches` resolver (default + `ROBOPPI_PROTECTED_BRANCHES` + `--protected-branches`)
8. add protected-branch guard + explicit override (`ROBOPPI_ALLOW_PROTECTED_BRANCH` / `--allow-protected-branch`) and log the reason

## Acceptance Criteria

1. when started without `BASE_BRANCH`, the startup current branch is automatically used
2. if the branch deviates during execution, the run stops before entering an implementation step
3. effective branch config (branch/source/SHA) is uniquely recoverable from logs and context artifacts
4. explicit `BASE_BRANCH` overrides the default (and emits a warning when appropriate)
5. with `create_branch=false`, attempting to run on a protected branch stops unless explicitly overridden
6. without `ROBOPPI_PROTECTED_BRANCHES` / `--protected-branches`, `protected_branches` resolves to `main,master,release/*` and `protected_branches_source=default`
7. with `ROBOPPI_PROTECTED_BRANCHES` or `--protected-branches`, the list is overridden and `protected_branches_source=env|cli` is recorded
8. with `ROBOPPI_ALLOW_PROTECTED_BRANCH=1` or `--allow-protected-branch`, `allow_protected_branch=true` is recorded in logs/context

## Non-goals

- introducing automatic rebase/merge strategies
- rewriting existing workflows wholesale

## Known Risks & Mitigations

1. running from detached HEAD
- mitigation: fail fast with a clear error; require a normal branch checkout

2. mis-detection with multiple worktrees
- mitigation: persist `git rev-parse --show-toplevel` alongside branch info

3. operational behavior changes for existing users
- mitigation: keep compatibility mode (explicit `BASE_BRANCH` still wins) and migrate gradually

4. accidental direct modification of protected branches
- mitigation: enable `protected_branches` guard by default; require explicit override

5. default `release/*` might block some workflows
- mitigation: allow overriding `ROBOPPI_PROTECTED_BRANCHES` / `--protected-branches` (e.g. restrict to `main,master`); for emergencies require explicit `ROBOPPI_ALLOW_PROTECTED_BRANCH=1` / `--allow-protected-branch` with warnings
