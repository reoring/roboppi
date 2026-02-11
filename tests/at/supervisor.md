# Workflow System Acceptance Test Plan

## Test Strategy

- **Test level**: E2E tests that take YAML strings as input and assert on the resulting `WorkflowState`
- **Worker**: use `MockStepRunner`; do not spawn real processes (process integration is out of scope)
- **File I/O**: use real filesystem operations (because `ContextManager` works with real files)
- **Run all tests in a temp directory and clean up afterwards**

---

## AT-1: Full pipeline (YAML parse -> DAG validate -> execute)

### AT-1.1 Happy path: complete the design-doc "implement -> review -> fix" example

**Input YAML**: the `implement-review-fix` workflow from `docs/workflow-design.md` section 3.1

**MockStepRunner behavior**:
- Return `SUCCEEDED` for all steps
- For each step, write the file corresponding to `outputs[].path` into the workspace

**Assertions**:
| # | What | Expected |
|---|---------|--------|
| 1 | `WorkflowState.status` | `SUCCEEDED` |
| 2 | `StepState.status` for all steps | `SUCCEEDED` |
| 3 | Execution order | `implement` -> (`test`, `review` in parallel) -> `fix` |
| 4 | File exists at `context/implement/implementation/` | true |
| 5 | File exists at `context/review/review-comments/` | true |
| 6 | File exists at `context/test/test-report/` | true |
| 7 | `context/_workflow.json` exists with correct `name` | `"implement-review-fix"` |
| 8 | Each step has `_meta.json` | true |

### AT-1.2 Happy path: complete the design-doc `completion_check` loop example

**Input YAML**: the `implement-from-todo` workflow from `docs/workflow-design.md` section 3.3

**MockStepRunner behavior**:
- `implement-all`: always `SUCCEEDED`
- `completion_check`: return `complete: true` on the 3rd call
- `verify`: `SUCCEEDED`

**Assertions**:
| # | What | Expected |
|---|---------|--------|
| 1 | `WorkflowState.status` | `SUCCEEDED` |
| 2 | `StepState.iteration` for `implement-all` | `3` |
| 3 | `StepState.status` for `implement-all` | `SUCCEEDED` |
| 4 | `StepState.status` for `verify` | `SUCCEEDED` |
| 5 | StepRunner `runStep` call count (`implement-all`) | `3` |
| 6 | StepRunner `runCheck` call count (`implement-all`) | `3` |

### AT-1.3 Negative cases: invalid YAML is rejected early

**Input YAML**: each case below

| Case | Problem | Expected |
|--------|-----------|---------|
| a | `version: "2"` | `WorkflowParseError` (version must be "1") |
| b | `steps` is an empty object | `WorkflowParseError` (at least one step) |
| c | step has `worker: "INVALID"` | `WorkflowParseError` (invalid worker) |
| d | `capabilities: ["DESTROY"]` | `WorkflowParseError` (invalid capability) |
| e | `completion_check` present + missing `max_iterations` | `WorkflowParseError` (max_iterations required) |
| f | `completion_check` present + `max_iterations: 1` | `WorkflowParseError` (must be >= 2) |
| g | `on_failure: "explode"` | `WorkflowParseError` (invalid on_failure) |
| h | YAML syntax error (bad indentation) | `WorkflowParseError` (Invalid YAML) |

### AT-1.4 Negative cases: DAG validation errors

| Case | DAG issue | Expected |
|--------|-----------|---------|
| a | A -> B -> A (cycle) | `validateDag` returns a cycle error |
| b | A -> B -> C -> A (3-node cycle) | `validateDag` returns a cycle error |
| c | `depends_on: ["nonexistent"]` | reference integrity error |
| d | `inputs[].from` not listed in `depends_on` | input integrity error |
| e | duplicate `outputs[].name` within a step | output-name uniqueness error |
| f | self dependency `depends_on: ["self"]` | cycle error |

---

## AT-2: DAG execution topology

### AT-2.1 Linear chain (A -> B -> C -> D)

**Assertions**:
- Execution order is exactly `[A, B, C, D]`
- Each step starts only after its dependencies are `SUCCEEDED`
- All steps `SUCCEEDED` -> `WorkflowStatus.SUCCEEDED`

### AT-2.2 Diamond (A -> {B, C} -> D)

**Assertions**:
- B and C start in parallel after A completes
- D starts only after both B and C complete
- `MockStepRunner.maxConcurrentObserved >= 2`

### AT-2.3 Wide fan-out (A -> {B, C, D, E})

**Assertions**:
- All 4 steps can start in parallel when no concurrency limit is set
- With `concurrency: 2`, observed parallelism is <= 2

### AT-2.4 Independent graph (A, B, C have no dependencies)

**Assertions**:
- All steps become READY immediately
- Steps run in parallel
- A FAILED step does not block others (depending on `on_failure` policy)

### AT-2.5 Deep dependency chain (A -> B -> C -> ... -> J, depth 10)

**Assertions**:
- All 10 steps run to completion in order
- With `on_failure: abort`, a failure causes all dependents to become SKIPPED

### AT-2.6 Complex DAG (multiple join points)

```
A → B → D → F
A → C → D
A → C → E → F
```

**Assertions**:
- D starts only after both B and C complete
- F starts only after both D and E complete
- E depends only on C

---

## AT-3: Context hand-off (ContextManager)

### AT-3.1 Passing a file between steps

**Scenario**:
1. step A writes `output.txt` into its workspace
2. step A declares `outputs: [{name: "result", path: "output.txt"}]`
3. step B declares `inputs: [{from: "A", artifact: "result"}]`
4. verify that `result/output.txt` exists in step B's workspace

**MockStepRunner behavior**:
- In A's `runStep`, run `fs.writeFile(workspace + "/output.txt", "hello")`
- In B's `runStep`, read `fs.readFile(workspace + "/result/output.txt")` and assert the content

**Assertions**:
| # | What | Expected |
|---|---------|--------|
| 1 | `context/A/result/output.txt` exists | true |
| 2 | `result/output.txt` exists in B workspace | true |
| 3 | file content | `"hello"` |

### AT-3.2 Passing a directory artifact

**Scenario**: step A outputs a `src/` directory and step B consumes it

**Assertions**:
- The directory is copied under `context/A/<artifactName>/`
- The directory structure is recreated in B's workspace

### AT-3.3 Renaming with `as`

**Scenario**: `inputs: [{from: "A", artifact: "result", as: "prev-output"}]`

**Assertions**:
- The directory is placed in B's workspace as `prev-output/` (not `result/`)

### AT-3.4 Referencing a missing artifact

**Scenario**: step A does not write the file declared in its outputs

**Assertions**:
- `collectOutputs` does not error (it skips missing artifacts)
- In B's `resolveInputs`, the corresponding input directory is empty

### AT-3.5 Missing inputs with on_failure: continue

**Scenario**:
- A FAILED (on_failure: continue)
- B references A's artifacts via inputs

**Assertions**:
- B is still started
- A's artifacts do not exist in B's workspace (empty)
- B can still execute successfully

### AT-3.6 Verifying `_meta.json`

**Scenario**: read `_meta.json` for a successful step

**Assertions**:
| Field | Expected |
|-----------|--------|
| `stepId` | matches the step id |
| `status` | `"SUCCEEDED"` |
| `startedAt` | number > 0 |
| `completedAt` | >= `startedAt` |
| `attempts` | >= 1 |
| `workerKind` | matches the step's `worker` |
| `artifacts` | corresponds to the `outputs` definition |

### AT-3.7 Verifying `_workflow.json`

**Assertions**:
| Field | Expected |
|-----------|--------|
| `id` | UUID format |
| `name` | matches the workflow name |
| `startedAt` | number > 0 |
| `status` | `"RUNNING"` (written while executing) |

---

## AT-4: completion_check loop

### AT-4.1 Complete on first check (no loop)

**Scenario**: completion_check returns `complete: true` on the first call

**Assertions**:
- `runStep` called once, `runCheck` called once
- `StepState.iteration` = 1
- `StepState.status` = `SUCCEEDED`

### AT-4.2 Complete on the Nth iteration

**Scenario**: completion_check returns `complete: true` on the Nth call (N = 5), with `max_iterations: 10`

**Assertions**:
- `runStep` called 5 times, `runCheck` called 5 times
- `StepState.iteration` = 5
- workflow status is SUCCEEDED

### AT-4.3 Hit max_iterations + abort

**Scenario**: completion_check always returns `complete: false`, with `max_iterations: 3` and `on_iterations_exhausted: "abort"`

**Assertions**:
- `runStep` called 3 times, `runCheck` called 3 times
- step FAILED
- dependent steps SKIPPED
- workflow FAILED

### AT-4.4 Hit max_iterations + continue

**Scenario**: completion_check always returns `complete: false`, with `max_iterations: 3` and `on_iterations_exhausted: "continue"`

**Assertions**:
- step INCOMPLETE
- dependent steps still execute
- workflow SUCCEEDED (if there are no other failures)

### AT-4.5 Checker itself fails

**Scenario**: completion_check returns `{complete: false, failed: true}`

**Assertions**:
- step FAILED
- loop stops immediately (regardless of max_iterations)
- dependents are SKIPPED or executed based on on_failure policy

### AT-4.6 Step failure during loop + retry before completion_check

**Scenario**:
- iteration 1: `runStep` FAILED (RETRYABLE_TRANSIENT) -> retry -> SUCCEEDED -> check incomplete
- iteration 2: `runStep` SUCCEEDED -> check complete

**Assertions**:
- `runStep` called 3 times (1 failure + 1 retry success + 1 for iteration 2)
- `runCheck` called 2 times
- step SUCCEEDED, iteration = 2

### AT-4.7 File state persists across loop iterations

**Scenario**:
- iteration 1: worker writes "step1" to `progress.txt`
- iteration 2: worker reads `progress.txt` and appends, producing "step1\nstep2"
- completion_check: completes on iteration 2

**Assertions**:
- file state accumulates because execution uses the same workspace
- final `progress.txt` content is "step1\nstep2"

---

## AT-5: Error handling

### AT-5.1 on_failure: abort - all dependents are SKIPPED

**Scenario**: A -> B -> C, B FAILED (on_failure: abort)

**Assertions**:
- A: SUCCEEDED, B: FAILED, C: SKIPPED
- workflow: FAILED

### AT-5.2 on_failure: continue - dependents still execute

**Scenario**: A -> B -> C, A FAILED (on_failure: continue)

**Assertions**:
- A: FAILED, B: SUCCEEDED, C: SUCCEEDED
- workflow: FAILED (because a step FAILED)

### AT-5.3 on_failure: retry - retry succeeds

**Scenario**: A (max_retries: 2), first attempt FAILED (RETRYABLE_TRANSIENT), second attempt SUCCEEDED

**Assertions**:
- A: SUCCEEDED
- `runStep` call count: 2
- workflow: SUCCEEDED

### AT-5.4 on_failure: retry - hit retry limit

**Scenario**: A (max_retries: 2, on_failure: retry), all attempts FAILED

**Assertions**:
- `runStep` call count: 3 (initial + 2 retries)
- A: FAILED
- dependents: SKIPPED

### AT-5.5 ErrorClass.FATAL overrides on_failure

| Case | on_failure | ErrorClass | Expected behavior |
|--------|---------------|-----------|---------|
| a | `continue` | `FATAL` | step FAILED, dependents SKIPPED |
| b | `retry` (max_retries: 5) | `FATAL` | no retry (`runStep` once), dependents SKIPPED |
| c | `abort` | `FATAL` | step FAILED, dependents SKIPPED |

### AT-5.6 Retry behavior by ErrorClass (on_failure: retry)

| ErrorClass | Behavior with on_failure: retry |
|-----------|--------------------------|
| `RETRYABLE_TRANSIENT` | retries |
| `RETRYABLE_RATE_LIMIT` | retries |
| `NON_RETRYABLE` | no retry (immediate FAILED) |
| `FATAL` | no retry (immediate abort) |

### AT-5.7 One of parallel steps aborts

**Scenario**: A -> {B, C} -> D, B FAILED (abort), C is running

**Assertions**:
- B: FAILED
- C: if already running, it runs to completion (running steps are not cancelled)
- D: SKIPPED (due to B abort)
- workflow: FAILED

### AT-5.8 Default on_failure

**Scenario**: a step without on_failure specified FAILED

**Assertions**:
- treated as abort (dependents are SKIPPED)

---

## AT-6: Timeout

### AT-6.1 Workflow-level timeout

**Scenario**: workflow.timeout = "1s", step A takes 5 seconds

**Assertions**:
- A: CANCELLED
- not-started steps: SKIPPED
- workflow: TIMED_OUT
- total time ends near timeout (+/- 500ms)

### AT-6.2 Multiple steps running when timeout fires

**Scenario**: A, B, C run in parallel and the workflow times out

**Assertions**:
- all running steps: CANCELLED
- pending steps: SKIPPED
- workflow: TIMED_OUT

### AT-6.3 Timeout during completion_check loop

**Scenario**: workflow times out mid loop (iteration 3/10)

**Assertions**:
- step: CANCELLED
- loop is interrupted
- workflow: TIMED_OUT

### AT-6.4 AbortSignal fires on timeout

**Scenario**: worker listens via `abortSignal.addEventListener("abort", ...)`

**Assertions**:
- abort event fires
- worker can detect abort and stop work

---

## AT-7: Concurrency control

### AT-7.1 concurrency: 1 runs sequentially

**Scenario**: A, B, C (no dependencies), concurrency: 1

**Assertions**:
- `maxConcurrentObserved` = 1
- all steps SUCCEEDED

### AT-7.2 concurrency: 2 with 4 steps

**Scenario**: A, B, C, D (no dependencies), concurrency: 2

**Assertions**:
- `maxConcurrentObserved` <= 2
- all steps SUCCEEDED

### AT-7.3 concurrency omitted (default: unlimited)

**Scenario**: A, B, C, D, E (no dependencies), concurrency omitted

**Assertions**:
- all steps can start concurrently
- `maxConcurrentObserved` >= 4

### AT-7.4 concurrency combined with DAG dependencies

**Scenario**: A -> {B, C, D}, concurrency: 2

**Assertions**:
- after A completes, at most 2 of B/C/D run concurrently
- the 3rd starts only after one of the first two completes

---

## AT-8: DurationString parser

| Input | Expected (ms) |
|-----|------------|
| `"5s"` | 5000 |
| `"30s"` | 30000 |
| `"5m"` | 300000 |
| `"2h"` | 7200000 |
| `"1h30m"` | 5400000 |
| `"1h30m45s"` | 5445000 |
| `""` | Error |
| `"0s"` | Error |
| `"abc"` | Error |
| `"5x"` | Error |
| `"-5m"` | Error |

---

## AT-9: Edge cases

### AT-9.1 Workflow with a single step

**Assertions**:
- executes and completes successfully
- passes DAG validation

### AT-9.2 Step with no outputs

**Scenario**: step has no `outputs` defined

**Assertions**:
- `context/<stepId>/` directory is created but artifacts are empty
- does not affect execution of dependent steps

### AT-9.3 Multiple steps output the same file path

**Scenario**: A and B each declare `outputs: [{name: "code", path: "src/main.ts"}]`

**Assertions**:
- copied into each step's context directory independently (no collision)
- `context/A/code/main.ts` and `context/B/code/main.ts` are independent

### AT-9.4 Very long step id

**Scenario**: step id is 200 characters long

**Assertions**:
- parse/validate/execute do not error

### AT-9.5 instructions include special characters

**Scenario**: YAML multiline text includes unicode, emoji, and backslashes

**Assertions**:
- parsed `instructions` preserves the original text exactly

### AT-9.6 All steps are SKIPPED

**Scenario**: A FAILED (on_failure: abort), and B, C, D all depend on A

**Assertions**:
- workflow: FAILED
- B, C, D: all SKIPPED

---

## AT-10: Coverage delta vs existing unit tests

The following are not covered by existing unit tests, and should be emphasized in acceptance tests:

| # | Gap | AT |
|---|---------|---------|
| 1 | Full pipeline: YAML parse -> validate -> execute | AT-1.1, AT-1.2 |
| 2 | Real file hand-off via `ContextManager.resolveInputs()` / `collectOutputs()` | AT-3.1 to AT-3.5 |
| 3 | Validate `_meta.json` / `_workflow.json` contents | AT-3.6, AT-3.7 |
| 4 | completion_check combined with retry | AT-4.6 |
| 5 | File state persistence across loop iterations | AT-4.7 |
| 6 | One parallel step aborting: behavior of the other | AT-5.7 |
| 7 | Retry matrix by ErrorClass | AT-5.6 |
| 8 | Deep dependency chains (10+ depth) | AT-2.5 |
| 9 | Combining concurrency limits with DAG dependencies | AT-7.4 |
| 10 | Timeout during completion_check loop | AT-6.3 |

---

## Proposed test file layout

```
tests/at/
├── supervisor.md                              # This document
├── workflow-pipeline.test.ts                  # AT-1: full pipeline
├── workflow-dag-topology.test.ts              # AT-2: DAG topology
├── workflow-context-passing.test.ts           # AT-3: context hand-off
├── workflow-completion-check.test.ts          # AT-4: completion_check loop
├── workflow-error-handling.test.ts            # AT-5: error handling
├── workflow-timeout.test.ts                   # AT-6: timeout
├── workflow-concurrency.test.ts              # AT-7: concurrency control
├── workflow-duration-parser.test.ts           # AT-8: DurationString parser
└── workflow-edge-cases.test.ts               # AT-9: edge cases
```

## Acceptance criteria

- all test cases above PASS
- `bun x tsc --noEmit` returns zero errors
- the existing 408 tests continue to PASS
