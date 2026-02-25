# completion_check wait optimization gap (cannot proactively detect stalled waits and converge early)

Status: proposal (needs implementation)

## Problem

In `platform-dev-0042`, long waits were observed:

- `e2e/kest-env.sh --need control` inside `verify.sh` kept retrying CRD waits on the ControlCluster side every 10 seconds
- typical logs:
  - `control crd present: k0smotrondockerclusters.cluster.appthrust.io`
  - `Error from server (NotFound): customresourcedefinitions.apiextensions.k8s.io "k0smotrondockerclusters.cluster.appthrust.io" not found`
- the default wait is 600 seconds (10-second interval), so it waits until timeout even when failure is obvious

Today, `completion_check` can only decide after `verify.sh` completes. This makes it slow to detect "this wait is non-productive" and connect to the `fix.md` loop.

## Current Behavior (Key points)

Targets:

- `../appthrust/platform/e2e/kest-env.sh`
- `../appthrust/platform/.roboppi-loop/verify.sh`
- `src/workflow/executor.ts`

Current flow:

1. `implement` changes code
2. `completion_check` runs `verify.sh`
3. `verify.sh` uses fixed-interval polling via `retry_until_success`
4. only after failure does it enter verdict/fix

Important points:

- `completion_check` cannot intervene until `verify.sh` returns
- `retry_until_success` does not detect "no progress" (time-based only)
- even immediately reproducible missing dependencies (NotFound, etc.) keep waiting

## Root Causes

1. wait logic is time-driven (timeout-driven)
- there is no cause classification when conditions are unmet (not deployed / permanent failure / missing dependency)

2. no progress detection
- it does not compare against previous observations (resourceVersion, condition changes, failed reason changes)

3. insufficient abstraction of failure signals
- there is only a `kubectl` error string; it does not decide if early failure is possible

4. slow connection to the fix loop
- `fix.md` is generated only after verify completes

## Goals

1. detect "no progress / terminal conditions" during waits and fail early
2. leave a machine-readable failure reason (fingerprint) on early exit
3. have `completion_check` immediately decide `incomplete` and enter the next fix iteration
4. reduce wait time while preserving compatibility

## Approach

## 1) Add a probe-aware wait primitive

Add `retry_with_probe` as an extension of `retry_until_success`.

Interface sketch:

- `condition_cmd`: success predicate
- `probe_cmd`: state collection (JSON output recommended)
- `classify_cmd`: classify probe results into `retryable | terminal_fail | progressing | stalled`
- `stall_threshold`: max consecutive "no progress" classifications
- `max_wait`: maximum wait seconds

Behavior:

- `terminal_fail`: fail immediately (do not wait for timeout)
- `stalled` exceeding threshold: fail early
- `progressing`: continue waiting

## 2) Initial failure classification rules

Implement at least the following for CRD waits:

- when `NotFound` continues:
  - if dependent HelmRelease/ClusterSummary is `Failed`, classify as `terminal_fail`
  - if dependency is `Progressing`, classify as `retryable`
- `Forbidden` / `Unauthorized`:
  - `terminal_fail` (permission issue)
- webhook/TLS errors:
  - `retryable` for a limited number of times, then `stalled` after threshold

## 3) Standardize diagnostic artifacts

On early failure, always emit:

- `context/<step>/wait-failure.json`
  - `check_id`, `phase`, `target`, `reason`, `fingerprints`, `elapsed_s`
- `context/<step>/wait-probe.log`
  - time series of probe outputs (secret-safe)

`completion_check` uses these to generate `review.verdict` / `fix.md`.

## 4) Force reason propagation into the verdict

Require at least the following in `review.verdict` JSON:

- `decision: "incomplete"`
- `reasons: [...]`
- `fingerprints: [...]`

Example fingerprints:

- `kest/control/crd-missing/k0smotrondockerclusters`
- `kest/control/helmrelease-failed/<release>`
- `kest/control/stalled/no-progress`

## 5) (Optional) Extend the Workflow DSL

Allow describing wait control in workflow definitions in the future.

Idea:

- a `wait_policy` field
  - `mode: timeout_only | probe_aware`
  - `stall_threshold`
  - `terminal_patterns`

Initial implementation can still provide major value by just refactoring functions inside `e2e/kest-env.sh`.

## Implementation Plan (Staged)

1. add `retry_with_probe` to `e2e/kest-env.sh`
- apply it first to `control crd present` waits

2. add probes for `ctl1` bring-up
- collect `CRD`, `HelmRelease`, `ClusterSummary`, `events`
- log in a secret-safe way

3. implement JSON output on early failure
- generate `wait-failure.json`

4. update `verify.sh` / completion_check prompts
- read `wait-failure.json` and translate into concrete `fix.md`

5. add Roboppi-side decision helpers
- connect to convergence control using `reasons/fingerprints` from `completion-decision`

## Acceptance Criteria

1. when CRD is missing and dependency has already failed, fail without waiting 600 seconds
2. on early failure, `wait-failure.json` is emitted
3. `completion_check` produces `incomplete` + `fix.md` and continues to the next iteration
4. do not prematurely abort healthy cases
5. logs are secret-safe (do not print kubeconfig bodies/tokens)

## Non-goals

- probe-ifying all wait points at once
- auto-repairing all external dependency failures

## Known Risks & Mitigations

1. misclassification (marking recoverable waits as `terminal_fail`)
- mitigation: keep `terminal_fail` conditions conservative at first and expand gradually

2. log bloat from probes
- mitigation: JSON summaries + tail retention + artifact size limits

3. increased implementation complexity
- mitigation: start with a single CRD wait point and converge on shared helpers incrementally

## Reference (Observed behavior)

- PMC/ControlCluster may eventually reach Provisioned in some cases
- yet specific CRDs never appear on the ControlCluster side, causing long waits
- dependency failures (chart not found / ownership metadata mismatch) can happen at the same time, making time-only waits converge slowly
