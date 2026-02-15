# Workflow YAML Design

**Declarative DAG workflows for multiple AgentCore steps**

---

## 1. Background and Goals

AgentCore currently runs in a configuration where one Scheduler manages one AgentCore.
In practice, many tasks require multi-step coordination, such as "implement -> review -> fix -> test".

This design introduces a **declarative workflow definition in YAML**, enabling step dependencies (DAG) and file-based context hand-off.

### Problems Addressed

| Problem | Approach |
|------|-----------|
| Manual orchestration of multiple steps | Define the workflow in YAML; Scheduler runs it automatically |
| Context discontinuity between steps | File-based hand-off via a `context/` directory |
| Only sequential execution is possible | Represent DAG via `depends_on` for parallelism and joins |
| Manual recovery after step failure | `on_failure` policy for retry/continue/abort |

---

## 2. YAML Schema

### 2.1 Top-level structure

```yaml
# workflow.yaml
name: string                    # workflow name (unique identifier)
version: "1"                    # schema version
description?: string            # optional description

timeout: string                 # workflow-level timeout (e.g. "30m", "2h")
concurrency?: number            # max parallel steps (default: unlimited)

context_dir?: string            # context directory (default: "./context")

steps:
  <step_id>:                    # step id (YAML key, unique within the workflow)
    <StepDefinition>
```

### 2.2 StepDefinition

```yaml
steps:
  <step_id>:
    description?: string                    # step description

    # ---- Worker config ----
    worker: enum                            # CODEX_CLI | CLAUDE_CODE | OPENCODE | CUSTOM
    workspace?: string                      # working directory (default: ".")
    instructions: string                    # instructions passed to the worker
    capabilities:                           # allowed operations
      - enum                                # READ | EDIT | RUN_TESTS | RUN_COMMANDS

    # ---- DAG dependencies ----
    depends_on?: string[]                   # list of prerequisite step ids

    # ---- context I/O ----
    inputs?: InputRef[]                     # references to upstream artifacts
    outputs?: OutputDef[]                   # outputs produced by this step

    # ---- constraints ----
    timeout?: string                        # step timeout (e.g. "5m")
    max_retries?: number                    # max retries (default: 0)
    max_steps?: number                      # max steps for the worker
    max_command_time?: string               # timeout per command executed by the worker

    # ---- completion check (loop) ----
    completion_check?: CompletionCheckDef   # post-success completion check (rerun if incomplete)
    max_iterations?: number                 # completion_check loop limit (default: 1 = no loop)
    on_iterations_exhausted?: enum          # when limit is hit: abort | continue (default: abort)

    # ---- failure handling ----
    on_failure?: enum                       # retry | continue | abort (default: abort)
```

### 2.3 InputRef - context input reference

```yaml
inputs:
  - from: string                # upstream step id
    artifact: string            # artifact name (as defined by outputs[].name)
    as?: string                 # local name (default: same as artifact)
```

### 2.4 OutputDef - context output definition

```yaml
outputs:
  - name: string                # artifact name (key referenced by downstream steps)
    path: string                # relative path under context_dir
    type?: string               # optional hint (e.g. "code", "review", "test-report")
```

### 2.5 CompletionCheckDef - completion check

```yaml
completion_check:
  worker: enum                  # worker used for checking (e.g. CLAUDE_CODE)
  instructions: string          # check instructions
  capabilities:                 # checker capabilities (usually READ only)
    - enum
  timeout?: string              # timeout per check (default: 1/4 of step timeout)
```

The checker worker evaluates artifact state and returns **complete / incomplete**.
If incomplete, the main worker is rerun (up to `max_iterations`).

Because the checker and main worker run in the same `workspace`, file state naturally carries over across iterations.

### 2.6 Full type definition (TypeScript representation)

```typescript
interface WorkflowDefinition {
  name: string;
  version: "1";
  description?: string;
  timeout: DurationString;        // e.g. "30m", "2h"
  concurrency?: number;
  context_dir?: string;
  steps: Record<string, StepDefinition>;
}

interface StepDefinition {
  description?: string;
  worker: "CODEX_CLI" | "CLAUDE_CODE" | "OPENCODE" | "CUSTOM";
  workspace?: string;
  instructions: string;
  capabilities: ("READ" | "EDIT" | "RUN_TESTS" | "RUN_COMMANDS")[];
  depends_on?: string[];
  inputs?: InputRef[];
  outputs?: OutputDef[];
  timeout?: DurationString;
  max_retries?: number;
  max_steps?: number;
  max_command_time?: DurationString;
  completion_check?: CompletionCheckDef;
  convergence?: ConvergenceDef;         // optional; opt-in convergence control for loops
  max_iterations?: number;              // default: 1 (no loop)
  on_iterations_exhausted?: "abort" | "continue";
  on_failure?: "retry" | "continue" | "abort";
}

interface ConvergenceStageDef {
  stage: number;                        // 2..max_stage
  append_instructions?: string;
}

interface ConvergenceDef {
  enabled?: boolean;                    // default: false
  stall_threshold?: number;             // default: 2
  max_stage?: number;                   // default: 3
  fail_on_max_stage?: boolean;          // default: true
  stages?: ConvergenceStageDef[];
  allowed_paths?: string[];
  ignored_paths?: string[];
  diff_base_ref?: string;               // default: HEAD
  diff_base_ref_file?: string;
  max_changed_files?: number;
}

interface CompletionCheckDef {
  worker: "CODEX_CLI" | "CLAUDE_CODE" | "OPENCODE" | "CUSTOM";
  instructions: string;
  capabilities: ("READ" | "EDIT" | "RUN_TESTS" | "RUN_COMMANDS")[];
  timeout?: DurationString;
  decision_file?: string; // optional; supports JSON {"decision":"complete"/"incomplete","check_id":"...","reasons":[...],"fingerprints":[...]} and legacy PASS/FAIL
}

interface InputRef {
  from: string;
  artifact: string;
  as?: string;
}

interface OutputDef {
  name: string;
  path: string;
  type?: string;
}

type DurationString = string;   // e.g. "5m", "30s", "2h"
```

---

## 3. Examples

### 3.1 Implement -> review -> fix workflow

```yaml
name: implement-review-fix
version: "1"
description: "Review after implementation and fix review comments"
timeout: "1h"
concurrency: 2

steps:
  implement:
    description: "Perform an initial implementation"
    worker: CODEX_CLI
    instructions: |
      Add a new utility function to src/feature.ts.
      See instructions.md for the spec.
    capabilities: [READ, EDIT]
    timeout: "15m"
    max_retries: 1
    on_failure: retry
    outputs:
      - name: implementation
        path: "src/feature.ts"
        type: code

  test:
    description: "Run tests for the implementation"
    worker: CODEX_CLI
    depends_on: [implement]
    instructions: |
      Run the test suite and report the results.
    capabilities: [READ, RUN_TESTS]
    inputs:
      - from: implement
        artifact: implementation
    timeout: "10m"
    on_failure: continue
    outputs:
      - name: test-report
        path: "test-results.txt"
        type: test-report

  review:
    description: "Review the implementation"
    worker: CLAUDE_CODE
    depends_on: [implement]
    instructions: |
      Review the code in src/feature.ts.
      Provide findings focusing on code quality, error handling, and tests.
    capabilities: [READ]
    inputs:
      - from: implement
        artifact: implementation
    timeout: "10m"
    on_failure: abort
    outputs:
      - name: review-comments
        path: "review.md"
        type: review

  fix:
    description: "Fix based on review comments and test results"
    worker: CODEX_CLI
    depends_on: [review, test]
    instructions: |
      Apply the feedback in review.md.
      If tests failed, fix them as well.
    capabilities: [READ, EDIT, RUN_TESTS]
    inputs:
      - from: review
        artifact: review-comments
      - from: test
        artifact: test-report
    timeout: "15m"
    max_retries: 2
    on_failure: retry
    outputs:
      - name: fixed-code
        path: "src/feature.ts"
        type: code
```

DAG structure:

```
implement
  +-- test ---+
  +-- review -+-- fix
```

`test` and `review` run in parallel after `implement` completes.
`fix` runs only after both `test` and `review` complete.

### 3.2 Parallel multi-repo application

```yaml
name: multi-repo-migration
version: "1"
description: "Apply the same refactoring to multiple repositories"
timeout: "2h"
concurrency: 3

steps:
  plan:
    description: "Create a migration plan"
    worker: CLAUDE_CODE
    instructions: "Write the refactoring plan to migration-plan.md"
    capabilities: [READ]
    timeout: "10m"
    outputs:
      - name: plan
        path: "migration-plan.md"
        type: review

  apply-repo-a:
    description: "Apply to repo A"
    worker: CODEX_CLI
    workspace: "../repo-a"
    depends_on: [plan]
    instructions: "Apply the refactoring according to migration-plan.md"
    capabilities: [READ, EDIT, RUN_TESTS]
    inputs:
      - from: plan
        artifact: plan
    timeout: "20m"
    max_retries: 1
    on_failure: retry

  apply-repo-b:
    description: "Apply to repo B"
    worker: CODEX_CLI
    workspace: "../repo-b"
    depends_on: [plan]
    instructions: "Apply the refactoring according to migration-plan.md"
    capabilities: [READ, EDIT, RUN_TESTS]
    inputs:
      - from: plan
        artifact: plan
    timeout: "20m"
    max_retries: 1
    on_failure: continue

  verify:
    description: "Verify overall consistency"
    worker: CLAUDE_CODE
    depends_on: [apply-repo-a, apply-repo-b]
    instructions: "Compare diffs across repositories and write a consistency report"
    capabilities: [READ]
    timeout: "10m"
```

### 3.3 Loop execution via completion_check

```yaml
name: implement-from-todo
version: "1"
description: "Iteratively implement tasks from todo.md until all are complete"
timeout: "2h"

steps:
  implement-all:
    description: "Implement one incomplete item in todo.md"
    worker: CODEX_CLI
    instructions: |
      Read todo.md and pick one unfinished task marked with - [ ].
      Implement it, then update the line to - [x].
    capabilities: [READ, EDIT, RUN_TESTS]
    timeout: "10m"
    max_retries: 1
    on_failure: retry

    completion_check:
      worker: CLAUDE_CODE
      instructions: |
        Check todo.md.
        If any - [ ] remains, decide "incomplete".
        If all tasks are - [x], decide "complete".
      capabilities: [READ]
      timeout: "2m"

    max_iterations: 20
    on_iterations_exhausted: abort

    outputs:
      - name: completed-code
        path: "src/"
        type: code
      - name: final-todo
        path: "todo.md"
        type: review

  verify:
    description: "Run tests after all tasks are complete"
    worker: CODEX_CLI
    depends_on: [implement-all]
    instructions: "Run the full test suite and report the results"
    capabilities: [READ, RUN_TESTS]
    inputs:
      - from: implement-all
        artifact: completed-code
    timeout: "10m"
    on_failure: abort
```

Execution flow:

```
implement-all step
  |
  | iteration 1
  +-> Worker (CODEX_CLI): implement one todo item
  |     SUCCEEDED
  +-> completion_check (CLAUDE_CODE): "3 items remain -> incomplete"
  |     incomplete -> rerun
  |
  | iteration 2
  +-> Worker (CODEX_CLI): implement next item
  |     SUCCEEDED
  +-> completion_check (CLAUDE_CODE): "2 items remain -> incomplete"
  |     incomplete -> rerun
  |
  | ... (repeat)
  |
  | iteration N
  +-> Worker (CODEX_CLI): implement last item
  |     SUCCEEDED
  +-> completion_check (CLAUDE_CODE): "all are - [x] -> complete"
  |     complete
  |
  +-> step SUCCEEDED -> proceed to verify
```

---

## 4. Context hand-off flow

### 4.1 Directory structure

During workflow execution, the Scheduler creates a directory structure like:

```
<workspace>/
  +-- context/                          # context_dir (default)
  |    +-- _workflow.json               # workflow execution metadata
  |    +-- implement/                   # per-step subdirectory (by step id)
  |    |    +-- _meta.json              # step metadata (status, timing, etc.)
  |    |    +-- implementation/         # artifacts defined in outputs
  |    |         +-- src/feature.ts
  |    +-- review/
  |    |    +-- _meta.json
  |    |    +-- review-comments/
  |    |         +-- review.md
  |    +-- test/
  |         +-- _meta.json
  |         +-- test-report/
  |              +-- test-results.txt
```

### 4.2 Context lifecycle

```
+--------------------------------------------------------------+
| Step A execution                                              |
|                                                              |
|  1. Scheduler creates context/<step_id>/                      |
|  2. Copy/symlink upstream artifacts (declared in inputs)      |
|     into the worker workspace                                 |
|  3. Worker runs                                                |
|  4. After completion, collect declared outputs into            |
|     context/<step_id>/<artifact_name>/                         |
|  5. Write step result to _meta.json                            |
|                                                              |
|  -> downstream steps can resolve inputs                        |
+--------------------------------------------------------------+
```

### 4.3 `_meta.json` structure

```json
{
  "stepId": "implement",
  "status": "SUCCEEDED",
  "startedAt": 1700000000000,
  "completedAt": 1700000900000,
  "wallTimeMs": 900000,
  "attempts": 1,
  "workerKind": "CODEX_CLI",
  "artifacts": [
    {
      "name": "implementation",
      "path": "implementation/src/feature.ts",
      "type": "code"
    }
  ],
  "workerResult": {
    "status": "SUCCEEDED",
    "artifacts": [],
    "observations": [
      { "filesChanged": ["src/feature.ts"], "summary": "Added utility function" }
    ],
    "cost": { "estimatedTokens": 5000, "wallTimeMs": 120000 }
  }
}
```

### 4.4 Mapping to existing types

Context hand-off can be implemented by extending existing `WorkerResult.artifacts`:

| YAML definition | Runtime representation |
|-----------|----------------|
| `outputs[].name` | `Artifact.type` (used as artifact name) |
| `outputs[].path` | `Artifact.ref` (file path reference) |
| `outputs[].type` | `Artifact.content` (stored as metadata, or introduce a new field) |
| `inputs[].from` + `inputs[].artifact` | resolved by Scheduler from `context/<from>/<artifact>/` before step start |

---

## 5. Mapping to existing code

### 5.1 Type mapping

| YAML concept | Existing type/code | Notes |
|-----------|---------------|------|
| `step.worker` | `WorkerKind` enum | `CODEX_CLI`, `CLAUDE_CODE`, `OPENCODE`, `CUSTOM` |
| `step.capabilities` | `WorkerCapability` enum | `READ`, `EDIT`, `RUN_TESTS`, `RUN_COMMANDS` |
| `step.timeout` | `WorkerBudget.deadlineAt`, `BudgetLimits.timeoutMs` | parse DurationString -> ms |
| `step.max_retries` | `RetryPolicyConfig.maxAttempts` | create per-step retry policy |
| `step.max_steps` | `WorkerBudget.maxSteps` | direct mapping |
| `step.max_command_time` | `WorkerBudget.maxCommandTimeMs` | DurationString -> ms |
| `step.on_failure` | `ErrorClass` -> retry/DLQ decisions | extend scheduler `handleJobCompleted` |
| `workflow.concurrency` | `ExecutionBudgetConfig.maxConcurrency` | workflow-level concurrency |
| context artifacts | `WorkerResult.artifacts` (`Artifact`) | `type` + `ref` + `content` |
| `completion_check` | **new** | in-step loop: check completion after success |
| `max_iterations` | same pattern as `RetryPolicyConfig.maxAttempts` | safety valve; `maxAttempts` is error retries, `max_iterations` is completion loop |
| `depends_on` | **new** | extend Scheduler `processNext()` for DAG |

### 5.2 Overview of Scheduler extensions

The current Scheduler processes jobs sequentially from a single queue (`processNext()`).
Workflow support requires:

1. **WorkflowExecutor**: parse YAML, build a DAG, and convert steps into `Job`s
2. **DAG scheduler**: track depends_on completion and enqueue steps whose dependencies are satisfied
3. **Context manager**: create `context/`, collect outputs, distribute inputs
4. **Workflow state management**: control flow based on per-step `on_failure` policies

```
Current: Scheduler.processNext()
  +-- JobQueue.dequeue() -> process one Job

Extended: Scheduler.processNext()
  +-- WorkflowExecutor.getReadySteps()        # get steps with satisfied dependencies
      +-- check DAG depends_on
      +-- queue multiple steps that can run in parallel
  +-- JobQueue.dequeue() -> process Job       # existing logic remains
```

---

## 6. Error handling specification

### 6.1 Step-level failure policies

Use `on_failure` to control behavior when a step fails:

| Policy | Behavior |
|---------|------|
| `retry` | retry up to `max_retries` using existing RetryPolicy (exponential backoff + jitter). After exhaustion, transition to `on_failure_exhausted` |
| `continue` | mark step failed and continue executing downstream steps; missing inputs are treated as empty |
| `abort` | abort the workflow; not-started steps become SKIPPED; running steps are cancelled |

### 6.2 Behavior when retry limit is exceeded

If `on_failure: retry` exceeds `max_retries`:

1. Record job info to the existing DLQ
2. Escalate based on `ErrorClass`:
   - `RETRYABLE_TRANSIENT` / `RETRYABLE_RATE_LIMIT` -> mark the step FAILED and behave like abort
   - `NON_RETRYABLE` / `FATAL` -> abort immediately (no retry)
3. Record failure reason in the workflow result

### 6.3 Integration with ErrorClass

Existing `ErrorClass` classification applies as-is at step execution time:

```
Worker run
  -> WorkerResult.errorClass
ErrorClass decision
  +-- FATAL               -> abort immediately (ignores on_failure)
  +-- NON_RETRYABLE       -> follow on_failure (no retry; continue or abort)
  +-- RETRYABLE_TRANSIENT -> if on_failure: retry, use RetryPolicy
  +-- RETRYABLE_RATE_LIMIT-> if on_failure: retry, retry with backoff
```

Note: `ErrorClass.FATAL` aborts the workflow regardless of the step's `on_failure` setting.
This is consistent with Core safety invariants (mechanism).

### 6.4 completion_check loop behavior

#### Difference from retry

| | `on_failure: retry` | `completion_check` loop |
|---|---|---|
| Trigger | the worker **failed** (`WorkerStatus.FAILED`) | the worker **succeeded** but the task is **incomplete** |
| Limit | `max_retries` | `max_iterations` |
| Decider | automatic (ErrorClass) | checker worker evaluation |
| Backoff | exponential backoff + jitter | none (immediate rerun) |
| On exhaustion | DLQ + abort | follow `on_iterations_exhausted` |

#### Detailed execution flow

```
Step starts (iteration = 1)
  |
  +-> Run main worker
  |     +-- FAILED -> handle by on_failure (retry / continue / abort)
  |     |            (if retry eventually succeeds, proceed to completion_check)
  |     +-- SUCCEEDED
  |
  +-> If completion_check is not defined -> step SUCCEEDED (no loop)
  |
  +-> Run completion_check worker
  |     +-- checker FAILED -> mark step FAILED (handle via on_failure)
  |     +-- checker says complete -> step SUCCEEDED
  |     +-- checker says incomplete
  |
  +-> iteration < max_iterations ?
  |     +-- Yes -> iteration++, rerun main worker
  |     +-- No  -> handle by on_iterations_exhausted
  |              +-- abort    -> step FAILED, abort workflow
  |              +-- continue -> step INCOMPLETE, continue downstream
  |
  +-> If step timeout is reached -> cancel running worker(s), step FAILED
```

#### Checker worker response protocol

The checker worker returns a `WorkerResult`. Completion is determined as follows:

- `WorkerStatus.SUCCEEDED` -> **complete** (stop looping)
- `WorkerStatus.FAILED` with `ErrorClass.RETRYABLE_TRANSIENT` -> **incomplete** (continue looping)
- `WorkerStatus.FAILED` with `ErrorClass.NON_RETRYABLE` / `FATAL` -> **checker failure** (step FAILED)

Design intent: reuse existing `WorkerResult` / `ErrorClass` without introducing a new protocol.
The checker reports "incomplete" as a temporary failure, which is a natural encoding of "condition not met yet".

#### Context carry-over

Across iterations within the loop:

- because execution uses the **same workspace**, file changes carry over naturally
- `context/<step_id>/_meta.json` records only the final iteration result
- add an `iterations` field to `_meta.json` to record count

```json
{
  "stepId": "implement-all",
  "status": "SUCCEEDED",
  "iterations": 5,
  "maxIterations": 20,
  "...": "..."
}
```

### 6.5 Workflow timeout

When workflow-level `timeout` is reached:

1. send cancellation to all running steps (via existing `CancellationManager`)
2. skip not-started steps
3. set workflow status to `TIMED_OUT`

### 6.6 Workflow execution statuses

```typescript
enum WorkflowStatus {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  SUCCEEDED = "SUCCEEDED",     // all steps SUCCEEDED or SKIPPED (due to continue)
  FAILED = "FAILED",           // some step FAILED and aborted
  TIMED_OUT = "TIMED_OUT",     // workflow-level timeout
  CANCELLED = "CANCELLED",     // external cancellation
}

enum StepStatus {
  PENDING = "PENDING",         // waiting on unresolved dependencies
  READY = "READY",             // dependencies satisfied, waiting to run
  RUNNING = "RUNNING",         // main worker running
  CHECKING = "CHECKING",       // completion_check worker running
  SUCCEEDED = "SUCCEEDED",     // complete (including passing completion_check)
  FAILED = "FAILED",           // failed (including retry exhaustion)
  INCOMPLETE = "INCOMPLETE",   // hit max_iterations with on_iterations_exhausted: continue
  SKIPPED = "SKIPPED",         // not executed due to upstream abort
  CANCELLED = "CANCELLED",     // cancelled
}
```

---

## 7. DAG execution algorithm

### 7.1 Step state transitions

```
PENDING -> READY -> RUNNING -> SUCCEEDED
                     |   ^
                     |   +-- (completion_check incomplete) CHECKING -> RUNNING  (loop)
                     |
                     +-- CHECKING -> SUCCEEDED  (complete)
                     |
                     +-- FAILED -> (retry) -> RUNNING
                     |     |
                     |   (abort) -> downstream steps become SKIPPED
                     |
                     +-- INCOMPLETE  (max_iterations exceeded + continue)

PENDING -> SKIPPED   (upstream failure + abort)
RUNNING -> CANCELLED (timeout or external cancellation)
```

### 7.2 Scheduling loop

```
On every tick (100ms interval, synchronized with existing processLoop):

1. Scan all steps' depends_on
   - if all dependencies SUCCEEDED -> transition step to READY
   - if any dependency FAILED:
     - if that failed step had on_failure=continue -> transition to READY (artifacts are empty)
     - if that failed step had on_failure=abort -> transition this step to SKIPPED
   - if any dependency is unfinished -> remain PENDING

2. Transition READY steps to RUNNING within concurrency limits
   - create Jobs and enqueue to existing JobQueue
   - control parallelism via ExecutionBudget maxConcurrency

3. Process completion events for RUNNING steps
   - SUCCEEDED:
     - no completion_check -> collect outputs to context/, step SUCCEEDED
     - has completion_check -> transition to CHECKING and start checker worker
   - FAILED: handle by on_failure policy (retry / continue / abort)

4. Process completion events for CHECKING steps
   - complete -> collect outputs to context/, step SUCCEEDED
   - incomplete:
     - iteration < max_iterations -> iteration++, transition back to RUNNING and restart main worker
     - iteration >= max_iterations -> handle by on_iterations_exhausted (abort/continue)
   - checker fails -> step FAILED

5. When all steps are terminal (SUCCEEDED / FAILED / INCOMPLETE / SKIPPED / CANCELLED) -> workflow completes
```

### 7.3 DAG validation (on workflow load)

After YAML parse and before execution, validate:

- **cycle detection**: `depends_on` has no cycles (topological sort possible)
- **reference integrity**: all step ids referenced by `depends_on` exist
- **input integrity**: `inputs[].from` is included in `depends_on`
- **output name uniqueness**: no duplicate `outputs[].name` within a step
- **worker kind validity**: `worker` is a valid `WorkerKind` enum value
- **capability validity**: `capabilities` are valid `WorkerCapability` enum values
- **completion_check consistency**: if present, `max_iterations` must be >= 2 (<= 1 is meaningless)
- **completion_check worker validity**: `completion_check.worker` is a valid `WorkerKind`

---

## 8. Implementation roadmap

This design can be implemented incrementally. Recommended order:

### Phase 1: YAML parser + DAG validation

- YAML parser (convert into `WorkflowDefinition`)
- DAG validation (cycle detection, reference integrity)
- DurationString parser

### Phase 2: Workflow execution engine

- `WorkflowExecutor` class (step state management, DAG scheduling)
- integrate into existing Scheduler `processLoop`
- step -> Job conversion logic
- completion_check loop execution (RUNNING -> CHECKING -> RUNNING cycle)

### Phase 3: Context management

- create/manage `context/`
- collect artifacts after worker completion
- distribute artifacts by resolving inputs before worker start

### Phase 4: Error handling and observability

- execute step-level `on_failure` policies
- workflow timeout handling
- workflow execution logs and metrics

---

## 9. Constraints and future extensions

### Out of scope for now

- **conditional branching** (`if` / `when`): control step execution based on runtime conditions (future `when` field)
- **dynamic fan-out loops** (`for_each`): generate N steps from an input list (completion_check loop is supported)
- **sub-workflows**: nesting/reuse
- **external event triggers**: start workflows via webhook/cron
- **step-to-step variables**: lightweight data hand-off besides files

### Design decisions

- **Why file-based context**: workers are process-isolated and cannot share memory. The filesystem is a worker-kind-agnostic interface and makes debugging easy (inspect intermediate artifacts).
- **Why YAML**: multiline text for instructions is more natural than JSON, and diffing in Git is cleaner.
- **Why workflow-level concurrency**: worker processes consume resources; unbounded parallelism can overload the system. Control it in conjunction with `ExecutionBudgetConfig.maxConcurrency`.
