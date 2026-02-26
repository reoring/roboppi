# Sentinel: Autonomous Workflow Oversight (DSL + Runtime Design)

Status: implemented (v1)

This document defines a "Sentinel" feature for Roboppi workflows.

Sentinel is an autonomous (runner-owned) control component that runs *alongside*
normal step execution (it is not a workflow step itself). It:

- provides a bird's-eye view of workflow execution via structured telemetry
- detects stalled / non-productive work early (not just via timeouts)
- interrupts the minimum scope safely and deterministically
- leaves machine-readable artifacts (reasons + fingerprints) so existing
  completion loops can converge quickly

Additionally, Sentinel can run independent, workflow-defined probe commands
(e.g., `kubectl`) while a step is running to classify:

- progressing (keep waiting)
- stalled (interrupt early)
- terminal (stop waiting; surface actionable failure identity)

This is motivated by real workflows that involve infrastructure bring-up and
Kubernetes waits (e.g., CRD drift / missing dependencies) where waiting until a
timeout is both expensive and low-signal.

Related design notes and issues:

- docs/issues/0009-stall-sentinel-early-interruption.md
- docs/issues/0008-completion-check-proactive-wait-minimization.md
- docs/issues/0004-implement-loop-self-healing.md
- docs/workflow-design.md

---

## 1. Problem Statement

Workflows that provision infrastructure, deploy controllers, and run tests
often contain long waits and/or commands that can hang. Today:

- a stall is discovered late (step timeout, or workflow timeout)
- the loop only reacts after the step returns
- repeated identical stalls consume iterations and wall time
- the workflow's completion contract usually lacks stable failure identity
  (fingerprints), so convergence controls cannot help

Concrete example class (not Roboppi-specific):

- Kubernetes readiness waits (CRD existence, rollout, reconcile)
- CRD inconsistency / drift (a controller never installs a CRD, or installs a
  different version)
- upstream controllers are unhealthy (OOMKilled / CrashLoop), but the wait loop
  still runs until timeout

We want a mechanism that can:

- detect "this wait is not progressing" early
- interrupt and preserve signal (what was observed, why we stopped)
- feed back into the normal implement/fix loop deterministically

---

## 2. Goals / Non-goals

Goals:

1. Provide a workflow-level, structured execution overview that can be consumed
   by:
   - humans (TUI, logs, artifacts)
   - completion_check workers (decision_file JSON)
   - convergence control (fingerprints)
2. Detect stalls earlier than timeouts using deterministic, secret-safe
   signals.
3. Interrupt the minimum scope (current step process group) rather than killing
   the whole workflow.
4. Record a stable event contract (JSON) with fingerprints suitable for
   comparing across iterations.
5. Integrate with existing Roboppi workflow primitives:
    - completion_check loops
    - convergence controller
    - subworkflow steps (bubble events + exports safety)

6. Allow a workflow to declare per-step "guard" policies that:
   - monitor runtime conditions outside the step script (e.g., cluster health)
   - interrupt the running command deterministically
   - decide whether the workflow should retry, continue (as INCOMPLETE), or fail

Non-goals:

- Perfect root-cause classification of every infra failure.
- Emitting or collecting secret material (tokens, kubeconfig bodies, Secret
  data). Sentinel must be secret-safe by default.
- Replacing domain-specific "probe-aware waits" inside application scripts.
  Sentinel complements them; it does not eliminate the need for good waits.

---

## 3. Core Concepts

### 3.1 Telemetry (bird's-eye view)

Sentinel relies on an execution telemetry surface that is:

- structured (JSON)
- append-only for events (JSONL)
- safe to store in a workspace
- free of secrets by default

Telemetry is a first-class artifact of workflow execution, not an incidental
side effect of console logs.

### 3.2 Stall signals

Sentinel detects stalls (and terminal conditions) using one or more signals:

1. No-output deadline
   - "no worker output for X time"
   - good for hard hangs
2. Probe-based no-progress
    - periodically run a secret-safe probe command
    - classify probe output as progressing | stalled | terminal
    - hash / normalize probe output and detect "no change" over N intervals
    - best for Kubernetes waits that keep printing the same message
3. (Optional, conservative) terminal patterns
    - regex matches in output
    - disabled by default to avoid secret leakage and brittleness

Probe classification is the primary mechanism for "external" checks (e.g.
cluster health via `kubectl`) that are independent from the step's own output.

### 3.3 Intervention semantics

When Sentinel triggers, it can act at different levels:

- interrupt the running step/check attempt (preferred)
- treat the interruption as INCOMPLETE (for completion_check loops, or to allow
  the workflow to continue past a guarded step)
- fail the step (and optionally force-abort) if configured

Important: Sentinel is runner-owned and works *outside* the step script. It does
not require (and should not assume) that the step cooperates or prints useful
progress.

The minimum viable implementation is "interrupt the step" via cancellation.
More precise signal escalation (SIGINT -> SIGTERM -> SIGKILL) is desirable but
may be phased in.

### 3.4 Artifacts and fingerprints

Every Sentinel trigger must produce artifacts:

- a machine-readable event JSON
- optional probe time series
- pointers to other relevant logs/artifacts

Fingerprints must be:

- stable across iterations
- short
- composable
- safe for convergence (string compare)

Examples:

- stall/no-output
- stall/no-progress
- k8s/crd/missing:k0smotrondockerclusters.cluster.appthrust.io
- k8s/controller/oomkilled:flux-system/source-controller

### 3.5 "Redo" and control outcomes

Sentinel's core control action is interruption (cancellation), but workflows
usually want a deterministic *outcome*:

- retry the step attempt ("redo")
- continue the workflow (e.g., mark as INCOMPLETE so downstream can run)
- break/abort early with a stable failure identity

This requires that the executor can distinguish "interrupted by Sentinel" from
"workflow cancelled/timed out" and can map the interruption into a stable
result contract (reasons + fingerprints + error class).

---

## 4. Proposed Workflow DSL Extensions

Sentinel should primarily be configured in the workflow DSL, so the behavior is
declarative and reviewable.

There are two configuration surfaces:

1. Workflow-level sentinel defaults and telemetry
2. Step-level stall policy overrides

### 4.1 Workflow-level `sentinel` (new)

Add an optional top-level `sentinel:` block.

```yaml
name: my-workflow
version: "1"
timeout: "2h"

sentinel:
  enabled: true

  telemetry:
    # Default location is under context_dir (default: ./context)
    events_file: "_workflow/events.jsonl"
    state_file: "_workflow/state.json"
    # Secret-safe default: do not include raw stdout/stderr.
    include_worker_output: false

  defaults:
    # Auto-applied to all steps/checks that don't have `stall: { enabled: false }`.
    # Steps without a `stall:` block inherit these defaults entirely.
    # Steps with a `stall:` block that omit certain fields get those fields
    # merged in from defaults.
    no_output_timeout: "15m"
    # Controls which event timestamps drive no_output_timeout.
    # - "worker_event" (default): worker stdout/stderr timestamps
    # - "any_event": most recent of worker_event, step_phase, step_state
    # - "probe_only": disable timer-based no_output; rely on probe
    activity_source: "worker_event"
    interrupt:
      strategy: cancel
      # Future: escalation policy (SIGINT -> SIGTERM -> SIGKILL)
      # signals: [SIGINT, SIGTERM, SIGKILL]
      # grace_int: "10s"
      # grace_term: "20s"
```

Notes:

- `telemetry.*_file` paths are relative to `context_dir`.
- `include_worker_output=false` is the default. When false, telemetry contains
  metadata only (timestamps, sizes, event kinds), not the content.
- When `sentinel.enabled=true` and `defaults` provides detection mechanisms
  (e.g. `no_output_timeout`), ALL steps and completion checks are automatically
  guarded. Steps that want to opt out must explicitly set
  `stall: { enabled: false }`.

### 4.2 Step-level `stall` policy (new)

Add optional `stall:` to step definitions.

`stall:` is a *guard policy* consumed by the runner-owned Sentinel; it does not
execute as part of the step itself.

```yaml
steps:
  provision:
    worker: CUSTOM
    instructions: |
      bash scripts/provision.sh
    capabilities: [READ, RUN_COMMANDS]
    timeout: "75m"

    stall:
      # Disable/enable explicitly (default: inherit from workflow sentinel.enabled)
      enabled: true

      # Trigger when the step has no worker output events for this duration.
      no_output_timeout: "20m"

      # Controls which event timestamps drive no_output_timeout (optional).
      # Useful for BATCH/CUSTOM workers that don't emit worker_event.
      # Values: "worker_event" (default) | "any_event" | "probe_only"
      activity_source: "worker_event"

      # Optional probe-driven no-progress detection.
      probe:
        interval: "10s"
        timeout: "5s"
        command: |
          # Must print exactly one JSON object (secret-safe) to stdout.
          bash scripts/sentinel-probe.sh --mode provision
        # How many consecutive identical probe digests count as stalled.
        stall_threshold: 12
        # Opt-in: capture probe stderr in probe.jsonl for diagnostics.
        # Default: false (stderr is NOT persisted, preventing secret leakage).
        capture_stderr: false
        # When true, probe success requires exit_code === 0 AND valid JSON.
        # Default: false (JSON parse success is the sole criterion).
        require_zero_exit: false
        # Action when probe consecutively fails (non-zero exit, invalid JSON, timeout).
        # "ignore" (default): skip failed probe, keep watching
        # "stall": treat as stall after threshold (triggers on_stall action)
        # "terminal": treat as terminal after threshold (triggers on_terminal action)
        on_probe_error: "ignore"
        # How many consecutive probe failures before triggering on_probe_error action.
        # Default: 3, minimum: 1.
        probe_error_threshold: 3

      # Behavior when the probe reports a terminal condition.
      # (e.g., missing CRD + upstream controller CrashLoopBackOff)
      on_terminal:
        action: fail              # interrupt | fail | ignore
        error_class: NON_RETRYABLE
        fingerprint_prefix: ["phase/provision"]

      on_stall:
        action: interrupt        # interrupt | fail | ignore
        # For step interruption, map the resulting cancellation into an error
        # class. This enables deterministic retry/continue policies without
        # relying on free-text logs.
        #
        # Recommended defaults:
        # - interrupt => RETRYABLE_TRANSIENT (allows redo when configured)
        # - fail      => NON_RETRYABLE (or FATAL to force workflow abort)
        error_class: RETRYABLE_TRANSIENT
        fingerprint_prefix: ["phase/provision"]
```

Interpretation:

- `no_output_timeout` and `probe` can be combined.
- `probe` should be used when the step continues to print output but does not
  progress.
- `fingerprint_prefix` lets you attach stable context to every event.

Probe output contract (v1):

- The probe command prints exactly one JSON object.
- Sentinel recognizes these optional fields:
  - `class`: "progressing" | "stalled" | "terminal"
  - `digest`: string (if omitted, runner computes a digest from the JSON)
  - `fingerprints`: string[] (stable identifiers; secret-safe)
  - `reasons`: string[] (short, human-readable; secret-safe)
  - `summary`: object (bounded, secret-safe)

Rules:

- `class=terminal` triggers `on_terminal` immediately.
- `class=progressing` resets the no-progress counter.
- Otherwise, digest equality is used for no-progress detection.

`as_incomplete` (optional):

- `as_incomplete` currently applies only to `completion_check` stall policies.
  When set under `on_stall` or `on_terminal` of a completion_check's `stall:`
  block, Sentinel maps the trigger into an INCOMPLETE outcome:
  - return `complete=false` and `failed=false`
  - the completion_check loop continues (the interruption is not a fatal failure)
- For step body interruptions (not completion_check), the result is mapped to
  FAILED with the configured `error_class`. To allow downstream steps to proceed
  after a step body stall, use workflow-level `on_failure: continue`.

### 4.3 Completion-check stall policy (optional)

For long-running completion checks (e.g., "verify" that does Kubernetes waits),
allow `stall:` inside `completion_check:`.

```yaml
steps:
  implement:
    # ...
    completion_check:
      worker: CUSTOM
      instructions: |
        bash .roboppi-loop/verify.sh
      capabilities: [READ, RUN_COMMANDS]
      timeout: "60m"
      decision_file: .roboppi-loop/review.verdict

      stall:
        enabled: true
        probe:
          interval: "10s"
          command: |
            bash scripts/sentinel-probe.sh --mode verify
          stall_threshold: 6
        on_terminal:
          # For completion checks, terminal conditions are usually actionable
          # work remaining (not a fatal checker failure): stop waiting and
          # return INCOMPLETE with fingerprints.
          action: interrupt
          as_incomplete: true
        on_stall:
          action: interrupt
          as_incomplete: true
```

Key requirement:

- when Sentinel interrupts a completion_check, the workflow should be able to
  treat it as "incomplete" (not a fatal checker failure) and continue the loop.
  See Section 6.4.

### 4.4 Artifact paths and reserved names

Sentinel writes internal artifacts under the context directory.

Proposed paths:

- Workflow telemetry:
  - `<context_dir>/_workflow/events.jsonl`
  - `<context_dir>/_workflow/state.json`
- Per-step stall artifacts:
  - `<context_dir>/<stepId>/_stall/event.json`
  - `<context_dir>/<stepId>/_stall/probe.jsonl` (optional)

Implementation note:

- `_stall` should become a reserved artifact directory name (similar to
  `_convergence`) to avoid collisions with user-declared outputs.

---

## 5. Artifact Contract

### 5.1 Step stall event (`event.json`)

When a stall triggers, Sentinel must write a single JSON file.

Schema (v1 proposal):

```json
{
  "schema": "roboppi.sentinel.stall.v1",
  "workflow": {
    "workflow_id": "...",
    "name": "..."
  },
  "step": {
    "id": "provision",
    "iteration": 2,
    "phase": "executing"
  },
  "trigger": {
    "kind": "no_output|no_progress|terminal",
    "reason": "no probe progress for 12 intervals",
    "observed_at": 1739999999000
  },
  "action": {
    "kind": "interrupt",
    "strategy": "cancel",
    "terminated": true
  },
  "reasons": [
    "probe digest unchanged"
  ],
  "fingerprints": [
    "stall/no-progress",
    "phase/provision",
    "k8s/crd/missing:k0smotrondockerclusters.cluster.appthrust.io"
  ],
  "pointers": {
    "probe_log": "context/provision/_stall/probe.jsonl",
    "telemetry": "context/_workflow/events.jsonl"
  }
}
```

Notes:

- `fingerprints[]` is the primary convergence key.
- `reasons[]` is human-readable, short.

For probe-driven triggers, the event SHOULD also include probe-derived
fingerprints/reasons when present (v1: merge into the arrays above).

### 5.2 Probe log (`probe.jsonl`)

If a probe is configured, append one JSON object per probe run:

```json
{"ts":1739999999000,"digest":"...","summary":{"crd_missing":["..."]}}
```

Probe output requirements:

- secret-safe (no tokens, kubeconfig bodies, Secret data)
- bounded size (truncate/normalize inside the probe script)

---

## 6. Runtime Design (Implementation-oriented)

This section maps the DSL design to concrete code changes.

### 6.1 Architecture placement

Sentinel belongs to the workflow runner/executor layer, not inside the worker.

- It must be able to interrupt a running step.
- It must observe step execution in real time.
- It should not rely on LLM behavior.

In Roboppi's codebase, that naturally places it in:

- src/workflow/executor.ts (control loop)
- src/workflow/parser.ts + src/workflow/types.ts (DSL)
- src/tui/exec-event.ts + sinks (telemetry)

### 6.2 Telemetry recording

Implement a composable ExecEvent sink wrapper:

- `TelemetrySink(inner, contextDir, options)`
  - forwards events to `inner.emit(event)`
  - appends a redacted form to `events.jsonl`
  - maintains an in-memory snapshot and periodically writes `state.json`

Redaction policy (default):

- store timestamps and event type
- for worker_event, store:
  - event kind (stdout/stderr/progress/patch)
  - byte length (optional)
  - but not content

This makes the telemetry safe to persist and share.

Implementation requirement:

- Sentinel needs *real-time* activity signals (worker_event timestamps) even
  when the UI is disabled. In supervised mode, this means the runner must be
  able to request streaming events without necessarily rendering a TUI.

### 6.3 Activity tracking

Maintain per-step activity timestamps:

- last worker output event timestamp
- last step_phase timestamp
- last step_state transition timestamp

Sentinel uses these for `no_output_timeout` and for general "liveness".

Implementation sketch:

- `ActivityTracker.onEvent(ExecEvent)` updates per-step counters
- When a step starts running, register it with Sentinel watchers
- When a step finishes, stop watchers

### 6.4 Interrupting a step (and treating completion_check stalls as INCOMPLETE)

Minimum viable interruption mechanism:

- the executor MUST create a step-local AbortController for each running step
  attempt and each running completion_check attempt
- Sentinel aborts *only that controller*
  - supervised mode: abort triggers cancel_job in Core (via step runner)
  - direct mode: abort propagates to ProcessManager via adapters

This is required to support "stop the current command and redo" without
aborting the entire workflow.

However, we must carefully integrate with completion_check loops.

Desired semantics:

- If Sentinel triggers during a completion_check "verify" and `as_incomplete`
  is enabled:
  - interrupt the checker
  - record event.json
  - return a CheckResult with:
    - `complete=false`
    - `failed=false`
    - `reason`/`fingerprints` populated from the sentinel event

This requires an adjustment because today most StepRunner implementations treat
"worker cancelled" as `failed=true`, and step cancellation is not distinguishable
from workflow cancellation.

Implementation options:

Option A (recommended): align check semantics with docs/workflow-design.md

- Update StepRunner implementations to treat checker failure with
  `ErrorClass.RETRYABLE_TRANSIENT` as "incomplete".
- When Sentinel interrupts a check, encode it as a retryable transient
  condition (not NON_RETRYABLE), so the loop continues.

Option B: executor-level override

- executor wraps StepRunner.runCheck and, if it knows the abort was caused by
  Sentinel, converts the result into `failed=false`.
- This requires tagging the abort reason (not just AbortSignal).

Option A has the advantage that it improves correctness beyond Sentinel.

"Redo" semantics for steps (non-check):

- When Sentinel interrupts a running step attempt, the executor should map the
  interruption into a StepRunResult with an appropriate `errorClass` (default:
  `RETRYABLE_TRANSIENT`) and stable fingerprints.
- Workflows can then use existing `on_failure` + `max_retries` to decide whether
  to redo the step or break/continue.

### 6.5 Probe runner

Probes must run concurrently with the guarded step.

Implement a small ProbeRunner utility:

- uses ProcessManager (short-lived processes)
- has hard timeouts per probe run
- captures stdout only (bounded) and requires valid JSON
- computes a digest from the normalized JSON
- inherits the workflow-level `env` (merged with `process.env`), so kubeconfig
  paths, auth tokens, and other environment variables set in the workflow are
  available to probe commands

Digesting strategy:

- default: stable JSON stringify of the parsed object
- preferred: allow a probe to emit `{"digest":"...", ...}`
  to avoid runner-side canonicalization complexity

Classification strategy (v1):

- If the probe emits `class=terminal`, treat it as an immediate trigger.
- If the probe emits `class=progressing`, reset the no-progress counter.
- Otherwise, use digest equality to count consecutive "no change" intervals.

### 6.6 Stall evaluation loop

For each guarded step/check, Sentinel starts watchers:

- No-output watcher:
  - periodically checks `now - lastWorkerOutputTs`
- Probe watcher:
  - every interval, run probe, compute digest
  - maintain `sameDigestCount`
  - trigger terminal immediately when classified
  - trigger no-progress when `sameDigestCount >= stall_threshold`

When triggered:

- write event.json (+ probe.jsonl already appended)
- interrupt the step/check
- publish a `warning` ExecEvent so TUI/logs surface the interruption

### 6.7 Integration with Convergence Controller

Sentinel emits stable fingerprints.

These fingerprints should be propagated into completion decisions so convergence
can detect repetition:

- completion_check decision_file JSON should include sentinel fingerprints
- executor convergence logic already reads `fingerprints[]` from CheckResult

This creates a layered system:

- Sentinel: intra-step stall detection
- Convergence: inter-iteration stall detection

### 6.8 Subworkflow steps

Subworkflow steps already support completion_check and convergence.

Sentinel integration points:

- allow `stall:` on subworkflow steps
  - no-output: based on bubbled child worker events, or on parent step activity
  - probe: typically workflow-specific (e.g., inspect exported artifacts)
- when `bubble_subworkflow_events=false`, child worker events are aggregated
  into the parent step id, which is still sufficient for no-output tracking

---

## 7. "Autonomous Agent" Modes

The core Sentinel is deterministic and runner-owned.

To satisfy more "agentic" use cases (richer diagnosis, adaptive probing), we
define three modes.

### Mode 1: Deterministic-only (default)

- Sentinel uses only configured time/probe rules
- actions are limited to interrupt/fail
- artifacts are purely machine-generated

### Mode 2: Agent-assisted diagnosis (opt-in)

On trigger, run a dedicated analysis worker step (LLM-backed) that:

- reads `event.json`, probe logs, and workflow telemetry
- writes a secret-safe diagnosis + plan artifact
- does not directly execute control actions

DSL sketch:

```yaml
sentinel:
  enabled: true
  assistant:
    worker: OPENCODE
    model: openai/gpt-5.2
    capabilities: [READ]
    instructions: |
      Analyze sentinel stall events and write next actions.
```

Implementation note:

- the executor can implement this as an internal "virtual step" that is run
  after interruption, or as a normal step wired via depends_on and inputs.

### Mode 3: Agent-driven control requests (advanced, strict)

Allow a sentinel agent to request safe control actions via a file-based control
plane.

Example:

- runner writes: `context/_control/state.json` (what is allowed)
- agent appends: `context/_control/requests.jsonl`
- runner validates and executes only allowlisted actions

This mode is powerful but must be opt-in and carefully constrained.

---

## 8. Security / Secret-safety

Sentinel must be safe by default.

Rules:

- Telemetry must not include raw stdout/stderr content unless explicitly
  enabled.
- Probe commands must be written to be secret-safe; runner should enforce:
  - max bytes
  - JSON parsing
  - optional allowlist of keys
- Stall artifacts must never store kubeconfig bodies, token values, or Secret
  manifests.

Recommendation:

- prefer probes that output only:
  - object existence
  - condition status/reason
  - restart counts / termination reason
  - small, bounded message previews

---

## 9. Testing Strategy

Unit tests:

- parser validates `sentinel` and `stall` blocks
- probe runner JSON parsing + digesting behavior
- no-output trigger based on synthetic ExecEvents
- probe no-progress trigger based on synthetic probe outputs
- artifact writing paths under context_dir

Integration tests:

- a workflow with a CUSTOM step that sleeps forever, with `no_output_timeout`
  set low -> sentinel interrupts
- a workflow with a CUSTOM step that prints output but never changes probe
  digest -> sentinel interrupts
- completion_check interrupted with `as_incomplete=true` -> loop continues

---

## 10. Adoption Plan (Incremental)

All phases 1–4 are implemented and tested.

- Phase 1 (telemetry): TelemetrySink writes `events.jsonl` and `state.json` — done
- Phase 2 (no-output stall): `no_output_timeout` watcher with cancellation and `event.json` — done
- Phase 3 (probe-based no-progress): ProbeRunner + digest comparison + `stall_threshold` — done
- Phase 4 (completion_check alignment): sentinel interruptions map to INCOMPLETE via `as_incomplete` — done
- Phase 4a (auto-guard): `sentinel.defaults` auto-guards all steps/checks without `stall: { enabled: false }` — done
- Phase 4b (probe env): probe commands inherit workflow-level `env` — done
- Phase 4c (probe error policy): `on_probe_error` / `probe_error_threshold` for consecutive probe failure handling — done
- Phase 5 (agent-assisted mode): not yet implemented (future)

---

## 11. Design Decisions (resolved)

1. **Naming**: step-level config uses `stall:` (not `sentinel:`)
2. **Defaults**: workflow-level `sentinel.defaults` applies when step `stall:` omits fields
3. **Digesting**: probe-provided `digest` takes priority; fallback is runner-computed SHA-256 of sorted JSON
4. **Cancellation**: cancel-only at v1 (SIGINT escalation not needed; `AbortController.abort()` is sufficient)
5. **Completion-check**: `as_incomplete: true` maps sentinel abort → `complete=false, failed=false` for retry loops
6. **Probe classification**: `class` is optional; when absent, digest equality drives stall detection
7. **Storage layout**: `_workflow/` is a directory containing `events.jsonl` and `state.json`
8. **UX**: TUI surfaces sentinel events via `warning` ExecEvent (dedicated panel is future work)
