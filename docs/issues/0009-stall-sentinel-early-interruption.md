# Stall sentinel: early interruption for workflow stalls (Kubernetes waits, CRD drift, etc.)

Status: proposal

## Problem

Infra-heavy workflows can get stuck in long, non-productive waits (or hangs) and only become actionable when a timeout fires.

This shows up clearly in `appthrust/platform` Issue 0042 (kest CI bring-up on PMC/ControlCluster):

- waits inside `verify.sh` (or a subworkflow phase) can loop for many minutes
- a single missing dependency (e.g. CRD missing due to upstream install failure) can still consume the full wait budget
- the fix loop cannot react until the command returns, so iteration time balloons
- workflows often end as `CANCELLED` / `SIGTERM` (e.g. exit code 143) near the workflow timeout, losing time and signal

Related observed symptom (CRD wait loop):

- `appthrust/platform/e2e/kest-env.sh` uses `retry_until_success ... 600 10 kubectl ... get crd <name>`
- when a required CRD never appears, it waits until timeout even when the failure is already terminal

Roboppi has convergence controls for *repeating failures across iterations*, but we still lack a first-class mechanism to:

- detect “this is stalled” *during a step*
- interrupt early
- emit a structured, stable diagnostic contract that completion_check can immediately convert into `fix.md` / next actions

## Goals

1. Detect stalls earlier than step/workflow timeouts using deterministic, secret-safe signals.
2. Interrupt the minimum scope (preferably the current process group / current phase command).
3. Persist structured artifacts (JSON) with stable `fingerprints[]` so loops can converge.
4. Integrate with existing Roboppi mechanisms:
   - completion_check decision files (`decision_file` JSON)
   - Convergence Controller (stall detection by fingerprint repetition)
   - subworkflow execution (bubble events + exports safety)

## Non-goals

- Perfect root-cause classification for every infra problem.
- Replacing domain-specific “probe-aware waits” in scripts (this proposal complements them).
- Emitting or collecting secret material (kubeconfig bodies, tokens, Secret data).

## Design Overview

Introduce a step-level **Stall Sentinel** (aka Stall Controller) in Roboppi.

The sentinel is a small runtime component that monitors a running step and, when a configured stall condition is met, performs an early interruption and records a structured event.

### Where it lives

Primary target: Roboppi Workflow Executor (runner) so it works for:

- worker steps (`worker: CUSTOM|CODEX_CLI|CLAUDE_CODE|OPENCODE`)
- completion_check workers (so “verify waits” can be cut short)
- subworkflow steps (sentinel guards the child run as a unit)

An immediate/low-lead-time mitigation remains viable in downstream repos:

- wrap long-running shell phases with an in-repo watchdog helper (the “Option A” approach in the original 0042 sentinel note)

But the root solution should be a runner feature.

## Stall Signals (deterministic)

The sentinel should support multiple, composable signals.

### Signal A: no-output deadline

Trigger when the step produces no stdout/stderr events for `no_output_timeout`.

- Works well for “hard hangs”
- Does *not* catch loops that keep printing the same error every N seconds

### Signal B: probe-based no-progress

Periodically execute a **probe command** (secret-safe) and track progress by hashing probe output.

- If the probe output hash does not change for `stall_threshold` consecutive probes -> stalled
- If the probe output indicates a terminal failure -> fail immediately

This is the primary mechanism for Kubernetes waits that emit output but do not progress.

Probe requirements:

- output must be secret-safe
- output should be stable/normalized to avoid spurious hash changes
- recommended format: single-line JSON (or JSONL for a time series)

### Signal C: terminal patterns (optional, conservative)

Allow a small set of terminal regex patterns (per step) to force early failure.

This is intentionally optional because string matching can be brittle. Prefer probes.

## Interruption Semantics

On trigger:

1. send SIGINT to the step process group
2. after `grace_int`, send SIGTERM
3. after `grace_term`, send SIGKILL

The sentinel should record what it did (signals, timestamps) in the event artifact.

## Artifact Contract

Write (workspace-relative) artifacts under the step context:

- `context/<stepId>/_stall/event.json`
- `context/<stepId>/_stall/probe.jsonl` (optional)
- `context/<stepId>/_stall/stderr.tail.log` (optional, redacted)

### event.json schema (proposal)

```json
{
  "check_id": "<ROBOPPI_COMPLETION_CHECK_ID or run id>",
  "workflow": "<workflow name>",
  "step_id": "<stepId>",
  "iteration": 3,
  "trigger": {
    "kind": "no_output|no_progress|terminal",
    "reason": "no probe progress for 8 intervals",
    "observed_at_unix": 1739999999
  },
  "action": {
    "signals": ["SIGINT", "SIGTERM"],
    "terminated": true
  },
  "fingerprints": [
    "stall/no-progress",
    "k8s/crd/missing:k0smotrondockerclusters.cluster.appthrust.io"
  ],
  "pointers": {
    "step_log": "context/<stepId>/_logs/worker.log",
    "probe_log": "context/<stepId>/_stall/probe.jsonl"
  }
}
```

Notes:

- Keep it stable and short: `fingerprints[]` should be suitable for convergence comparisons.
- `check_id` must prevent stale mixing across iterations.

## Integration With completion_check + Convergence

### completion_check

When the sentinel triggers during a completion_check worker:

- the checker should still write a structured `decision_file`:
  - `decision: "incomplete"`
  - include `fingerprints[]` from `event.json`
  - include brief `reasons[]` pointing to `context/<step>/_stall/event.json`

This turns “stalled wait” into a fast feedback loop: stop waiting, produce `fix.md`, continue.

### Convergence Controller

Convergence already escalates when the same `fingerprints[]` repeat.

By standardizing stall fingerprints (e.g. `stall/no-progress`, `k8s/crd/missing:<name>`), we can:

- switch strategies after N repeats (e.g., add deeper probes, tighten scope, or abort with a checklist)
- avoid wasting iterations on identical infra stalls

## Kubernetes/CRD Drift: Recommended Probes + Fingerprints

This is *workflow-specific*, but the runner should make it easy.

### CRD wait probe (example)

Probe command should summarize:

- CRD existence + `spec.versions[]`
- upstream installer status (HelmRelease / ClusterSummary / Package reconcile)
- high-signal controller health (OOMKilled / CrashLoopBackOff)

Example fingerprints:

- `k8s/crd/missing:<crd>`
- `k8s/crd/version-mismatch:<crd>`
- `k8s/helmrelease/failed:<ns>/<name>`
- `k8s/controller/oomkilled:<ns>/<name>`
- `k8s/wait/stalled:no-condition-change`

See also: `docs/issues/0008-completion-check-proactive-wait-minimization.md` (probe-aware waits inside scripts).

## Workflow DSL Surface (proposal)

Add an optional field (name TBD) to step definitions and completion_check:

```yaml
steps:
  provision:
    # ...
    stall:
      no_output_timeout: "15m"
      probe:
        interval: "10s"
        command: |
          # must be secret-safe JSON
          bash scripts/k8s-probe.sh --mode control
      stall_threshold: 6
      on_stall: interrupt   # interrupt|fail|ignore
```

Initial implementation can focus on `no_output_timeout` + `probe`.

## Implementation Plan (staged)

1. Add types + parser validation for `stall` config (opt-in).
2. Implement `StallController` in the workflow executor:
   - hooks into worker task streaming (output timestamps)
   - runs probe command on a timer (best-effort)
   - triggers interruption via ProcessManager (process group)
   - writes `context/<step>/_stall/event.json`
3. Add helpers for completion_check to import stall fingerprints into `decision_file`.
4. Tests:
   - unit: no-output trigger, probe no-progress trigger, artifact writing
   - integration: a fake long-running CUSTOM step + probe that never changes
5. Add an example workflow demonstrating a probe-aware stall sentinel.

## Acceptance Criteria

- A step with a stuck wait is interrupted before its timeout when the probe shows no progress.
- `context/<step>/_stall/event.json` is always emitted on interruption.
- completion_check can deterministically decide `incomplete` using the stall artifact and produce stable `fingerprints[]`.
- Convergence escalates when the same stall fingerprints repeat.
- All output is secret-safe.

## Related

- `docs/issues/0008-completion-check-proactive-wait-minimization.md` (domain-level probe-aware waits; CRD waits)
- `docs/issues/0004-implement-loop-self-healing.md` (Convergence Controller)
- `docs/wip/subworkflow-completion-loop.ja.md` (subworkflow loop + convergence)
- Case study notes originally drafted in `appthrust/platform/docs/roboppi/sentinel-agent-workflow-stall-interrupt.md`
