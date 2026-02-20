# Workflow Guide

AgentCore workflows let you define multiple steps declaratively in YAML and execute them automatically. You can express dependencies (DAG), pass context between steps, and control retries/continuation on failures - all of which are needed for real development flows.

## Contents

1. [What is a workflow?](#what-is-a-workflow)
2. [YAML schema](#yaml-schema)
3. [Defining steps](#defining-steps)
4. [Dependencies with DAG](#dependencies-with-dag)
5. [Context hand-off](#context-hand-off)
6. [Completion check (loop execution)](#completion-check-loop-execution)
7. [Failure handling](#failure-handling)
8. [Worker kinds](#worker-kinds)
9. [Running workflows](#running-workflows)
10. [Sample walkthroughs](#sample-walkthroughs)

---

## What is a workflow?

A workflow is a mechanism for executing multiple steps in sequence (or in parallel).

For example, when you want to run "build -> test -> report" with a fixed order, a workflow is a good fit. Instead of running each command manually, you can write the workflow in YAML and let AgentCore resolve dependencies and execute it.

Common use cases:

- implement -> review -> fix
- run multiple test suites in parallel and aggregate results
- iterate until all items in a task list are complete
- retry failed steps automatically while allowing some steps to continue even if they fail

---

## YAML schema

### Top-level structure

```yaml
name: my-workflow          # workflow name
version: "1"               # schema version (currently fixed to "1")
description: "description"  # optional
timeout: "30m"              # workflow-level timeout
concurrency: 2             # max parallel steps (omit for unlimited)
context_dir: "./context"   # context directory (default: "./context")

steps:
  step-a:
    # ... step definition
  step-b:
    # ... step definition
```

| Field | Type | Required | Description |
|-----------|-----|------|------|
| `name` | string | yes | workflow name |
| `version` | `"1"` | yes | schema version |
| `description` | string | no | description |
| `timeout` | DurationString | yes | overall timeout (e.g. `"30m"`, `"2h"`) |
| `concurrency` | number | no | max concurrent steps |
| `context_dir` | string | no | context directory path |
| `steps` | Record | yes | step definitions (keys are step ids) |

DurationString examples: `"200ms"`, `"30s"`, `"5m"`, `"2h"`, `"1h30m"`.

---

## Defining steps

Each step is defined as a key/value pair under `steps` (key = step id).

```yaml
steps:
  build:
    description: "Build the source"
    worker: CUSTOM
    instructions: |
      mkdir -p dist
      echo 'console.log("hello")' > dist/main.js
    capabilities: [EDIT]
    timeout: "5m"
```

### Full step fields

| Field | Type | Required | Description |
|-----------|-----|------|------|
| `description` | string | no | step description |
| `agent` | string | no | agent profile id (resolved from an external agent catalog) |
| `worker` | enum | yes | worker kind (see below) |
| `model` | string | no | model id (format depends on worker/CLI) |
| `instructions` | string | yes | instructions passed to the worker |
| `capabilities` | enum[] | yes | allowed operations |
| `workspace` | string | no | working directory (default: `"."`) |
| `depends_on` | string[] | no | list of prerequisite step ids |
| `inputs` | InputRef[] | no | references to upstream artifacts |
| `outputs` | OutputDef[] | no | output definitions for this step |
| `timeout` | DurationString | no | step timeout |
| `max_retries` | number | no | max retries (default: 0) |
| `max_steps` | number | no | max worker steps |
| `max_command_time` | DurationString | no | per-command timeout |
| `completion_check` | object | no | completion check definition (see below) |
| `convergence` | object | no | optional convergence control for completion-check loops (stall detection, scope guard, fail-fast) |
| `max_iterations` | number | no | max completion-check iterations (default: 1) |
| `on_iterations_exhausted` | enum | no | behavior on hitting iteration limit: `abort` / `continue` |
| `on_failure` | enum | no | behavior on failure: `retry` / `continue` / `abort` (default: `abort`) |

When `agent` is set, the runner can fill defaults from the agent profile. In that case, `worker`, `model`, `capabilities`, `workspace`, and timeout/budget fields can be omitted and will be inherited from the profile (step-level fields override profile defaults).

If the agent profile defines `base_instructions`, they are prepended before `instructions`.

---

## Agent catalogs (reusable agent profiles)

To reuse a worker+model+base instructions bundle across workflows, define agents in a separate YAML file and reference them from steps.

See also: `docs/guides/agents.md`.

### Agent catalog file format

Create an `agents.yaml` next to your workflow YAML (or pass an explicit path).

```yaml
version: "1"
agents:
  research:
    worker: OPENCODE
    model: openai/gpt-5.2
    capabilities: [READ]
    base_instructions: |
      You are a research agent.
      - Only read files. Do not edit.
      - Write findings as Markdown.
```

### Reference from a workflow

```yaml
steps:
  investigate:
    agent: research
    instructions: |
      Investigate how workflow execution works in this repo.
      Write a short report to docs/research.md.
    outputs:
      - name: report
        path: docs/research.md
        type: review
```

### How the catalog is loaded

The runner loads agent catalogs from these sources:

- Explicit: `AGENTCORE_AGENTS_FILE` (colon-separated list) + `--agents <path>` (repeatable). If the same agent id is defined multiple times, later definitions override earlier ones (so `--agents` wins over `AGENTCORE_AGENTS_FILE`).
- Implicit (only when no explicit paths are provided): `agents.yaml` / `agents.yml` next to the workflow YAML.

### capabilities

Specify allowed operations as an array.

| Value | Meaning |
|-----|------|
| `READ` | read files |
| `EDIT` | create/edit files |
| `RUN_TESTS` | run tests |
| `RUN_COMMANDS` | run arbitrary commands |

```yaml
capabilities: [READ, EDIT, RUN_TESTS]
```

---

## Dependencies with DAG

Use `depends_on` to control step order. A step runs only after all its dependencies complete.

### Sequential execution

```yaml
steps:
  build:
    worker: CUSTOM
    instructions: "Build"
    capabilities: [EDIT]

  test:
    worker: CUSTOM
    depends_on: [build]          # run after build
    instructions: "Test"
    capabilities: [READ, RUN_TESTS]

  deploy:
    worker: CUSTOM
    depends_on: [test]           # run after test
    instructions: "Deploy"
    capabilities: [RUN_COMMANDS]
```

Execution order: `build` -> `test` -> `deploy`.

### Parallel execution and join

Steps that share the same dependency can run in parallel. A step with multiple dependencies waits until all are complete.

```yaml
steps:
  build:
    worker: CUSTOM
    instructions: "Build"
    capabilities: [EDIT]

  test-unit:
    depends_on: [build]           # start after build
    worker: CUSTOM
    instructions: "Unit tests"
    capabilities: [RUN_TESTS]

  test-e2e:
    depends_on: [build]           # start after build (in parallel with test-unit)
    worker: CUSTOM
    instructions: "E2E tests"
    capabilities: [RUN_TESTS]

  report:
    depends_on: [test-unit, test-e2e]   # wait for both
    worker: CUSTOM
    instructions: "Summarize results"
    capabilities: [READ, EDIT]
```

DAG:

```
build
  +-- test-unit --+
  +-- test-e2e ---+-- report
```

`test-unit` and `test-e2e` run concurrently after `build`. `report` waits for both. If you set `concurrency: 2`, the max parallel steps is limited to 2.

---

## Context hand-off

To pass files between steps, use `outputs` and `inputs`.

### outputs (declare artifacts)

Publish files/directories as artifacts.

```yaml
outputs:
  - name: build-output       # artifact name (key referenced by downstream steps)
    path: "dist"             # file or directory path
    type: code               # optional hint
```

### inputs (consume artifacts)

Import upstream artifacts.

```yaml
inputs:
  - from: build              # upstream step id
    artifact: build-output   # outputs[].name
    as: build-files          # local name (default: same as artifact)
```

### Example: use build artifacts in test

```yaml
steps:
  build:
    worker: CUSTOM
    instructions: |
      mkdir -p dist
      echo 'export function add(a, b) { return a + b; }' > dist/math.js
    capabilities: [EDIT]
    outputs:
      - name: build-output
        path: "dist"
        type: code

  test:
    worker: CUSTOM
    depends_on: [build]
    instructions: |
      # Artifacts imported via inputs are available
      cat build-output/dist/math.js
      echo "PASS: test passed"
    capabilities: [READ, RUN_TESTS]
    inputs:
      - from: build
        artifact: build-output
```

### Context directory layout

At runtime, the workflow context directory looks like:

```
<workspace>/
  +-- context/
      +-- _workflow.json              # workflow metadata
      +-- build/
      |    +-- _meta.json             # step result metadata
      |    +-- build-output/          # artifacts declared by outputs
      |         +-- dist/math.js
      +-- test/
           +-- _meta.json
```

`_meta.json` records step execution state (status, duration, attempts, etc.).

---

## Completion check (loop execution)

`completion_check` lets you decide "is it actually complete?" after a step runs and, if incomplete, rerun it in a loop.

This is for cases where the worker run succeeded, but the overall objective is not yet complete (e.g. processing one task-list item at a time until all are done).

### Basic form

```yaml
steps:
  process:
    worker: CUSTOM
    instructions: |
      # Process one incomplete task
      ...
    capabilities: [READ, EDIT]
    timeout: "5m"

    completion_check:
      worker: CUSTOM
      instructions: |
        # Check whether all tasks are complete
        REMAINING=$(grep -c '^\- \[ \]' todo.txt || true)
        if [ "$REMAINING" -eq 0 ]; then
          exit 0   # complete -> stop loop
        else
          exit 1   # incomplete -> rerun main worker
        fi
      capabilities: [READ]
      timeout: "1m"

    max_iterations: 10                # max loop count
    on_iterations_exhausted: abort    # abort or continue
```

### Execution flow

```
Step start (iteration 1)
  |
  +-> Run main worker
  |     +-- failed -> handle via on_failure
  |     +-- succeeded
  |
  +-> Run completion_check
  |     +-- exit 0 (complete) -> step completes
  |     +-- exit 1 (incomplete)
  |
  +-> iteration < max_iterations ?
  |     +-- Yes -> iteration++ -> rerun main worker
  |     +-- No  -> handle via on_iterations_exhausted
  |
  +-> step timeout -> cancelled
```

### Difference from retry

| | `on_failure: retry` | `completion_check` loop |
|---|---|---|
| Trigger | the worker **failed** | the worker **succeeded** but task is **incomplete** |
| Limit | `max_retries` | `max_iterations` |
| Decision | automatic (exit code / classification) | checker worker decides |

### completion_check fields

| Field | Type | Required | Description |
|-----------|-----|------|------|
| `worker` | enum | yes | worker used for checking |
| `model` | string | no | model id (format depends on worker/CLI) |
| `instructions` | string | yes | check instructions |
| `capabilities` | enum[] | yes | checker capabilities (usually `[READ]`) |
| `timeout` | DurationString | no | timeout per check |
| `decision_file` | string | no | optional decision file path (workspace-relative). If set, Roboppi reads it after the check runs. Supported formats: structured JSON `{"decision":"complete"|"incomplete","check_id":"...","reasons":[...],"fingerprints":[...]}` (recommended) and legacy `PASS/COMPLETE` / `FAIL/INCOMPLETE` text. When `decision_file` is set, the runner provides `ROBOPPI_COMPLETION_CHECK_ID` (and legacy `AGENTCORE_COMPLETION_CHECK_ID`) in the check environment so the checker can include it as `check_id`. |

### convergence fields (opt-in)

The Convergence Controller helps prevent non-terminating `INCOMPLETE` loops by:

- escalating “stalled” iterations (same `fingerprints` repeating)
- optionally enforcing `allowed_paths` / diff budget
- fail-fast with a diagnosis artifact under `context/<step>/_convergence/`

| Field | Type | Required | Description |
|-----------|-----|------|------|
| `enabled` | boolean | no | enable convergence control (default: false) |
| `stall_threshold` | number | no | repeats before escalating stage (default: 2) |
| `max_stage` | number | no | max stage; reaching it triggers fail-fast unless disabled (default: 3) |
| `fail_on_max_stage` | boolean | no | fail-fast when escalating to `max_stage` (default: true) |
| `stages` | object[] | no | per-stage instruction overlays (`stage`, `append_instructions`) |
| `allowed_paths` | string[] | no | restrict changed files to these patterns (prefix or glob) |
| `ignored_paths` | string[] | no | ignore patterns for scope/budget checks |
| `diff_base_ref` | string | no | git base ref used for diff/scope checks (default: `HEAD`) |
| `diff_base_ref_file` | string | no | file containing git base ref (first line) |
| `max_changed_files` | number | no | diff budget: max changed files (tracked + untracked) |

Example:

```yaml
steps:
  implement:
    # ...
    completion_check:
      decision_file: .roboppi-loop/review.verdict
      # ...
    max_iterations: 10
    convergence:
      enabled: true
      stall_threshold: 2
      max_stage: 3
      diff_base_ref_file: .roboppi-loop/review.base_ref
      allowed_paths: ["src/**", "test/**"]
      max_changed_files: 200
```

---

## Failure handling

Control behavior when a step fails via `on_failure`.

### on_failure policies

| Policy | Behavior |
|---------|------|
| `abort` (default) | abort the whole workflow; pending steps are skipped |
| `retry` | retry up to `max_retries`; abort if exhausted |
| `continue` | record failure but continue executing downstream steps |

### retry example

```yaml
steps:
  flaky-api-call:
    worker: CUSTOM
    instructions: "Call an external API"
    capabilities: [RUN_COMMANDS]
    max_retries: 3
    on_failure: retry
    timeout: "2m"
```

Retries use exponential backoff (wait time grows).

### continue example

```yaml
steps:
  lint:
    worker: CUSTOM
    instructions: "Run lint"
    capabilities: [READ]
    on_failure: continue
    outputs:
      - name: lint-report
        path: "lint-result.txt"

  build:
    depends_on: [lint]     # runs even if lint fails
    worker: CUSTOM
    instructions: "Build"
    capabilities: [EDIT]
```

With `continue`, downstream steps still run, but artifacts from the failed step may not be available.

### abort example

```yaml
steps:
  critical-setup:
    worker: CUSTOM
    instructions: "Critical setup"
    capabilities: [EDIT]
    on_failure: abort

  work:
    depends_on: [critical-setup]
    worker: CUSTOM
    instructions: "Main work"
    capabilities: [READ, EDIT]
```

If `critical-setup` fails, `work` is skipped and the workflow becomes `FAILED`.

---

## Worker kinds

Pick a worker kind via the `worker` field.

| Worker | Description | Typical use |
|--------|------|------|
| `CUSTOM` | run shell commands directly | scripts, builds, tests |
| `CLAUDE_CODE` | launch Claude Code as an agent | reviews, analysis, generation |
| `CODEX_CLI` | launch Codex CLI as an agent | implementation, refactoring |
| `OPENCODE` | launch OpenCode as an agent | generation, test fixes |

### CUSTOM worker

The simplest worker. Whatever you write in `instructions` is executed as a shell script.

```yaml
steps:
  hello:
    worker: CUSTOM
    instructions: |
      echo "Hello from CUSTOM worker!"
      date > timestamp.txt
    capabilities: [EDIT]
```

`CUSTOM` requires no extra tool installation and is a good default for validating workflow behavior or running shell-based tasks.

### AI agent workers

`CLAUDE_CODE`, `CODEX_CLI`, and `OPENCODE` launch AI agents. You can write natural-language instructions.

```yaml
steps:
  implement:
    worker: CODEX_CLI
    instructions: |
      Add an array-unique function to src/utils.ts.
      Implement it in a type-safe way and add tests.
    capabilities: [READ, EDIT, RUN_TESTS]
    timeout: "15m"

  review:
    worker: CLAUDE_CODE
    depends_on: [implement]
    instructions: |
      Review the changes in src/utils.ts.
      Check performance, edge cases, and type safety.
    capabilities: [READ]
    timeout: "10m"
```

These workers require the corresponding tools to be installed (see prerequisites in the [Quickstart](./quickstart.md)).

---

## Running workflows

### Basic

```bash
roboppi workflow <workflow.yaml>
# (dev) bun run src/workflow/run.ts <workflow.yaml>
```

By default, workflows run in **supervised** mode (Supervisor -> Core -> Worker) so all steps go through Core safety mechanisms.
Use `--direct` to spawn worker processes directly from the runner (no Core IPC).

### Options

| Option | Short | Description | Default |
|-----------|--------|------|----------|
| `--workspace <dir>` | `-w` | working directory | temp directory |
| `--verbose` | `-v` | show step output | off |
| `--supervised` | - | supervised mode: delegate steps via Core IPC (Supervisor -> Core -> Worker) | on |
| `--direct` | - | direct mode: spawn worker processes directly (no Core IPC) | off |
| `--no-supervised` | - | alias for `--direct` | - |
| `--keepalive` | - | emit periodic output to avoid no-output watchdogs | auto (on when non-TTY) |
| `--no-keepalive` | - | disable keepalive output | - |
| `--keepalive-interval <d>` | - | keepalive interval (DurationString) | `10s` |
| `--ipc-request-timeout <d>` | - | IPC request timeout for supervised mode (DurationString) | `2m` |
| `--agents <path>` | - | agent catalog YAML (repeatable); merged with `AGENTCORE_AGENTS_FILE` | auto-load `agents.yaml` / `agents.yml` next to workflow |
| `--help` | `-h` | show help | - |

### Examples

```bash
# run with a temp directory
roboppi workflow examples/hello-world.yaml
# (dev) bun run src/workflow/run.ts examples/hello-world.yaml

# specify a workspace
roboppi workflow examples/build-test-report.yaml --workspace /tmp/my-work
# (dev) bun run src/workflow/run.ts examples/build-test-report.yaml --workspace /tmp/my-work

# verbose output
roboppi workflow examples/todo-loop.yaml --verbose
# (dev) bun run src/workflow/run.ts examples/todo-loop.yaml --verbose

# supervised mode is the default
roboppi workflow examples/agent-pr-loop.yaml --verbose
# (dev) bun run src/workflow/run.ts examples/agent-pr-loop.yaml --verbose

# direct mode (runner spawns worker processes)
roboppi workflow examples/agent-pr-loop.yaml --direct --verbose
# (dev) bun run src/workflow/run.ts examples/agent-pr-loop.yaml --direct --verbose
```

### Reading results

Running prints output like:

```
Workflow: /home/user/agentcore/examples/build-test-report.yaml
Name:     build-test-report
Steps:    build, test-math, test-greet, report
Timeout:  5m

--- Results ---

  PASS  build
  PASS  test-math
  PASS  test-greet
  PASS  report

Workflow: SUCCEEDED  (2.3s)
Context:  /tmp/my-work/context
```

Step status labels:

| Label | Meaning |
|------|------|
| `PASS` | completed successfully |
| `FAIL` | failed (including retry exhaustion) |
| `SKIP` | skipped due to upstream failure |
| `INCOMPLETE` | hit completion-check iteration limit with `on_iterations_exhausted: continue` |
| `CANCELLED` | cancelled |

Looped steps show `(N iterations)`.

---

## Sample walkthroughs

There are four samples under `examples/`.

### hello-world.yaml - minimal example

The simplest workflow: one step that runs a shell command to create a file.

```yaml
name: hello-world
version: "1"
timeout: "1m"

steps:
  greet:
    description: "Create a Hello World file"
    worker: CUSTOM
    instructions: |
      echo "Hello from AgentCore Workflow!" > hello.txt
      echo "Timestamp: $(date)" >> hello.txt
      cat hello.txt
    capabilities: [EDIT]
    timeout: "30s"
    outputs:
      - name: greeting
        path: "hello.txt"
        type: text
```

Run:

```bash
roboppi workflow examples/hello-world.yaml --verbose
# (dev) bun run src/workflow/run.ts examples/hello-world.yaml --verbose
```

Key point: best for learning the basic structure (`name`, `version`, `timeout`, `steps`).

### build-test-report.yaml - parallelism and join

Demonstrates build -> (two tests in parallel) -> report.

```yaml
name: build-test-report
version: "1"
timeout: "5m"
concurrency: 2

steps:
  build:
    worker: CUSTOM
    instructions: |
      mkdir -p dist
      echo 'export function add(a, b) { return a + b; }' > dist/math.js
      echo 'export function greet(name) { return "Hello, " + name; }' > dist/greet.js
    capabilities: [EDIT]
    outputs:
      - name: build-output
        path: "dist"
        type: code

  test-math:
    depends_on: [build]
    worker: CUSTOM
    instructions: |
      echo "PASS: add(1, 2) === 3" > test-math-result.txt
    capabilities: [READ, RUN_TESTS]
    inputs:
      - from: build
        artifact: build-output
    on_failure: continue
    outputs:
      - name: math-results
        path: "test-math-result.txt"

  test-greet:
    depends_on: [build]
    worker: CUSTOM
    instructions: |
      echo "PASS: greet('World') === 'Hello, World'" > test-greet-result.txt
    capabilities: [READ, RUN_TESTS]
    inputs:
      - from: build
        artifact: build-output
    on_failure: continue
    outputs:
      - name: greet-results
        path: "test-greet-result.txt"

  report:
    depends_on: [test-math, test-greet]
    worker: CUSTOM
    instructions: |
      echo "# Test Report" > report.md
      cat math-results/test-math-result.txt >> report.md
      cat greet-results/test-greet-result.txt >> report.md
    capabilities: [READ, EDIT]
    inputs:
      - from: test-math
        artifact: math-results
      - from: test-greet
        artifact: greet-results
    outputs:
      - name: final-report
        path: "report.md"
```

DAG:

```
build
  +-- test-math --+
  +-- test-greet -+-- report
```

Key points:

- `test-math` and `test-greet` run in parallel after `build`
- `report` waits for both tests
- `concurrency: 2` limits parallelism
- test steps use `on_failure: continue`, so the report can still be produced

### todo-loop.yaml - loop with completion_check

Loops until all items in a task list are completed.

```yaml
name: todo-loop
version: "1"
timeout: "5m"

steps:
  setup:
    worker: CUSTOM
    instructions: |
      cat > todo.txt << 'TASKS'
      - [ ] Create src directory
      - [ ] Write hello.ts
      - [ ] Write goodbye.ts
      TASKS
    capabilities: [EDIT]
    outputs:
      - name: todo-file
        path: "todo.txt"

  process-tasks:
    depends_on: [setup]
    worker: CUSTOM
    instructions: |
      # Find and process the first incomplete task
      TASK=$(grep -m1 '^\- \[ \]' todo.txt || true)
      # ... execute task and mark it complete
    capabilities: [READ, EDIT, RUN_COMMANDS]

    completion_check:
      worker: CUSTOM
      instructions: |
        REMAINING=$(grep -c '^\- \[ \]' todo.txt || true)
        if [ "$REMAINING" -eq 0 ]; then
          exit 0   # all complete
        else
          exit 1   # remaining tasks
        fi
      capabilities: [READ]
      timeout: "30s"

    max_iterations: 10
    on_iterations_exhausted: abort

  verify:
    depends_on: [process-tasks]
    worker: CUSTOM
    instructions: "Verify outputs"
    capabilities: [READ]
```

Execution flow:

```
setup -> process-tasks (iteration 1)
           |
           +-- Worker: process task 1
           +-- Check: 2 remaining -> incomplete

         process-tasks (iteration 2)
           |
           +-- Worker: process task 2
           +-- Check: 1 remaining -> incomplete

         process-tasks (iteration 3)
           |
           +-- Worker: process task 3
           +-- Check: 0 remaining -> complete

         verify
```

Key points:

- completion_check decides loop exit
- `max_iterations: 10` prevents infinite loops
- main worker and checker share the same workspace, so file changes carry over

### failure-recovery.yaml - failure handling

Demonstrates `retry`, `continue`, and `abort` policies.

```yaml
name: failure-recovery
version: "1"
timeout: "3m"
concurrency: 2

steps:
  flaky-step:
    description: "Flaky step (fails first run, succeeds on the second)"
    worker: CUSTOM
    instructions: |
      # simulate: fail once, succeed on the second attempt
      ...
    max_retries: 2
    on_failure: retry
    outputs:
      - name: flaky-output
        path: "flaky-result.txt"

  optional-lint:
    description: "Lint check (continue even if it fails)"
    worker: CUSTOM
    instructions: |
      echo "Lint failed"
      exit 1
    on_failure: continue
    outputs:
      - name: lint-report
        path: "lint-result.txt"

  summary:
    depends_on: [flaky-step, optional-lint]
    worker: CUSTOM
    instructions: |
      # aggregate both results
      ...
    inputs:
      - from: flaky-step
        artifact: flaky-output
      - from: optional-lint
        artifact: lint-report
```

Key points:

- `flaky-step` retries and continues after succeeding
- `optional-lint` continues even on failure
- `summary` depends on both; because `optional-lint` is `continue`, it still runs

---

## Step status list

During execution, steps transition across these statuses:

| Status | Meaning |
|-----------|------|
| `PENDING` | waiting on dependencies |
| `READY` | dependencies resolved; waiting to run |
| `RUNNING` | main worker running |
| `CHECKING` | completion_check worker running |
| `SUCCEEDED` | completed successfully |
| `FAILED` | failed (including retry exhaustion) |
| `INCOMPLETE` | hit `max_iterations` limit with `on_iterations_exhausted: continue` |
| `SKIPPED` | not executed due to upstream abort |
| `CANCELLED` | timeout or external cancellation |

Workflow-level statuses:

| Status | Meaning |
|-----------|------|
| `SUCCEEDED` | all steps completed |
| `FAILED` | aborted due to a step failure |
| `TIMED_OUT` | workflow-level timeout |
| `CANCELLED` | externally cancelled |

---

## DAG validation

Before execution, the following are validated. If invalid, execution is aborted with an error.

- **cycle detection**: `depends_on` has no cycle
- **reference integrity**: step ids in `depends_on` exist under `steps`
- **input integrity**: `inputs[].from` is listed in `depends_on`
- **output name uniqueness**: no duplicate `outputs[].name` within a step
- **worker kind validity**: `worker` is valid
- **completion_check consistency**: if present, `max_iterations` must be >= 2

---

## Next steps

- Design details: [`docs/workflow-design.md`](../workflow-design.md)
- Quickstart: [`docs/guide/quickstart.md`](./quickstart.md)
- Sample workflows: `examples/`
