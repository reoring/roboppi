# Workflow YAML Design

This document defines the Workflow YAML schema used by the workflow runner.

For usage-oriented documentation, see `docs/guide/workflow.md`.

## Goals

- Define multi-step orchestration declaratively in YAML
- Express dependencies as a DAG (`depends_on`)
- Provide file-based context hand-off (`outputs` / `inputs`)
- Support retry/continue/abort behavior
- Support step looping via `completion_check`

## Top-level schema

```yaml
name: string
version: "1"
description?: string

timeout: DurationString
concurrency?: number
context_dir?: string

steps:
  <step_id>:
    <StepDefinition>
```

DurationString examples:

- `"200ms"`, `"30s"`, `"5m"`, `"2h"`, `"1h30m"`

## StepDefinition

```yaml
steps:
  <step_id>:
    description?: string

    worker: CODEX_CLI | CLAUDE_CODE | OPENCODE | CUSTOM
    model?: string
    workspace?: string
    instructions: string
    capabilities: [READ, EDIT, RUN_TESTS, RUN_COMMANDS]

    depends_on?: [<step_id>, ...]

    inputs?:
      - from: <step_id>
        artifact: <name>
        as?: <string>

    outputs?:
      - name: <string>
        path: <string>
        type?: <string>

    timeout?: DurationString
    max_retries?: number
    max_steps?: number
    max_command_time?: DurationString

    completion_check?:
      worker: CODEX_CLI | CLAUDE_CODE | OPENCODE | CUSTOM
      model?: string
      instructions: string
      capabilities: [READ, EDIT, RUN_TESTS, RUN_COMMANDS]
      timeout?: DurationString

    max_iterations?: number
    on_iterations_exhausted?: abort | continue
    on_failure?: retry | continue | abort
```

## Example: implement -> review -> fix

```yaml
name: implement-review-fix
version: "1"
description: "Implement, review, and fix"
timeout: "1h"
concurrency: 2

steps:
  implement:
    worker: CODEX_CLI
    instructions: |
      Implement the requested feature.
    capabilities: [READ, EDIT]
    outputs:
      - name: implementation
        path: "src/feature.ts"

  review:
    worker: CLAUDE_CODE
    depends_on: [implement]
    instructions: |
      Review the changes and write feedback.
    capabilities: [READ]
    inputs:
      - from: implement
        artifact: implementation
    outputs:
      - name: review
        path: "review.md"

  fix:
    worker: CODEX_CLI
    depends_on: [review]
    instructions: |
      Apply feedback from review.md.
    capabilities: [READ, EDIT, RUN_TESTS]
    inputs:
      - from: review
        artifact: review
```

## Example: completion_check loop

```yaml
name: implement-from-todo
version: "1"
timeout: "2h"

steps:
  implement-all:
    worker: CODEX_CLI
    instructions: |
      Read todo.md and implement one unchecked item.
      Mark it as done.
    capabilities: [READ, EDIT, RUN_TESTS]
    completion_check:
      worker: CUSTOM
      instructions: |
        test $(grep -c '^\- \[ \]' todo.md || true) -eq 0
      capabilities: [READ]
      timeout: "30s"
    max_iterations: 20
    on_iterations_exhausted: abort
```
