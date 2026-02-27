# Workflow Management Agent: Adaptive Supervisor for Runtime Workflow Control

Status: proposal (not yet implemented)

This document defines a "Workflow Management Agent" feature for Roboppi.

A Workflow Management Agent is an LLM-backed supervisor that runs *alongside*
the workflow executor and can **actively observe, advise, and intervene** in
workflow execution at runtime.  Unlike existing per-step hooks
(`completion_check`, `evaluate`, `analyze`), it operates at the **workflow
level** with a holistic view of all step states, and can make cross-cutting
decisions that affect the overall execution strategy.

Related design notes, existing features, and issues:

- docs/design.md (mechanism/policy separation, Supervisor layer)
- docs/workflow-design.md (DAG execution, completion_check, convergence)
- docs/daemon-design.md (evaluate gate, analyze)
- docs/features/sentinel.md (stall detection, telemetry, probes)
- src/workflow/completion-decision.ts (check_id correlation protocol)
- src/workflow/executor.ts (step lifecycle, depAllowsProgress/depBlocksDownstream)
- src/workflow/parser.ts (RESERVED_STEP_IDS, RESERVED_ARTIFACT_NAMES)

---

## 1. Problem Statement

Roboppi's current workflow execution is **declarative and static**: the DAG
structure, step definitions, and failure policies are all fixed at YAML parse
time.  Runtime adaptation is limited to per-step mechanisms:

| Existing mechanism | Scope | Limitation |
|---|---|---|
| `completion_check` | single step | cannot observe cross-step context |
| `convergence` | single step loop | detects stall but cannot change strategy |
| Sentinel stall guard | single step | interrupt-only; no reasoning about alternatives |
| Daemon `evaluate` | pre-workflow | runs before execution; cannot react to in-flight state |
| Daemon `analyze` | post-workflow | runs after completion; too late for course correction |

In practice, complex workflows encounter situations that require **holistic
runtime judgment**:

### 1.1 Concrete examples

**Cross-step diagnosis**: step A (implement) succeeds, but step B (test) fails
repeatedly.  A human would look at both outputs and realize the implementation
approach in step A needs to change — but `completion_check` on step B can only
see step B's artifacts.

**Strategy pivot**: a multi-repo migration workflow discovers that repo-a has
an unexpected architecture.  The remaining steps should use a different approach,
but the YAML instructions are static.

**Resource-aware scheduling**: three parallel steps are running, but the system
is slow.  A human would pause lower-priority steps and let the critical path
finish first.  The current DAG scheduler has no concept of runtime priority
adjustment.

**Early termination with summary**: after 5 iterations of an implement-review
loop, a human would judge "this is 90% done, the remaining issue is cosmetic —
ship it".  `completion_check` returns binary complete/incomplete; there's no
way to express "good enough".

**Adaptive instructions**: based on the review feedback in iteration 3, the
implementation instructions should include "do NOT use approach X, it was
rejected in review".  Currently, the worker receives the same static
instructions every iteration.

---

## 2. Goals / Non-goals

### Goals

1. Enable an LLM-backed agent to **observe workflow execution state** in real
   time, including all step states, artifacts, and telemetry.
2. Allow the agent to **advise or modify** step execution before it starts:
   adjust instructions, skip steps, or request additional context.
3. Allow the agent to **intervene** after step completion: override completion
   decisions, trigger early workflow termination, or request step re-execution
   with modified parameters.
4. Preserve Roboppi's **mechanism/policy separation**: Core safety invariants
   (Permit, cancellation, budget, Circuit Breaker) remain inviolable.  The
   management agent operates strictly within the policy layer.
5. Integrate naturally with existing primitives: `completion_check`,
   `convergence`, Sentinel, and the `ExecEventSink` telemetry surface.
6. Be **opt-in and incremental**: workflows without a management agent behave
   exactly as they do today.

### Non-goals

- Replacing the DAG scheduler with a fully dynamic planner (no arbitrary
  step insertion/deletion at v1).
- Giving the management agent access to Core internals (Permit issuance,
  Circuit Breaker state).
- Running the management agent inside a worker process (it is runner-owned,
  like Sentinel).
- Autonomous goal decomposition from a high-level objective (the workflow
  YAML still defines the step structure).

---

## 3. Architecture Overview

The management agent introduces a **4th conceptual layer** between the
existing Supervisor/Runner and the static DAG, without changing the Core or
Worker layers.

```
┌─────────────────────────────────────────────────────────────┐
│ Management Agent  (LLM-backed, runner-owned)                │
│  - observes all ExecEvents + telemetry + artifacts          │
│  - advises/intervenes via a structured control protocol     │
│  - operates within policy layer (cannot bypass Core)        │
├─────────────────────────────────────────────────────────────┤
│ Workflow Executor  (DAG scheduler, existing)                │
│  - reads management agent directives at hook points         │
│  - applies directives within safety constraints             │
├─────────────────────────────────────────────────────────────┤
│ Core  (mechanism: Permit, Budget, CB, Cancellation)         │
├─────────────────────────────────────────────────────────────┤
│ Workers  (Claude Code / Codex CLI / OpenCode / CUSTOM)      │
└─────────────────────────────────────────────────────────────┘
```

Key design constraint: the management agent communicates with the executor
via a **structured, validated protocol** — not by directly mutating executor
state.  The executor validates every directive against safety constraints
before applying it.

---

## 4. Core Concepts

### 4.1 Observation surface

The management agent receives the same event stream that Sentinel's
`TelemetrySink` records:

- `workflow_started` / `workflow_finished`
- `step_state` (status transitions, iteration counts)
- `step_phase` (executing, checking, collecting_outputs)
- `worker_event` (stdout, stderr, progress, patch — optionally redacted)
- `worker_result` (per-step outcomes)
- `warning` (sentinel triggers, convergence transitions)

Additionally, the agent can read:

- `context/` directory: step artifacts, `_meta.json`, `_resolved.json`
- `_convergence/` artifacts (state, stage transitions)
- `_stall/` artifacts (sentinel events, probe logs)
- `_workflow/state.json` (telemetry snapshot)

**Telemetry independence from Sentinel**: when `management.enabled=true` but
`sentinel.enabled` is not set, the executor MUST still create a
`ManagementTelemetrySink` that writes `_workflow/state.json` (step state
snapshot).  This is a subset of Sentinel's `TelemetrySink` — it records
step state transitions and timing, but not worker output or probe logs.

When both management and Sentinel are enabled, the Sentinel `TelemetrySink` is
reused and the management controller reads from the same files.

This gives the management agent a **complete, real-time picture** of
workflow execution — the same information a human operator would use.

### 4.2 Hook points

The executor invokes the management agent at well-defined hook points:

| Hook | Timing | What the agent can do |
|---|---|---|
| `pre_step` | before a READY step starts executing | modify instructions, skip step |
| `post_step` | after a step reaches a terminal state | override completion, adjust downstream |
| `pre_check` | before a completion_check runs | modify check instructions, force complete/incomplete |
| `post_check` | after a completion_check returns | override decision, adjust convergence strategy |
| `on_stall` | when Sentinel triggers a stall | diagnose, decide action (retry/fail/continue) |
| `periodic` | at configurable intervals during long steps | monitor progress, preemptive intervention |

Each hook invocation provides the agent with:
- current workflow state snapshot (all step states)
- the specific event that triggered the hook
- relevant artifacts and context

### 4.3 Hook invocation ID and staleness protocol

**Problem**: completion_check uses `check_id` (via `ROBOPPI_COMPLETION_CHECK_ID`
env var; see `src/workflow/completion-decision.ts`) to prevent the executor from
acting on stale or misattributed decision files.  The management agent needs an
equivalent mechanism.

**Design**: every hook invocation is assigned a unique `hook_id`
(`crypto.randomUUID()`).  The `hook_id` is:

1. Written into the hook input file (`input.json`).
2. Passed to the management worker as an environment variable
   (`ROBOPPI_MANAGEMENT_HOOK_ID`).
3. Required in the decision output (`decision.json` must contain a matching
   `hook_id` field).

Staleness rules (aligned with completion-decision.ts):

- If `hook_id` is present in decision and does not match: **reject** (stale).
- If `hook_id` is absent in decision but decision file `mtime` predates the
  hook invocation start: **reject** (stale).
- If `hook_id` matches: **accept**.
- If `hook_id` is absent in decision but `mtime` is recent: **accept** (backward
  compatibility grace period of 2 seconds, same as
  `STALE_DECISION_FILE_GRACE_MS`).

On rejection: log a warning, fall back to `{ action: "proceed" }`.

### 4.4 Per-invocation artifact isolation

**Problem**: with `concurrency > 1`, multiple hooks can fire in parallel (e.g.
`pre_step` for two independent steps).  A single `hook-input.json` /
`decision.json` path would cause write collisions.

**Design**: each hook invocation writes to an **isolated directory** keyed by
`hook_id`:

```
context/
  _management/
    decisions.jsonl               # append-only global log
    inv/
      <hook_id>/                  # per-invocation directory
        input.json                # hook context for this invocation
        decision.json             # agent's decision (decision_file)
```

The management worker receives:
- `ROBOPPI_MANAGEMENT_HOOK_ID` — the invocation ID
- `ROBOPPI_MANAGEMENT_INPUT_FILE` — absolute path to `input.json`
- `ROBOPPI_MANAGEMENT_DECISION_FILE` — absolute path to `decision.json`

After the invocation completes (success, timeout, or error), the decision is
parsed and appended to `decisions.jsonl`.

Cleanup: invocation directories older than the workflow's completion time may
be pruned.  During execution they are retained for debugging.

### 4.5 Directives (agent → executor)

The management agent responds with **directives** — structured commands that
the executor validates and applies.  Invalid or unsafe directives are rejected
with a reason.

```typescript
type ManagementDirective =
  | { action: "proceed" }                              // no change, continue normally
  | { action: "skip"; reason: string }                 // skip this step (see §4.6)
  | { action: "modify_instructions"; append: string }  // append to step instructions (see §4.7)
  | { action: "force_complete"; reason: string }       // override: mark complete
  | { action: "force_incomplete"; reason: string }     // override: mark incomplete
  | { action: "retry"; reason: string;
      modify_instructions?: string }                   // request re-run of current iteration
  | { action: "abort_workflow"; reason: string }       // request early termination (see §4.8)
  | { action: "adjust_timeout";
      timeout: DurationString; reason: string }        // extend/shrink step timeout (see §4.9)
  | { action: "annotate"; message: string }            // add an observation (no control effect)
```

**Removed from v1**: `defer` directive.  See §4.6 for rationale.

#### 4.5.1 Directive permission matrix

Not every directive is valid at every hook or step state.  The executor
validates against this matrix before applying:

| Directive | `pre_step` | `post_step` | `pre_check` | `post_check` | `on_stall` | `periodic` |
|---|---|---|---|---|---|---|
| `proceed` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `skip` | ✅ (READY only) | ❌ | ❌ | ❌ | ❌ | ❌ |
| `modify_instructions` | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ |
| `force_complete` | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| `force_incomplete` | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| `retry` | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| `abort_workflow` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `adjust_timeout` | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ |
| `annotate` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

If a directive is used at a disallowed hook, the executor rejects it (logs a
warning) and falls back to `proceed`.

#### 4.5.2 Required step states for directives

| Directive | Required step state(s) |
|---|---|
| `skip` | `READY` (not yet `RUNNING`) |
| `modify_instructions` | `READY` (pre_step) or `CHECKING` (pre_check) or `RUNNING` (on_stall — applies to retry) |
| `force_complete` / `force_incomplete` | step is in `CHECKING` (post_check) |
| `retry` | step just failed via Sentinel stall (on_stall) |
| `adjust_timeout` | `READY` (pre_step) or `CHECKING` (pre_check) — before timer starts |
| `abort_workflow` | any (always valid) |
| `annotate` | any (no state change) |

### 4.6 Skip semantics and the `OMITTED` status

**Problem**: the current `StepStatus.SKIPPED` blocks downstream steps
(`depBlocksDownstream` in `src/workflow/executor.ts` returns `true` for
`SKIPPED`).  If the management agent skips a step, downstream steps that
depend on it would also be skipped — which is usually not the intent.

**Design**: introduce a new `StepStatus.OMITTED`:

```typescript
enum StepStatus {
  // ... existing values ...
  OMITTED = "OMITTED",    // management agent chose to skip; does NOT block downstream
}
```

Update dependency resolution:

```typescript
// In depAllowsProgress():
if (depState.status === StepStatus.OMITTED) return true;   // ← new

// In depBlocksDownstream():
// OMITTED is NOT listed here (does not block)

// OMITTED is terminal:
const TERMINAL_STATUSES = new Set([
  // ... existing ...
  StepStatus.OMITTED,
]);
```

When the management agent issues `skip`:
- The step transitions to `OMITTED` (not `SKIPPED`).
- Downstream steps see `OMITTED` as "satisfied" (like `SUCCEEDED` or
  `INCOMPLETE`).
- The step's outputs are treated as empty (downstream inputs referencing
  this step's artifacts resolve to missing / empty).

`SKIPPED` retains its existing meaning: "blocked because an upstream step
failed with `on_failure != continue`".

**Removed: `defer` directive**.  The current executor state machine has no
`DEFERRED` state.  Setting a step back to `PENDING` from `READY` would cause
`updateReadySteps()` to immediately re-evaluate it as `READY` on the next tick
(since its dependencies are already satisfied), creating a busy loop.
Implementing proper deferral requires a `DEFERRED` state with a re-evaluation
deadline, which adds significant complexity.  This is deferred to a future
phase if the use case proves common.

### 4.7 Instruction modification: overlay model

**Problem**: `modify_instructions` as direct string concatenation causes
prompt bloat, especially when both the management agent and convergence
controller append text across iterations.

**Design**: instructions are composed from **ordered overlays**, not raw
string concatenation:

```typescript
interface InstructionOverlays {
  base: string;                  // original YAML instructions (immutable)
  convergence?: string;          // set by convergence controller (per-stage)
  management?: string;           // set by management agent (per-hook)
}
```

The effective instructions are composed at step execution time:

```
effective = base
  + "\n\n" + convergence   (if set, from convergence stage overlay)
  + "\n\n" + management     (if set, from management agent)
```

Key rules:

- `base` is **never modified**.  It is the workflow author's intent.
- `convergence` overlay is **replaced** (not appended) on each stage
  transition — this is the existing behavior in `applyConvergenceToStepDef`.
- `management` overlay is **replaced** (not appended) on each `pre_step`
  hook invocation.  If the management agent issues `modify_instructions`
  in iteration 3 and then `proceed` in iteration 4, the management overlay
  from iteration 3 is **cleared**.

This prevents unbounded prompt growth: each overlay has at most one active
value, and the management overlay is scoped to the current iteration.

The `[Management Agent]` prefix is still prepended for auditability:

```
[Management Agent]
IMPORTANT: Do not use recursive approach. Use iterative instead.
```

Storage: the effective overlay is recorded in `_management/inv/<hookId>/`
alongside the decision, and in `_resolved.json` for the step.

### 4.8 Workflow abort status

**Problem**: the current executor tracks `abortReason` as
`"timeout" | "external" | null`.  A management-initiated abort doesn't fit
cleanly: `null` abort maps to `TIMED_OUT`, which is incorrect.

**Design**: extend `abortReason`:

```typescript
private abortReason: "timeout" | "external" | "management" | null = null;
```

Update `computeWorkflowStatus()`:

```typescript
private computeWorkflowStatus(): WorkflowStatus {
  if (this.workflowAbortController?.signal.aborted) {
    switch (this.abortReason) {
      case "external":    return WorkflowStatus.CANCELLED;
      case "timeout":     return WorkflowStatus.TIMED_OUT;
      case "management":  return WorkflowStatus.CANCELLED; // or new ABORTED status
      default:            return WorkflowStatus.TIMED_OUT;
    }
  }
  // ... existing logic ...
}
```

For v1, management abort maps to `CANCELLED` with a `management_abort_reason`
field in workflow metadata.  A dedicated `WorkflowStatus.ABORTED` may be
introduced later if the distinction proves important for downstream consumers.

### 4.9 Timeout adjustment constraints

**Problem**: adjusting a step timeout while the step is running is impractical
because the deadline timer is created at launch time
(`createScopedAbort` in `src/workflow/multi-worker-step-runner.ts` captures
`deadlineAt` as a fixed value and sets a `setTimeout` immediately).

**Design**: `adjust_timeout` is **only valid at `pre_step` and `pre_check`
hooks** — before the step/check timer starts.

```
Hook fires (pre_step)
  → management agent returns adjust_timeout: "20m"
  → executor validates: min(20m, remaining workflow time, Core budget)
  → store override in stepTimeoutOverrides[stepId]
  → launchStep() reads override when creating the step runner
  → createScopedAbort uses the adjusted deadlineAt
```

At `post_step`, `post_check`, `on_stall`, and `periodic`, `adjust_timeout` is
rejected (logged as warning, falls back to `proceed`).

### 4.10 `retry` directive scope

**Problem**: a general `retry` directive (re-run a previously succeeded step)
requires DAG state rollback — invalidating downstream steps, clearing their
artifacts, and re-evaluating dependencies.  This is complex and error-prone.

**Design**: `retry` is **only valid at the `on_stall` hook** and applies to
the **current attempt/iteration** of the stalled step.  It means "try again
(within the existing `max_retries` / `max_iterations` budget) with optional
instruction modifications".

The executor maps `retry` to the same path as Sentinel's
`RETRYABLE_TRANSIENT` error class: the current attempt is marked failed, and
if budget remains, the step is re-run.  The optional `modify_instructions`
field sets the management overlay for the retry attempt.

Cross-step or cross-iteration retry is explicitly out of scope for v1.

### 4.11 Sentinel `on_stall` and management agent interaction

**Problem**: Sentinel's future Mode 3 ("agent-driven control requests" in
`docs/features/sentinel.md` §7) overlaps with the management agent's
`on_stall` hook.  Running two LLMs on the same stall event is wasteful.

**Design**: when both Sentinel and management are enabled:

1. Sentinel triggers the stall and writes `event.json` + `probe.jsonl` as
   usual (deterministic, no LLM).
2. If `management.hooks.on_stall=true`, the executor invokes the management
   agent **instead of** applying Sentinel's static `on_stall.action`.
3. The management agent receives Sentinel's `event.json` and probe data in
   the hook context and makes the decision.
4. If the management agent times out or returns an invalid directive, the
   executor falls back to Sentinel's static `on_stall.action`.

This means:
- Sentinel remains the **detection** layer (deterministic, fast).
- The management agent is the **decision** layer (LLM-backed, when enabled).
- They do not both invoke an LLM for the same event.
- Sentinel's Mode 2 ("agent-assisted diagnosis") is subsumed by the
  management agent's `on_stall` hook.  Mode 3 is deferred.

### 4.12 Management worker event isolation

**Problem**: the management worker itself emits `worker_event` (stdout,
stderr, etc.).  These events must not pollute the main TUI, telemetry, or
activity tracking (which would confuse Sentinel's no-output detection).

**Design**: the management worker runs with a **dedicated `ExecEventSink`**
that:

- Writes to `_management/inv/<hookId>/worker.jsonl` (for debugging).
- Does NOT forward events to the main sink.
- Does NOT update activity tracking timestamps.

Implementation: the `ManagementController` creates a `StepRunner` wrapper
(similar to `MappedStepRunner` for subworkflows) that substitutes a
`ManagementEventSink` instead of the main sink.

---

## 5. Proposed Workflow DSL Extensions

### 5.1 Workflow-level `management` block (new)

```yaml
name: implement-review-fix
version: "1"
timeout: "2h"

management:
  enabled: true

  agent:
    worker: OPENCODE
    model: openai/gpt-5.2
    capabilities: [READ]
    timeout: "30s"                # per-hook invocation timeout
    base_instructions: |
      You are a workflow management agent for Roboppi.
      Your role is to observe workflow execution and make strategic decisions.

      Rules:
      - Prefer "proceed" unless you have strong evidence for intervention.
      - When modifying instructions, be specific and concise.
      - Never include secrets or credentials in your responses.
      - Write your decision to the file specified by
        $ROBOPPI_MANAGEMENT_DECISION_FILE as JSON.
      - Include the hook_id from $ROBOPPI_MANAGEMENT_HOOK_ID in your response.

  # Which hooks are active (default: all disabled for safety)
  hooks:
    pre_step: true
    post_step: true
    pre_check: false
    post_check: true
    on_stall: true
    periodic: false

  # Optional: periodic monitoring interval (when periodic hook is enabled)
  periodic_interval: "2m"

  # Safety: max consecutive interventions before forcing "proceed"
  # (prevents runaway management agent loops)
  max_consecutive_interventions: 5

  # Safety: do not invoke management agent if remaining workflow time is
  # less than this (avoid spending budget on management when time is tight)
  min_remaining_time: "2m"
```

Note: there is no top-level `decision_file` field.  Decision files are
per-invocation (`_management/inv/<hookId>/decision.json`), and the path
is communicated to the worker via `ROBOPPI_MANAGEMENT_DECISION_FILE`.

### 5.2 Step-level overrides (optional)

Steps can opt out of management or customize behavior:

```yaml
steps:
  implement:
    worker: CODEX_CLI
    instructions: "..."
    capabilities: [READ, EDIT]

    # Override management hooks for this step
    management:
      pre_step: true
      post_step: true
      # Custom instructions appended to the agent's base_instructions
      # for hooks involving this step
      context_hint: |
        This step implements code. Pay attention to whether the approach
        matches the design doc in context/design/design.md.

  fast-lint:
    worker: CUSTOM
    instructions: "make lint"
    capabilities: [RUN_COMMANDS]

    # Disable management for trivial steps
    management:
      enabled: false
```

### 5.3 Agent catalog support

The management agent can reference an agent catalog entry:

```yaml
management:
  enabled: true
  agent:
    agent: workflow-manager    # references agents.yaml
    timeout: "30s"
```

```yaml
# agents.yaml
version: "1"
agents:
  workflow-manager:
    worker: OPENCODE
    model: openai/gpt-5.2
    capabilities: [READ]
    base_instructions: |
      You are a workflow management agent.
      ...
```

---

## 6. Reserved Names and Parser Validation

### 6.1 Reserved step IDs

Add `_management` to `RESERVED_STEP_IDS` in `src/workflow/parser.ts`:

```typescript
const RESERVED_STEP_IDS = new Set([
  "_subworkflows",
  "_workflow",
  "_workflow.json",
  "_meta.json",
  "_resolved.json",
  "_convergence",
  "_management",     // ← new
]);
```

### 6.2 Reserved artifact names

Add `_management` to `RESERVED_ARTIFACT_NAMES`:

```typescript
const RESERVED_ARTIFACT_NAMES = new Set([
  "_meta.json",
  "_resolved.json",
  "_convergence",
  "_stall",
  "_management",     // ← new
]);
```

### 6.3 Parser validation for `management` block

The parser MUST validate:

- `management.agent` has a valid `worker` (or `agent` catalog ref)
- `management.agent.timeout` is a valid `DurationString`
- `management.hooks` keys are from the known set
- `management.max_consecutive_interventions >= 1`
- `management.min_remaining_time` is a valid `DurationString`
- Step-level `management.enabled` is boolean
- Step-level `management.context_hint` is string
- No circular references between `management.agent` and step definitions

---

## 7. Runtime Design

### 7.1 ManagementController (new component)

A new class, `ManagementController`, sits in the workflow executor layer.

```
src/workflow/
  management/
    management-controller.ts   # main controller
    directive-validator.ts     # validates & constrains directives
    hook-context-builder.ts    # builds context snapshots for hooks
    decision-resolver.ts       # reads/validates decisions (hook_id, staleness)
    management-telemetry.ts    # lightweight telemetry when Sentinel is disabled
    types.ts                   # ManagementDirective, HookContext, etc.
```

Lifecycle:

1. Created by `WorkflowExecutor` when `management.enabled=true`.
2. If Sentinel is not enabled, creates a `ManagementTelemetrySink` to ensure
   `_workflow/state.json` is written (step state snapshot only).
3. Receives `ExecEvent` stream (same as TelemetrySink).
4. Invoked at hook points by the executor.
5. Returns a validated `ManagementDirective`.
6. Stopped when the workflow completes.

```typescript
interface ManagementController {
  /** Initialize with workflow definition and initial state. */
  init(definition: WorkflowDefinition, workflowState: WorkflowState): Promise<void>;

  /** Notify of an ExecEvent (for building observation context). */
  onEvent(event: ExecEvent): void;

  /** Invoke a hook and get a directive. */
  invokeHook(
    hook: ManagementHook,
    context: HookContext,
    abortSignal: AbortSignal,
  ): Promise<ManagementDirective>;

  /** Stop and clean up. */
  stop(): void;
}
```

### 7.2 Hook invocation flow

Each hook follows the same pattern:

```
Executor reaches hook point
  │
  ├─ management disabled or hook disabled for this step? → skip (proceed)
  ├─ remaining workflow time < min_remaining_time? → skip (proceed)
  ├─ consecutive interventions >= max? → skip (proceed) + emit warning
  │
  ├─ Generate hook_id = crypto.randomUUID()
  │
  ├─ Build HookContext:
  │    - hook_id
  │    - workflow state snapshot (all step states)
  │    - triggering event details
  │    - relevant artifact paths
  │    - previous management decisions (last N from decisions.jsonl)
  │    - convergence state (if applicable)
  │    - sentinel stall event (if on_stall hook)
  │
  ├─ Create invocation directory: context/_management/inv/<hook_id>/
  │
  ├─ Write input.json to invocation directory
  │
  ├─ Run management worker:
  │    - env: ROBOPPI_MANAGEMENT_HOOK_ID=<hook_id>
  │           ROBOPPI_MANAGEMENT_INPUT_FILE=<abs path to input.json>
  │           ROBOPPI_MANAGEMENT_DECISION_FILE=<abs path to decision.json>
  │    - instructions = base_instructions + hook-specific prompt + context_hint
  │    - worker reads input.json + workspace artifacts
  │    - worker writes decision to decision.json
  │    - timeout enforced (per-hook timeout)
  │    - events routed to ManagementEventSink (isolated)
  │
  ├─ Read decision.json via decision-resolver:
  │    - parse JSON
  │    - validate hook_id (staleness check, same protocol as completion_check)
  │    - validate directive structure (action, required fields)
  │    - validate against permission matrix (§4.5.1)
  │    - validate against required step state (§4.5.2)
  │    - apply safety constraints (timeout bounds, etc.)
  │
  ├─ If valid directive:
  │    - append to decisions.jsonl (with timing, applied=true)
  │    - return to executor
  │    - executor applies directive
  │
  └─ If invalid / timeout / error / stale:
       - append to decisions.jsonl (with timing, applied=false, reason)
       - emit warning ExecEvent
       - return { action: "proceed" } (safe default)
```

### 7.3 Integration with WorkflowExecutor

#### pre_step hook placement

**Key decision**: `pre_step` is invoked in `launchReadySteps()` **before**
transitioning the step to `RUNNING` and before incrementing `runningCount`.

Rationale: if `pre_step` were called inside `runStepLifecycle()` (after the
step is already `RUNNING`), the management agent's LLM call would consume a
concurrency slot while waiting for its response.  With `concurrency=2` and
two ready steps, both slots would be occupied by management calls before any
real work starts.

```typescript
private launchReadySteps(): void {
  for (const [stepId, state] of Object.entries(this.steps)) {
    if (state.status !== StepStatus.READY) continue;
    if (this.runningCount >= this.concurrency) break;

    // ──── pre_step hook (before RUNNING transition) ────
    if (this.managementController && this.isHookEnabled(stepId, "pre_step")) {
      // Fire-and-forget: the async result feeds back via notify()
      this.invokePreStepHook(stepId).catch(() => {});
      continue; // don't launch yet; invokePreStepHook will call launchStep
    }

    this.launchStep(stepId);
  }
}

private async invokePreStepHook(stepId: string): Promise<void> {
  const state = this.steps[stepId]!;
  // Temporarily mark as "awaiting management" to prevent re-evaluation
  // (still READY, but flagged internally)
  state.managementPending = true;

  try {
    const directive = await this.managementController!.invokeHook(
      "pre_step",
      this.buildHookContext(stepId, "pre_step"),
      this.workflowAbortController!.signal,
    );

    if (this.workflowAbortController!.signal.aborted) return;

    const applied = this.applyPreStepDirective(stepId, directive);
    if (applied === "skip") {
      state.status = StepStatus.OMITTED;
      state.completedAt = Date.now();
      // ... emit step_state event ...
      this.notify();
      return;
    }
    if (applied === "abort") return; // workflow abort already triggered
  } finally {
    state.managementPending = false;
  }

  // Proceed: launch the step normally
  this.launchStep(stepId);
}
```

Note: `managementPending` is an internal flag (not a `StepStatus` value)
that prevents `launchReadySteps()` from re-evaluating the step while the
management hook is in progress.

#### post_step hook

Called inside `runStepLifecycle()` after the step reaches a terminal state,
before final metadata is written.  This hook can emit annotations but cannot
change the step's terminal status (v1).

#### post_check hook

Called inside the completion_check loop, after the checker returns and before
the executor acts on the result.  This is where `force_complete` /
`force_incomplete` directives apply.

```typescript
// After completion_check returns checkResult:
if (this.managementController && this.isHookEnabled(stepId, "post_check")) {
  const directive = await this.managementController.invokeHook(
    "post_check",
    this.buildHookContext(stepId, "post_check", { checkResult }),
    this.workflowAbortController!.signal,
  );
  if (directive.action === "force_complete") {
    checkResult = { ...checkResult, complete: true, failed: false };
    // Log the override
  } else if (directive.action === "force_incomplete") {
    checkResult = { ...checkResult, complete: false, failed: false };
  }
}
// Continue with existing convergence / iteration logic
```

#### on_stall hook

See §4.11 for the Sentinel integration design.

### 7.4 Decision resolver

`decision-resolver.ts` follows the same pattern as
`src/workflow/completion-decision.ts`:

```typescript
interface ManagementDecisionResolution {
  directive: ManagementDirective;
  hookIdMatch: boolean | undefined;  // true=matched, false=mismatched, undefined=absent
  source: "file-json" | "none";
  reason?: string;                   // rejection reason (if invalid)
  reasoning?: string;                // agent's reasoning (informational)
  confidence?: number;               // agent's confidence (informational)
}

async function resolveManagementDecision(
  decisionFilePath: string,
  hookId: string,
  hookStartedAt: number,
): Promise<ManagementDecisionResolution>;
```

Validation includes:
- JSON parse
- `hook_id` staleness check (§4.3)
- `action` is a known directive type
- Required fields for the directive type are present
- String fields are bounded (max 4096 chars for `append`, `reason`, `message`)

### 7.5 Integration with existing mechanisms

#### With completion_check

`post_check` hook runs after the checker returns, before the executor acts
on the result.  The management agent can:

- `force_complete`: override an "incomplete" decision.
- `force_incomplete`: override a "complete" decision (rare, but useful for
  quality gates).
- `annotate`: add observations without changing the decision.

#### With convergence

The management agent sees convergence state (stage, stall counts,
fingerprints) in the HookContext.  It can:

- `modify_instructions`: add targeted hints based on stalled fingerprints
  (similar to convergence stage overlays, but with LLM reasoning).
- `abort_workflow`: if convergence is clearly impossible.

The management agent's instruction overlay is applied **after**
convergence stage overlays (§4.7), so they complement each other.

Because both use the overlay model (not direct concatenation), there is no
risk of double-appending: convergence replaces its overlay on stage
transition, management replaces its overlay on each hook invocation.

#### With Sentinel

See §4.11.  Summary:

- Sentinel = detection (deterministic, always runs).
- Management agent = decision (LLM-backed, when `on_stall` hook is enabled).
- No double LLM invocation.

### 7.6 Telemetry independence

When management is enabled but Sentinel is not:

```typescript
// In WorkflowExecutor.execute():
if (managementEnabled && !sentinelEnabled) {
  this.managementTelemetry = new ManagementTelemetrySink(
    this.sink,
    this.contextManager.contextDir,
  );
  this.effectiveSink = {
    emit: (event) => {
      this.managementTelemetry!.emit(event);
      this.managementController?.onEvent(event);
    },
  };
}
```

`ManagementTelemetrySink` is a lightweight sink that:
- Writes `_workflow/state.json` (step state snapshot, debounced).
- Does NOT write `events.jsonl` (that's Sentinel's responsibility).
- Forwards all events to the inner sink.

This ensures the management controller always has access to a current state
snapshot, regardless of Sentinel configuration.

---

## 8. Safety Design

The management agent is powerful but must be carefully constrained.

### 8.1 Principle: safe by default

- All hooks are **disabled by default** (`hooks: {}` means no hooks fire).
- Management agent failures always fall back to `{ action: "proceed" }`.
- The management agent cannot bypass Core safety invariants.
- Strict timeout on every hook invocation.

### 8.2 Runaway prevention

| Guard | Mechanism |
|---|---|
| Max consecutive interventions | After N non-"proceed" directives in a row, force "proceed" |
| Min remaining time | Stop invoking management agent when time is tight |
| Per-hook timeout | Hard timeout on each invocation |
| Budget accounting | Management agent worker invocations count toward workflow budget |
| Directive validation | Invalid directives are rejected (logged, default to "proceed") |
| Hook_id staleness | Stale decisions are rejected |
| Concurrency isolation | pre_step hook runs before RUNNING, doesn't consume worker slots |

### 8.3 Instruction integrity

`modify_instructions` uses the **overlay model** (§4.7):

- The original instructions (`base`) are **never modified**.
- The management overlay is **replaced** on each hook invocation (not appended
  to previous overlays).
- The overlay is prefixed with `[Management Agent]` for auditability.
- Maximum overlay size: 4096 characters (enforced by directive validator).

### 8.4 Audit trail

Every management agent invocation is recorded:

- `decisions.jsonl`: full decision log (hook_id, hook type, step_id, directive,
  timing, applied/rejected, rejection reason).
- `inv/<hookId>/`: per-invocation artifacts (input, decision, worker output).
- `ExecEvent` stream: `warning` events for non-"proceed" directives.
- `_meta.json` / `_resolved.json`: step metadata includes management overrides.

### 8.5 Worker event isolation

Management worker events are routed to a dedicated sink (§4.12) and do not:
- Appear in the main TUI.
- Update Sentinel activity tracking timestamps.
- Appear in the main telemetry `events.jsonl`.

---

## 9. Phased Implementation Plan

### Phase 1: Observer Mode (read-only telemetry agent)

**Scope**: A management controller that receives all `ExecEvent` emissions and
writes summaries/observations, but cannot issue control directives.

**Changes**:
- `ManagementController` with `onEvent()` only.
- `ManagementTelemetrySink` for `_workflow/state.json` (independent of
  Sentinel).
- `management:` DSL block with `enabled`, `agent`, `hooks: {}` (all false).
- `annotate` directive only.
- Per-invocation artifact directories (`_management/inv/<hookId>/`).
- `hook_id` generation and env var passing.
- `_management` added to `RESERVED_STEP_IDS` and `RESERVED_ARTIFACT_NAMES`.
- Management worker event isolation (dedicated sink).
- `decisions.jsonl` logging.

**Value**: workflow execution insights, debugging aid, foundation for later
phases.

**Estimated complexity**: small (comparable to TelemetrySink).

### Phase 2: Advisory Hooks (pre_step / post_step)

**Scope**: `pre_step` and `post_step` hooks that can advise execution.

**Changes**:
- `pre_step` hook invocation in `launchReadySteps()` (before RUNNING).
- `post_step` hook invocation in `runStepLifecycle()`.
- `HookContextBuilder` (workflow state snapshot + artifact paths).
- `DecisionResolver` (hook_id validation, staleness, JSON parsing).
- `DirectiveValidator` (permission matrix, step state requirements, safety
  constraints).
- `StepStatus.OMITTED` and `depAllowsProgress`/`depBlocksDownstream` updates.
- `managementPending` internal flag for concurrency-safe pre_step.
- Supported directives: `proceed`, `skip`, `modify_instructions`, `annotate`,
  `abort_workflow`.
- Instruction overlay model (§4.7).
- `abortReason: "management"` and `computeWorkflowStatus()` update.
- `adjust_timeout` at `pre_step` (stepTimeoutOverrides).
- `max_consecutive_interventions` guard.

**Value**: the management agent can now influence execution — skip unnecessary
steps, add context to instructions based on prior results, or abort when the
workflow is clearly stuck.

**Estimated complexity**: medium.

### Phase 3: Completion-check integration (pre_check / post_check)

**Scope**: hooks around completion_check invocations.

**Changes**:
- `pre_check` / `post_check` hook invocation in completion_check loop.
- `force_complete` / `force_incomplete` directives.
- Integration with convergence state (expose in HookContext).
- `adjust_timeout` at `pre_check`.

**Value**: the management agent can make nuanced "good enough" decisions and
break out of loops that are technically incomplete but practically sufficient.

**Estimated complexity**: medium.

### Phase 4: Sentinel integration (on_stall hook)

**Scope**: management agent is invoked when Sentinel triggers a stall.

**Changes**:
- `on_stall` hook invoked from Sentinel trigger path in executor (§4.11).
- Sentinel artifacts (event.json, probe.jsonl) included in HookContext.
- Management decision overrides Sentinel's static action.
- Fallback to Sentinel action on management timeout/failure.
- `retry` directive with `modify_instructions`.

**Value**: LLM-powered diagnosis of stalls, enabling smarter recovery than
static Sentinel rules.

**Estimated complexity**: medium (builds on Phase 2 + existing Sentinel).

### Phase 5: Periodic monitoring

**Scope**: the management agent is invoked at regular intervals during long
step execution.

**Changes**:
- `periodic` hook with configurable interval.
- Timer management per running step.
- Interaction with running step lifecycle (annotate only; no control
  directives that affect running steps in v1).

**Value**: proactive observation during long steps.

**Estimated complexity**: medium.

### Phase 6: Dynamic DAG modification (future)

**Scope**: the management agent can request structural changes to the DAG.

**Changes** (exploratory):
- New directives: `inject_step`, `remove_step`, `reorder_dependencies`.
- DAG re-validation after modification.
- Significant changes to `WorkflowExecutor` state management.

**Value**: fully autonomous workflow adaptation.

**Estimated complexity**: large.  This phase requires careful design and is
intentionally deferred until Phases 1–5 prove the value of the advisory
model.

---

## 10. Interaction with Existing Features (compatibility matrix)

| Feature | Interaction | Notes |
|---|---|---|
| `completion_check` | `post_check` can override decision | Agent sees check result + artifacts |
| `convergence` | Agent sees stage/stall state in HookContext | Instruction overlays are layered (§4.7) |
| Sentinel | `on_stall` hook replaces Sentinel's static action (§4.11) | Detection=Sentinel, Decision=management |
| Subworkflow steps | Hooks fire for parent step only (v1) | Child workflow has its own management (if configured) |
| Agent catalog | Management agent can use catalog entries | `management.agent.agent: <id>` |
| Branch safety | Management agent cannot change branches | Branch lock is a Core invariant |
| Daemon evaluate/analyze | Complementary; different lifecycle | evaluate=pre-workflow, management=intra-workflow |
| TUI | Management events isolated from main TUI | Warnings for interventions are forwarded |
| `RESERVED_STEP_IDS` | `_management` added to parser reserved set | Step ids cannot collide |
| `RESERVED_ARTIFACT_NAMES` | `_management` added to parser reserved set | Artifact names cannot collide |

---

## 11. Testing Strategy

### Unit tests

- `DirectiveValidator`: rejects invalid directives per permission matrix;
  enforces overlay-model instructions; validates timeout bounds against
  workflow budget; rejects directives at wrong step states.
- `DecisionResolver`: hook_id matching; staleness detection (mtime-based);
  JSON parse errors; missing decision file; bounded string lengths.
- `HookContextBuilder`: correct snapshot of workflow state and artifact paths;
  includes convergence state; includes sentinel stall artifacts.
- `ManagementController`: timeout handling; fallback to "proceed"; consecutive
  intervention guard; per-invocation directory creation and cleanup.
- `ManagementTelemetrySink`: writes state.json independently of Sentinel.
- `StepStatus.OMITTED`: `depAllowsProgress` returns true; `depBlocksDownstream`
  returns false; `isTerminal` returns true.
- `decisions.jsonl` format validation.

### Integration tests

- Workflow with `management.hooks.pre_step=true` where agent skips a step →
  downstream steps see OMITTED dependency and proceed (not blocked).
- Workflow with `management.hooks.post_check=true` where agent forces complete
  → loop exits early.
- Management agent timeout → workflow continues normally (no hang);
  `decisions.jsonl` records `applied=false`.
- `max_consecutive_interventions` → agent is bypassed after limit; warning
  emitted.
- Concurrent steps (`concurrency=2`) with `pre_step` enabled → no decision
  file collision; each step gets its own `inv/<hookId>/` directory.
- Stale `hook_id` in decision file → rejected; falls back to proceed.
- `adjust_timeout` at `pre_step` → step runs with adjusted timeout; exceeding
  workflow budget is capped.
- `abort_workflow` → workflow status is CANCELLED with management reason in
  metadata.
- Management agent + Sentinel both enabled → `on_stall` fires management hook;
  Sentinel's static action is not applied.
- Management worker events do not appear in main TUI or telemetry.
- Subworkflow step with management enabled on parent and child → no
  interference.

### Acceptance tests

- End-to-end: implement-review-fix workflow with management agent that detects
  repeated review rejection and modifies implementation instructions.
- End-to-end: workflow where management agent aborts early after diagnosing an
  unrecoverable environment issue.

---

## 12. Design Decisions

### 12.1 Resolved

1. **Layer placement**: management agent is runner-owned (like Sentinel), not a
   separate process or a Core component.  Rationale: it needs tight integration
   with the executor's scheduling loop and must not add IPC latency.

2. **Append-only instructions via overlay model**: `modify_instructions` sets
   a management overlay that is composed with (not concatenated to) the base
   instructions and convergence overlay.  Each hook invocation replaces the
   previous management overlay.  Rationale: prevents unbounded prompt growth
   and interacts cleanly with convergence.

3. **Safe default**: all hooks disabled, failures fall back to "proceed".
   Rationale: workflows must not regress when management is misconfigured.

4. **hook_id correlation**: every hook invocation has a unique `hook_id` that
   must appear in the decision file, following the same staleness protocol as
   `completion_check`'s `check_id`.  Rationale: prevents stale/misattributed
   decisions in concurrent and multi-iteration scenarios.

5. **Per-invocation artifact directories**: each hook invocation writes to
   `_management/inv/<hookId>/` to avoid file collision under concurrency.
   Rationale: `concurrency > 1` means multiple hooks can fire in parallel.

6. **No direct Core access**: the management agent cannot issue Permits,
   modify Circuit Breaker state, or bypass budgets.  Rationale: mechanism/
   policy separation is a foundational invariant of Roboppi's architecture.

7. **OMITTED status for management skip**: `StepStatus.OMITTED` does not
   block downstream steps, unlike `StepStatus.SKIPPED`.  Rationale: the
   existing `SKIPPED` semantics ("blocked by upstream failure") are
   inappropriate for voluntary management-initiated skips.

8. **No `defer` directive in v1**: the current state machine lacks a
   `DEFERRED` state, and returning to `PENDING` creates a busy loop.
   Rationale: complexity vs. value tradeoff; defer if use case proves common.

9. **`pre_step` before RUNNING**: hook fires in `launchReadySteps()`, not
   inside `runStepLifecycle()`, so the management agent's LLM call does not
   consume a concurrency slot.  Rationale: prevents management overhead from
   reducing effective parallelism.

10. **`adjust_timeout` limited to pre_step/pre_check**: the deadline timer
    is fixed at step launch (`createScopedAbort`).  Rationale: changing a
    running timer is complex and error-prone; pre-launch adjustment is simple
    and sufficient.

11. **`retry` scoped to current iteration**: cross-step/cross-iteration retry
    requires DAG state rollback.  Rationale: v1 keeps retry within the existing
    `max_retries`/`max_iterations` budget; broader retry is a future feature.

12. **Sentinel detection + management decision**: when both are enabled,
    Sentinel detects stalls deterministically, and the management agent makes
    the decision (replacing Sentinel's static action).  Rationale: avoids
    double LLM invocation; leverages each component's strength.

13. **Management worker event isolation**: management worker events go to a
    dedicated sink, not the main TUI/telemetry.  Rationale: prevents activity
    tracking pollution and UI noise.

14. **Management abort maps to CANCELLED**: `abortReason: "management"` maps
    to `WorkflowStatus.CANCELLED` with a reason field in metadata.
    Rationale: minimal change; a dedicated `ABORTED` status may follow.

15. **Telemetry independence**: `ManagementTelemetrySink` writes
    `_workflow/state.json` when Sentinel is not enabled.  Rationale: the
    management agent needs state snapshots regardless of Sentinel configuration.

### 12.2 Open questions

1. **Hook granularity for subworkflows**: should hooks fire for individual
   child steps when `bubble_subworkflow_events=true`?  Current proposal: no
   (v1 fires hooks for the parent step only).

2. **Management agent state across daemon runs**: should the daemon persist
   management agent observations across workflow runs?  Possible via
   `state_dir`.

3. **Cost attribution**: how should management agent worker invocations be
   attributed in cost tracking?  Proposal: separate `management_cost` field
   in workflow metadata.

4. **Interaction between multiple management agents**: if a subworkflow has
   its own management agent, how do parent and child agents interact?
   Proposal: independent (no cross-workflow directives).

5. **Decision via stdout JSON**: should the management agent be able to
   return decisions via stdout (like `completion_check`'s stdout-json
   fallback) in addition to the decision file?  Pro: simpler for READ-only
   workers.  Con: adds a second resolution path.  Deferred to implementation.

---

## 13. Example: Full Workflow with Management Agent

```yaml
name: implement-review-fix-managed
version: "1"
timeout: "2h"
concurrency: 2

management:
  enabled: true
  agent:
    worker: OPENCODE
    model: openai/gpt-5.2
    capabilities: [READ]
    timeout: "30s"
    base_instructions: |
      You are a workflow management agent.
      You observe step execution and make strategic decisions.

      When writing your decision, use this JSON format in the decision file
      at $ROBOPPI_MANAGEMENT_DECISION_FILE:
      {
        "hook_id": "$ROBOPPI_MANAGEMENT_HOOK_ID",
        "hook": "<hook_name>",
        "step_id": "<step_id>",
        "directive": { "action": "proceed" },
        "reasoning": "explanation"
      }

      Guidelines:
      - Default to "proceed" unless intervention is clearly beneficial.
      - For "modify_instructions", be specific about what to change and why.
      - Never include secrets in your output.
      - Read the input file at $ROBOPPI_MANAGEMENT_INPUT_FILE for context.

  hooks:
    pre_step: true
    post_step: true
    post_check: true
    on_stall: true

  max_consecutive_interventions: 3

sentinel:
  enabled: true
  defaults:
    no_output_timeout: "10m"

steps:
  implement:
    worker: CODEX_CLI
    instructions: |
      Implement the feature described in request.md.
    capabilities: [READ, EDIT]
    timeout: "15m"
    management:
      context_hint: |
        This is the main implementation step.
        Check if the approach aligns with design.md.
    outputs:
      - name: implementation
        path: "src/"
        type: code

  test:
    worker: CODEX_CLI
    depends_on: [implement]
    instructions: |
      Run the test suite.
    capabilities: [READ, RUN_TESTS]
    timeout: "10m"
    outputs:
      - name: test-report
        path: "test-results.txt"
        type: test-report

  review:
    worker: CLAUDE_CODE
    depends_on: [implement]
    instructions: |
      Review the implementation in src/.
    capabilities: [READ]
    timeout: "10m"
    outputs:
      - name: review
        path: "review.md"
        type: review

  fix:
    worker: CODEX_CLI
    depends_on: [review, test]
    instructions: |
      Fix issues found in review.md and test-results.txt.
    capabilities: [READ, EDIT, RUN_TESTS]
    timeout: "15m"

    completion_check:
      worker: CLAUDE_CODE
      instructions: |
        Check if all review items are addressed and tests pass.
      capabilities: [READ]
      decision_file: .roboppi-loop/review.verdict

    max_iterations: 10
    convergence:
      enabled: true
      stall_threshold: 2
      max_stage: 3
```

Execution flow with management agent:

```
1. implement (READY)
   ├─ pre_step hook → agent reads design.md, returns "proceed"
   │   (hook runs in launchReadySteps, no concurrency slot consumed)
   ├─ step transitions to RUNNING
   ├─ worker executes
   └─ post_step hook → agent reviews output, returns "annotate"

2. test + review (parallel, READY)
   ├─ pre_step hooks fire concurrently (separate inv/<hookId>/ dirs)
   │   → agent returns "proceed" for both
   ├─ steps transition to RUNNING (2 concurrency slots used)
   ├─ workers execute
   └─ post_step hooks → agent notices test failures align with review comments
       → returns "annotate" with diagnosis

3. fix (READY)
   ├─ pre_step hook → agent reads review.md + test-results.txt
   │   → returns "modify_instructions":
   │     "[Management Agent]
   │      IMPORTANT: The test failure in auth.test.ts is caused by the
   │      missing null check identified in review.md item #2. Fix this first."
   │   (management overlay set; base instructions unchanged)
   ├─ worker executes with composed instructions:
   │     base + convergence overlay (if any) + management overlay
   ├─ completion_check runs
   │   └─ post_check hook → after iteration 3, agent judges remaining issues
   │       are cosmetic → returns "force_complete"
   │       (logged to decisions.jsonl with reasoning)
   └─ step SUCCEEDED (loop exited at iteration 3 instead of 10)

4. Workflow SUCCEEDED
   └─ _management/decisions.jsonl contains full audit trail
```

---

## 14. Comparison with Existing Approaches

| Approach | Roboppi management agent | Devin-style autonomous agent | Static workflow orchestrators |
|---|---|---|---|
| Observation | structured events + artifacts | full environment access | logs only |
| Intervention | validated directives | unrestricted actions | none (manual) |
| Safety | overlay model, Core invariants preserved | relies on agent judgment | N/A |
| Flexibility | hook-based, configurable per step | fully dynamic | fixed pipeline |
| Reproducibility | decision log + audit trail + hook_id | non-deterministic | deterministic |
| Concurrency safety | per-invocation artifacts | N/A | N/A |
| Incremental adoption | opt-in hooks, phase by phase | all-or-nothing | N/A |

The management agent occupies a middle ground: more adaptive than static
orchestrators, but safer and more predictable than fully autonomous agents.

---

## 15. Pi (coding-agent) SDK Integration

This section describes a concrete implementation path that uses the Pi
`coding-agent` as an SDK (vendored at `refs/coding-agent-repo/packages/coding-agent/`)
to power the Workflow Management Agent.

The goal is to reuse Pi's existing agent/session/tooling infrastructure while
keeping Roboppi's mechanism/policy separation intact: Pi provides an agent
runtime, and Roboppi remains the enforcement point for timeouts, budgets,
concurrency, and directive validation.

### 15.1 Rationale

- **Stateful supervisor**: one management agent session can persist across the
  entire workflow, improving cross-step diagnosis and consistency.
- **Typed tools and extensions**: use Pi's tool framework to make directive
  emission structured (tool call) instead of relying on free-form text.
- **Pluggable capabilities**: map `READ/EDIT/RUN_TESTS/RUN_COMMANDS` to an
  explicit Pi tool set.
- **Optional reuse**: the same SDK can later be used to implement a first-class
  Roboppi worker kind (Pi-backed step workers), reducing reliance on external
  CLIs.

### 15.2 Integration shapes

There are two viable shapes. Both are “SDK usage”; they differ only in
deployment and isolation.

1. **Embedded SDK (in-process)**
   - Roboppi imports `@mariozechner/pi-coding-agent` directly and runs an
     `AgentSession` inside the runner.
   - Lowest latency, easiest to share in-memory workflow state.
   - Tradeoff: larger dependency surface and potential friction with
     `bun build --compile` distribution.

2. **Sidecar SDK worker (recommended for compiled distributions)**
   - Roboppi spawns a small Node/Bun process that uses the Pi SDK and talks
     back via the existing JSONL worker event surface.
   - Keeps the compiled Roboppi binary small; isolates Pi dependencies.
   - Tradeoff: IPC/serialization overhead, plus an extra process.

The rest of this section focuses on the embedded shape; the sidecar shape is an
implementation detail of the same interface.

### 15.3 ManagementAgentEngine abstraction

Introduce an internal engine boundary so the executor does not care whether the
management agent runs via a Roboppi worker process (current design) or via Pi
SDK:

```typescript
interface ManagementAgentEngine {
  invokeHook(args: {
    hook: ManagementHook;
    hookId: string;
    hookStartedAt: number;
    context: HookContext;
    budget: {
      deadlineAt: number;
      maxSteps?: number;
      maxCommandTimeMs?: number;
    };
    abortSignal: AbortSignal;
  }): Promise<{
    directive: ManagementDirective;
    meta?: { reasoning?: string; confidence?: number };
  }>;

  dispose(): Promise<void>;
}
```

Implementations:

- `WorkerEngine`: the existing file-based worker invocation (env vars +
  `decision.json` resolution).
- `PiSdkEngine`: a new engine that uses Pi's `createAgentSession()` to run a
  persistent management agent.

This keeps all existing safety behavior (permission matrix, step-status
constraints, consecutive intervention limits) in the executor/controller layer.

### 15.4 PiSdkEngine: persistent session + typed decision tool

Create exactly one Pi `AgentSession` per workflow run (unless configured
otherwise). For each hook:

1. Build `HookContext` (same schema as today) and store it in
   `context/_management/inv/<hookId>/input.json`.
2. Prompt the Pi session with:
   - base instructions (`management.agent.base_instructions`)
   - hook-specific instructions
   - a pointer to `$ROBOPPI_MANAGEMENT_INPUT_FILE`
   - a hard requirement to emit a directive via a Pi custom tool call
3. Capture the tool call result as the directive (no file parsing required).
4. Write `_management/inv/<hookId>/decision.json` for audit parity and append to
   `_management/decisions.jsonl`.

#### 15.4.1 Decision as a tool call

Instead of “write JSON to a file”, Pi emits the directive by calling a custom
tool. This improves correctness and reduces prompt-injection surface.

Tool sketch:

```typescript
const roboppiDecisionTool: ToolDefinition = {
  name: "roboppi_management_decision",
  label: "Management Decision",
  description: "Return a management directive for the current hook.",
  parameters: Type.Object({
    hook_id: Type.String(),
    hook: Type.String(),
    step_id: Type.String(),
    directive: Type.Object({
      action: Type.String(),
      // action-specific fields validated by Roboppi after receipt
    }),
    reasoning: Type.Optional(Type.String()),
    confidence: Type.Optional(Type.Number()),
  }),
  execute: async (_toolCallId, params) => {
    // Store params.directive in the engine for retrieval by invokeHook().
    // Optionally: also write decision.json into the inv/<hookId>/ directory.
    return { content: [{ type: "text", text: "ok" }], details: {} };
  },
};
```

Engine rules:

- The prompt MUST instruct: “Call `roboppi_management_decision` exactly once.”
- If the tool is not called before timeout: treat as `{ action: "proceed" }`.
- Roboppi still validates the directive using the existing permission matrix
  and step-state constraints.
- For the staleness/correlation requirement, the tool must include `hook_id`.
  Mismatch is rejected the same way as a stale decision file.

### 15.5 Capability → Pi tool mapping

Map Roboppi capabilities to explicit Pi tools:

- `READ` → `read, ls, grep, find`
- `EDIT` → `edit, write` (and usually `read`)
- `RUN_TESTS` → restricted command execution (see below)
- `RUN_COMMANDS` → command execution

Important: Pi's built-in `bash` tool can execute arbitrary commands. If Roboppi
policy assumes command gating, prefer wrapping command execution behind a
Roboppi-controlled tool that enforces:

- working directory = step workspace
- per-command timeouts (`max_command_time`)
- allowlist patterns for `RUN_TESTS` (e.g. `bun test`, `make test`, `npm test`)
- logging to `_management/inv/<hookId>/` for audit/debug

This preserves mechanism/policy separation: the agent requests an action; the
runner validates and executes it.

### 15.6 Agent-driven execution (scheduler participation)

If the goal is “execution + supervision”, hook-based per-step directives are
often not enough to express *which* READY steps should run when there is
parallelism.

Add an optional scheduling hook (future extension):

- New hook: `schedule` (fires when the executor is about to launch steps and
  there are multiple READY candidates)
- New directive (vNext):

```typescript
{ action: "select_ready_steps"; launch: string[]; reason?: string }
```

Executor validation:

- Every `launch[]` entry must still be `READY` at apply-time.
- Dependencies must remain satisfied.
- `launch.length` must not exceed available concurrency slots.
- Invalid/timeout/stale decisions fall back to the default scheduler.

This enables:

- resource-aware scheduling (critical path first)
- intentional serialization (avoid I/O contention)
- strategy pivots based on cross-step context

### 15.7 Packaging and build notes

Pi (`@mariozechner/pi-coding-agent`) targets Node >= 20 and has a large
dependency surface. For Roboppi's compiled binary distribution, the sidecar SDK
worker shape is the recommended default:

- Roboppi remains small and deterministic
- Pi dependencies live outside the compiled artifact
- failure/timeout semantics remain “safe by default” (fallback to `proceed`)

### 15.8 Pi-backed step workers (optional)

If the goal is “workflow execution + supervision” with a single SDK, Roboppi can
also add a Pi-backed worker kind for normal workflow steps.

Design sketch:

- Add a new worker kind (e.g. `PI_CODING_AGENT`) alongside `OPENCODE`,
  `CLAUDE_CODE`, `CODEX_CLI`.
- Implement a `WorkerAdapter` that uses `createAgentSession()` (Pi SDK) to run a
  step: `session.prompt(step.instructions)`.
- Map Pi session events to Roboppi `worker_event`:
  - assistant text deltas → `progress` (or `stdout`)
  - tool execution events → `progress` + per-tool debug logs
- Budget/cancellation mapping:
  - `deadlineAt` → abort via Roboppi `AbortSignal`
  - `max_steps` → cap turns/steps (Pi settings)
  - `max_command_time` → enforce via a wrapped command tool
- Capability mapping reuses §15.5 (explicit tool set per step).
- Artifacts/observations:
  - for edits, emit `patch` artifacts (from tool result diffs, or via a bounded
    git diff snapshot after the step completes)
  - emit a concise `observation` summary from the final assistant message

This keeps Roboppi's executor and safety invariants unchanged while letting Pi
act as both a step executor (worker) and a workflow supervisor (management
agent).
