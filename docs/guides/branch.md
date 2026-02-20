# Branch Guide

This guide describes Roboppi's branch safety rules when running workflows.

Roboppi is often used against a git workspace (for example, the Agent PR Loop demo). In those workflows, a small mistake such as running from the wrong branch, changing worktrees mid-run, or forgetting to create a work branch can cause accidental edits and confusing diffs.

Roboppi addresses this with two mechanisms:

1. **Base branch resolution**: deterministically resolve an `effective_base_branch` and record its commit SHA.
2. **Branch Lock**: fail-fast if the workspace "drifts" away from the expected repo/branch during execution.

It also adds a **protected branch guard** to prevent direct edits on branches like `main` unless explicitly overridden.

---

## Terminology

These values are resolved at workflow startup (by `src/workflow/branch-context.ts`) and are used by the workflow runner/executor.

- `startup_toplevel`: `git rev-parse --show-toplevel` at startup.
- `startup_branch`: `git rev-parse --abbrev-ref HEAD` at startup.
- `startup_head_sha`: `git rev-parse HEAD` at startup.
- `effective_base_branch`: resolved base branch name.
- `effective_base_branch_source`: where `effective_base_branch` came from: `cli | env | current`.
- `effective_base_sha`: `git rev-parse <effective_base_branch>^{commit}` at startup.
- `expected_work_branch`: the branch the workflow is expected to *modify*.
- `expected_current_branch`: the branch the runner expects to be on *right before each step*.
- `protected_branches`: patterns treated as "do not edit directly".
- `protected_branches_source`: where `protected_branches` came from: `default | env | cli`.
- `allow_protected_branch`: explicit override that disables the protected branch guard.

---

## Base Branch Resolution

The base branch is resolved exactly once at startup.

### Inputs

- CLI: `--base-branch <name>`
- env: `BASE_BRANCH=<name>`
- fallback: current branch at startup (`startup_branch`)

### Priority

1. CLI `--base-branch`
2. env `BASE_BRANCH`
3. `startup_branch` (only if it is not detached)

If `startup_branch` is `HEAD` (detached HEAD) and neither CLI nor env provides a base branch, the runner fails fast.

### Recorded commit SHA

After `effective_base_branch` is selected, Roboppi resolves `effective_base_sha` from it at startup and records it for traceability and reproducibility.

### Override warning

If a base branch override is active (CLI/env) and it differs from `startup_branch`, the runner emits a warning so it is obvious that:

- your current working branch is not the base
- diffs / PR base operations may use a different branch than expected

---

## Workflow YAML Branch Fields

These fields are top-level workflow YAML fields (validated by `src/workflow/parser.ts`).

```yaml
create_branch: true|false
branch_transition_step: "branch"   # optional
expected_work_branch: "my-branch"  # optional
```

### `create_branch` (boolean)

Whether the workflow is expected to create/switch to a work branch.

- `false` (default): the workflow runs on the current branch.
- `true`: the workflow is expected to transition to a work branch during execution.

Roboppi does not create branches by itself; it enforces safety expectations around whatever branch-switching your steps perform.

### `branch_transition_step` (string)

Step id where the workflow transitions to the work branch.

- If omitted and `create_branch: true`, Roboppi defaults this to `branch` when a step named `branch` exists.
- After this step completes successfully, Roboppi reads the current branch and updates:
  - `expected_work_branch`
  - `expected_current_branch`

### `expected_work_branch` (string)

Optional explicit expected work branch at startup.

Use this for workflows that must run on a particular branch (for example, a maintenance workflow that should only run on `release/v1`). If set, Branch Lock will fail-fast before the first step if you are on a different branch.

---

## Branch Lock (Drift Detection)

Branch Lock is enabled automatically when the workspace is a git repository.

### What is checked

Before **every step**, the executor (see `src/workflow/executor.ts`) verifies:

1. **Worktree/repo match**: current `git rev-parse --show-toplevel` equals `startup_toplevel`.
2. **Branch match**: current `git rev-parse --abbrev-ref HEAD` equals:
   - `expected_current_branch` (preferred), else
   - `expected_work_branch`, else
   - `startup_branch`

If either check fails, the workflow fails before executing the step.

### Branch transition

If `create_branch: true` and a `branch_transition_step` is configured, then after that step succeeds Roboppi updates the expected branch to the currently checked-out named branch.

This makes workflows like "bootstrap -> branch -> implement -> review" safe: once the branch step checks out the new work branch, later steps are guaranteed to stay on it.

### Non-git workspaces

If the workspace is not a git repository, Branch Lock is disabled and the runner logs a warning.

---

## Protected Branch Guard

Protected branches are a fail-fast safety guard to avoid direct edits on important branches.

### Defaults

Default `protected_branches`:

```text
main, master, release/*
```

### Pattern matching

- A pattern without `*` is an exact match.
- A pattern with `*` is treated as a simple glob (only `*` is special) and matches any characters (including `/`).

Examples:

- `main` matches only `main`
- `release/*` matches `release/v1`, `release/2026-02`, etc

### When it blocks

At startup, if all of these are true:

- `create_branch: false`
- `expected_work_branch` matches `protected_branches`
- `allow_protected_branch` is not enabled

then Roboppi refuses to start the workflow.

This is intentionally strict because `create_branch: false` implies the workflow will edit on the current branch.

### How to configure

Override the protected list:

- CLI: `--protected-branches <csv>`
- env: `AGENTCORE_PROTECTED_BRANCHES=<csv>`
- priority: CLI > env > default

Disable the guard explicitly (dangerous):

- CLI: `--allow-protected-branch`
- env: `AGENTCORE_ALLOW_PROTECTED_BRANCH=1`

When override is enabled, the runner logs a warning and records the override in workflow metadata.

---

## What Roboppi Exports to Steps (Environment)

When the workflow is executed, Roboppi passes these values to each step as environment variables (see `src/workflow/run.ts` and `src/daemon/daemon.ts`).

Base / startup:

- `BASE_BRANCH` (set to `effective_base_branch`)
- `AGENTCORE_EFFECTIVE_BASE_BRANCH`
- `AGENTCORE_EFFECTIVE_BASE_BRANCH_SOURCE` (`cli|env|current`)
- `AGENTCORE_EFFECTIVE_BASE_SHA`
- `AGENTCORE_STARTUP_BRANCH`
- `AGENTCORE_STARTUP_HEAD_SHA`
- `AGENTCORE_STARTUP_TOPLEVEL`

Branch lock expectations:

- `AGENTCORE_CREATE_BRANCH` (`1` or `0`)
- `AGENTCORE_EXPECTED_WORK_BRANCH`
- `AGENTCORE_EXPECTED_CURRENT_BRANCH`

Protected branch guard:

- `AGENTCORE_PROTECTED_BRANCHES` (CSV)
- `AGENTCORE_ALLOW_PROTECTED_BRANCH` (`1` or `0`)

---

## Observability (Logs and Artifacts)

### CLI runner output

`src/workflow/run.ts` prints a Branch Lock summary before running steps, including:

- startup branch / SHA / toplevel
- effective base branch / source / SHA
- protected branches / source
- allow override state

### Context artifact

Workflow metadata is written to `context/_workflow.json` (see `src/workflow/context-manager.ts`). Branch fields are included as top-level keys such as:

```json
{
  "branch_lock_enabled": true,
  "startup_branch": "main",
  "effective_base_branch": "main",
  "effective_base_sha": "<sha>",
  "protected_branches": ["main", "master", "release/*"],
  "allow_protected_branch": false
}
```

### Daemon logs

In daemon mode, `src/daemon/daemon.ts` logs the resolved context with the same fields.

---

## Examples

Run a workflow using the current branch as the base (default):

```bash
roboppi workflow examples/agent-pr-loop.yaml --workspace /path/to/repo --supervised --verbose
```

Use a different base branch explicitly:

```bash
roboppi workflow examples/agent-pr-loop.yaml --workspace /path/to/repo \
  --base-branch main --supervised --verbose
```

Restrict protected branches to only main/master:

```bash
roboppi workflow examples/agent-pr-loop.yaml --workspace /path/to/repo \
  --protected-branches main,master --supervised --verbose
```

Allow execution on a protected branch (dangerous):

```bash
roboppi workflow examples/agent-pr-loop.yaml --workspace /path/to/repo \
  --allow-protected-branch --supervised --verbose
```

---

## Optional Step Toggles (Workflow-defined)

Some teams gate expensive or environment-dependent steps behind sentinel files checked by `CUSTOM` scripts.

Example (Appthrust Platform workflow):
- `.agentcore-loop/enable_live_validation`: if present, run the live-cluster validation step.
- `.agentcore-loop/live-validation.args`: optional extra args passed to the validation wrapper.

Behavior:
- sentinel file absent -> script exits `0` and the step is treated as skipped/pass.
- sentinel file present -> script runs the validation command and fails the workflow if the command fails.

Important:
- These files are conventions defined by the workflow/repo.
- AgentCore itself does **not** interpret `enable_live_validation`; it only runs the step command and uses the exit code.

---

## Notes / Gotchas

- Avoid exporting `BASE_BRANCH` globally in your shell; it can silently override the default "current branch" behavior. Prefer `--base-branch` when you need an override.
- If you start from a detached HEAD, you must pass `--base-branch` (or set `BASE_BRANCH`) so the runner can resolve a meaningful base.
- If your workflow transitions branches, make sure the transition step checks out a *named* branch. A detached HEAD after the transition step is treated as an error.
- The protected branch guard is evaluated at startup. If your `branch_transition_step` checks out a protected branch, it may bypass the startup guard; avoid doing that unless you also enable the explicit override.
