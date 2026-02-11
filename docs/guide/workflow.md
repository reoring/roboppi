# Workflow Guide

AgentCore workflows let you define multi-step automation in YAML and execute it deterministically.

You can model:

- A DAG of steps with explicit dependencies
- Context hand-off between steps via filesystem artifacts
- Retry/continue/abort behavior on failures
- Iteration loops with `completion_check` (run until PASS)

## Table of Contents

1. What is a workflow?
2. YAML schema (v1)
3. Steps
4. Dependencies (DAG)
5. Context: outputs/inputs
6. Completion checks (looping)
7. Failure handling
8. Worker kinds
9. Running a workflow
10. Examples

---

## 1. What Is a Workflow?

A workflow is a set of named steps that run in a defined order (serial and/or parallel). AgentCore resolves dependencies and orchestrates execution.

Typical use cases:

- implement -> review -> fix loops
- build -> test -> report pipelines
- iterating a TODO list until complete

---

## 2. YAML Schema (v1)

Top-level structure:

```yaml
name: my-workflow
version: "1"
description: "optional"
timeout: "30m"
concurrency: 2
context_dir: "./context"

steps:
  step-a:
    # ...
  step-b:
    # ...
```

Fields:

| Field | Type | Required | Notes |
|------:|------|:--------:|-------|
| `name` | string | yes | workflow identifier |
| `version` | "1" | yes | schema version |
| `description` | string | no | human description |
| `timeout` | DurationString | yes | overall timeout |
| `concurrency` | number | no | max number of concurrently running steps |
| `context_dir` | string | no | default `./context` |
| `steps` | map | yes | map of step id -> step definition |

DurationString formats:

- `"200ms"`, `"30s"`, `"5m"`, `"2h"`, `"1h30m"`

---

## 3. Steps

Each step lives under `steps` as `steps.<step_id>`.

Minimal example:

```yaml
steps:
  build:
    description: "Build"
    worker: CUSTOM
    instructions: |
      mkdir -p dist
      echo 'console.log("hello")' > dist/main.js
    capabilities: [EDIT]
    timeout: "5m"
```

Step fields:

| Field | Type | Required | Notes |
|------:|------|:--------:|-------|
| `description` | string | no | human description |
| `worker` | enum | yes | `CODEX_CLI`, `CLAUDE_CODE`, `OPENCODE`, `CUSTOM` |
| `model` | string | no | optional model id (adapter-specific) |
| `workspace` | string | no | default `"."` |
| `instructions` | string | yes | instructions passed to the worker |
| `capabilities` | enum[] | yes | allowed operations |
| `depends_on` | string[] | no | step dependency ids |
| `inputs` | InputRef[] | no | context inputs from prior steps |
| `outputs` | OutputDef[] | no | context outputs produced by this step |
| `timeout` | DurationString | no | step timeout |
| `max_retries` | number | no | default 0 |
| `max_steps` | number | no | worker step cap (LLM workers) |
| `max_command_time` | DurationString | no | max time per command (worker-specific) |
| `completion_check` | object | no | defines a completion check |
| `max_iterations` | number | no | loop limit for completion_check |
| `on_iterations_exhausted` | enum | no | `abort` or `continue` |
| `on_failure` | enum | no | `retry`, `continue`, or `abort` (default `abort`) |

Capabilities:

| Value | Meaning |
|------:|---------|
| `READ` | read files |
| `EDIT` | create/edit files |
| `RUN_TESTS` | run tests |
| `RUN_COMMANDS` | run arbitrary commands |

---

## 4. Dependencies (DAG)

Use `depends_on` to express ordering.

Serial chain:

```yaml
steps:
  build:
    worker: CUSTOM
    instructions: "build"
    capabilities: [EDIT]

  test:
    worker: CUSTOM
    depends_on: [build]
    instructions: "test"
    capabilities: [READ, RUN_TESTS]

  deploy:
    worker: CUSTOM
    depends_on: [test]
    instructions: "deploy"
    capabilities: [RUN_COMMANDS]
```

Parallel fan-out and join:

```yaml
steps:
  build:
    worker: CUSTOM
    instructions: "build"
    capabilities: [EDIT]

  test-unit:
    worker: CUSTOM
    depends_on: [build]
    instructions: "unit"
    capabilities: [READ, RUN_TESTS]

  test-e2e:
    worker: CUSTOM
    depends_on: [build]
    instructions: "e2e"
    capabilities: [READ, RUN_TESTS]

  report:
    worker: CUSTOM
    depends_on: [test-unit, test-e2e]
    instructions: "report"
    capabilities: [READ, EDIT]
```

---

## 5. Context: outputs and inputs

Use `outputs` to publish artifacts from a step into the workflow context, and `inputs` to bring them into downstream steps.

Output definition:

```yaml
outputs:
  - name: build-output
    path: "dist"
    type: code
```

Input reference:

```yaml
inputs:
  - from: build
    artifact: build-output
    as: dist
```

---

## 6. Completion Checks (Looping)

If a step can be repeated until some condition is satisfied, attach a `completion_check` and set `max_iterations >= 2`.

Completion check behavior:

- exit code `0` -> complete
- exit code `1` -> incomplete (repeat)
- any other exit -> failed

---

## 7. Failure Handling

- `on_failure: abort` (default): stop the workflow
- `on_failure: continue`: mark the step as failed but keep running dependents when possible
- `on_failure: retry`: rerun the step up to `max_retries`

---

## 8. Worker Kinds

- `CUSTOM`: run shell scripts via the ShellStepRunner
- `OPENCODE`: OpenCode CLI
- `CLAUDE_CODE`: Claude Code CLI
- `CODEX_CLI`: Codex CLI

`model` is optional and adapter-specific. If set, adapters add `--model` when supported.

---

## 9. Running a Workflow

From the repo root:

```bash
bun run src/workflow/run.ts examples/hello-world.yaml --workspace /tmp/workflow-demo --verbose
```

---

## 10. Examples

- `examples/hello-world.yaml`
- `examples/build-test-report.yaml`
- `examples/todo-loop.yaml`
- `examples/agent-pr-loop.yaml`
