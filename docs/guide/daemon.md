# Daemon Guide

Daemon is AgentCore's resident process. It monitors event sources and automatically runs workflows when conditions are met. It can react to cron schedules, file changes, webhooks, external commands, and more.

## Contents

- [Use cases](#use-cases)
- [Start with a minimal config](#start-with-a-minimal-config)
- [YAML schema](#yaml-schema)
- [Event sources](#event-sources)
  - [interval - fixed interval](#interval---fixed-interval)
  - [cron - cron schedule](#cron---cron-schedule)
  - [fswatch - filesystem changes](#fswatch---filesystem-changes)
  - [webhook - HTTP webhook](#webhook---http-webhook)
  - [command - external command](#command---external-command)
- [Triggers](#triggers)
  - [Basics](#basics)
  - [Filtering](#filtering)
  - [Rate control](#rate-control)
  - [Failure handling](#failure-handling)
- [Intelligent layer](#intelligent-layer)
  - [evaluate - execution gate](#evaluate---execution-gate)
  - [analyze - result analysis](#analyze---result-analysis)
  - [Template variables](#template-variables)
- [Context injection](#context-injection)
- [State management](#state-management)
- [CLI usage](#cli-usage)
- [Walkthrough examples](#walkthrough-examples)

---

## Use cases

- **Periodic monitoring**: run a system health check every 30 seconds
- **Auto tests**: detect source changes and run tests automatically
- **Intelligent review**: ask an LLM for a code review only when there are new commits
- **Webhook integration**: receive GitHub events and start a CI workflow
- **External API monitoring**: detect API status changes and run an alert workflow

---

## Start with a minimal config

The simplest daemon uses a single interval event and one workflow.

```yaml
# my-daemon.yaml
name: my-first-daemon
version: "1"

workspace: "/tmp/my-daemon"
state_dir: "/tmp/my-daemon/.daemon-state"

events:
  tick:
    type: interval
    every: "30s"

triggers:
  health:
    on: tick
    workflow: ./workflows/health-check.yaml
    on_workflow_failure: ignore
```

Start:

```bash
bun run src/daemon/cli.ts my-daemon.yaml --verbose
```

Output:

```
Daemon: my-first-daemon
Events: 1
Triggers: 1

[daemon] Event loop started, waiting for events...
[daemon] Event received: tick (interval)
[daemon] Workflow completed: SUCCEEDED
```

Stop safely with `Ctrl+C` (graceful shutdown).

---

## YAML schema

Daemon configuration is defined in a single YAML file.

```yaml
name: string                        # daemon name (identifier)
version: "1"                        # schema version (currently fixed to "1")
description?: string                # optional description

workspace: string                   # working directory (shared by all triggers)
log_dir?: string                    # log output directory (default: ./logs)
state_dir?: string                  # state directory (default: <workspace>/.daemon-state)
max_concurrent_workflows?: number   # max concurrent workflows (default: 5)

events:                             # event source definitions
  <event_id>:
    type: cron | interval | fswatch | webhook | command
    ...

triggers:                           # trigger definitions (event -> workflow)
  <trigger_id>:
    on: <event_id>
    workflow: <path>
    ...
```

### Top-level fields

| Field | Required | Description |
|-----------|------|------|
| `name` | yes | daemon identifier |
| `version` | yes | fixed to `"1"` |
| `description` | no | description |
| `workspace` | yes | working directory for workflow execution |
| `log_dir` | no | log output directory |
| `state_dir` | no | where execution state is persisted |
| `max_concurrent_workflows` | no | max workflows running concurrently (default: 5) |
| `events` | yes | event sources (at least one) |
| `triggers` | yes | triggers (at least one) |

---

## Event sources

Daemon supports five event source kinds. Define them under `events` and reference them from triggers via `on`.

### interval - fixed interval

The simplest event source: fires periodically at a fixed interval.

```yaml
events:
  tick:
    type: interval
    every: "30s"      # every 30 seconds
```

`every` is a DurationString. Supported forms:

| Form | Example | Meaning |
|------|----|----|
| `Nms` | `"200ms"` | 200 milliseconds |
| `Ns` | `"30s"` | 30 seconds |
| `Nm` | `"5m"` | 5 minutes |
| `Nh` | `"1h"` | 1 hour |

Payload:

```json
{
  "type": "interval",
  "firedAt": 1705312200000
}
```

### cron - cron schedule

Specify a schedule with a standard cron expression.

```yaml
events:
  every-5min:
    type: cron
    schedule: "*/5 * * * *"     # every 5 minutes

  daily-morning:
    type: cron
    schedule: "0 9 * * *"       # every day at 09:00

  weekday-night:
    type: cron
    schedule: "0 22 * * 1-5"    # weekdays at 22:00
```

Cron format:

```
* * * * *
| | | | |
| | | | +-- day of week (0-7; 0 and 7 are Sunday)
| | | +---- month (1-12)
| | +------ day of month (1-31)
| +-------- hour (0-23)
+---------- minute (0-59)
```

Payload:

```json
{
  "type": "cron",
  "schedule": "*/5 * * * *",
  "firedAt": 1705312200000
}
```

### fswatch - filesystem changes

Watch filesystem changes. Specify files via glob patterns and fire when changes occur.

```yaml
events:
  src-change:
    type: fswatch
    paths:                        # watched paths (glob patterns)
      - "src/**/*.ts"
      - "src/**/*.tsx"
    ignore:                       # ignored patterns (optional)
      - "**/*.test.ts"
      - "**/*.spec.ts"
      - "**/node_modules/**"
      - "**/dist/**"
    events: [create, modify]      # watched event kinds (optional)
```

| Field | Required | Description |
|-----------|------|------|
| `paths` | yes | array of glob patterns to watch |
| `ignore` | no | ignore patterns |
| `events` | no | subset of `create`, `modify`, `delete` (default: all) |

If a large number of changes happen in a short time, they are batched into one event using a 200ms window.

Payload:

```json
{
  "type": "fswatch",
  "changes": [
    { "path": "src/index.ts", "event": "modify" },
    { "path": "src/utils.ts", "event": "create" }
  ]
}
```

### webhook - HTTP webhook

Receive external events via an HTTP endpoint. All webhook sources share a single HTTP server within the daemon.

```yaml
events:
  github-push:
    type: webhook
    path: "/hooks/github"         # endpoint path
    port: 8080                    # listen port (optional; default: 8080)
    secret: "${GITHUB_WEBHOOK_SECRET}"  # optional HMAC-SHA256 secret
    method: "POST"                # optional; default: POST
```

| Field | Required | Description |
|-----------|------|------|
| `path` | yes | URL path (e.g. `/hooks/github`) |
| `port` | no | listen port (default: 8080) |
| `secret` | no | HMAC-SHA256 secret; env expansion supported via `${ENV_VAR}` |
| `method` | no | allowed HTTP method (default: `POST`) |

If `secret` is set, requests are validated using the `X-Hub-Signature-256` header. Invalid requests are rejected.

Payload:

```json
{
  "type": "webhook",
  "method": "POST",
  "path": "/hooks/github",
  "headers": { "content-type": "application/json", "x-github-event": "push" },
  "body": { "ref": "refs/heads/main", "commits": [] }
}
```

### command - external command

Periodically run an external command and emit events based on its result (or changes).

```yaml
events:
  api-status:
    type: command
    command: "curl -s -o /dev/null -w '%{http_code}' https://api.example.com/health"
    interval: "1m"                # execution interval
    trigger_on: change            # change | always
```

| Field | Required | Description |
|-----------|------|------|
| `command` | yes | shell command to run |
| `interval` | yes | interval (DurationString) |
| `trigger_on` | no | `change` (default) fires only when stdout changes; `always` fires every run |

With `trigger_on: change`, the first execution does not fire (no previous output to compare). From the second run, events fire when stdout differs.

Payload:

```json
{
  "type": "command",
  "stdout": "200",
  "exitCode": 0,
  "changed": true
}
```

---

## Triggers

Triggers connect events to workflows. You can configure filtering, rate control, and failure handling.

### Basics

```yaml
triggers:
  auto-test:
    on: src-change                   # referenced event id
    workflow: ./workflows/test.yaml  # workflow YAML path
    enabled: true                    # enable/disable (default: true)
```

| Field | Required | Description |
|-----------|------|------|
| `on` | yes | event id (key under `events`) |
| `workflow` | yes | workflow YAML path (relative to workspace) |
| `enabled` | no | set false to disable the trigger (default: true) |

### Filtering

Use `filter` to specify conditions on the event payload. The workflow runs only when all conditions match.

```yaml
triggers:
  pr-check:
    on: github-push
    workflow: ./workflows/ci.yaml
    filter:
      # exact match
      action: "opened"

      # dot notation for nested fields
      pull_request.base.ref: "main"

      # regex match
      ref:
        pattern: "^refs/heads/(main|develop)$"

      # list membership
      sender.login:
        in: ["user-a", "user-b", "bot-ci"]
```

Filter kinds:

| Kind | Example | Meaning |
|------|----|----|
| exact match | `action: "opened"` | value equals |
| regex | `ref: { pattern: "^refs/heads/main$" }` | matches regex |
| list | `login: { in: ["a", "b"] }` | is one of the list values |

Use dot notation (`pull_request.base.ref`, etc.) to access nested fields.

### Rate control

Control how frequently triggers execute.

```yaml
triggers:
  auto-test:
    on: src-change
    workflow: ./workflows/test.yaml
    debounce: "5s"       # ignore rapid bursts (wait 5s from last event)
    cooldown: "30s"      # do not rerun for 30s after completion
    max_queue: 5          # max pending queue size (default: 10)
```

| Field | Description |
|-----------|------|
| `debounce` | ignore new events until a duration has elapsed since the last event |
| `cooldown` | after a workflow completes, do not rerun until duration elapses |
| `max_queue` | pending queue upper bound; discard overflow from oldest |

`debounce` is useful to aggregate save bursts from file watchers. `cooldown` prevents immediate reruns after completion.

### Failure handling

Specify what to do when the workflow fails.

```yaml
triggers:
  ci-check:
    on: github-push
    workflow: ./workflows/ci.yaml
    on_workflow_failure: retry     # ignore | retry | pause_trigger
    max_retries: 2                # max retries (default: 3)
```

| Value | Meaning |
|----|------|
| `ignore` | ignore failures and wait for the next event |
| `retry` | rerun up to `max_retries` |
| `pause_trigger` | pause the trigger when consecutive failures reach `max_retries` |

---

## Intelligent layer

Daemon can incorporate intelligent decisions via LLM workers or shell scripts.

### evaluate - execution gate

An optional gate that decides "should we run this workflow?" before execution.

```yaml
triggers:
  code-review:
    on: periodic
    workflow: ./workflows/review.yaml

    evaluate:
      worker: CUSTOM              # CUSTOM | CLAUDE_CODE | CODEX_CLI | OPENCODE
      instructions: |
        cd {{workspace}} 2>/dev/null || exit 1
        CURRENT=$(git rev-parse HEAD 2>/dev/null || echo "none")
        LAST=$(cat ".daemon-state/.last-review-commit" 2>/dev/null || echo "")
        if [ "$CURRENT" = "$LAST" ]; then
          exit 1    # skip
        else
          mkdir -p .daemon-state
          echo "$CURRENT" > ".daemon-state/.last-review-commit"
          exit 0    # run
        fi
      capabilities: [READ, RUN_COMMANDS]
      timeout: "15s"
```

#### Decision behavior by worker kind

| worker | Decision rule |
|--------|---------|
| `CUSTOM` | run as a shell script: exit 0 = run, exit 1 = skip |
| `CLAUDE_CODE` | run Claude Code CLI: if output contains "run" => run; if it contains "skip" => skip |
| `CODEX_CLI` | same as CLAUDE_CODE |
| `OPENCODE` | same as CLAUDE_CODE |

For LLM workers, the daemon checks the last non-empty output line first. If neither "run" nor "skip" is present, it defaults to skip (safer).

#### evaluate fields

| Field | Required | Description |
|-----------|------|------|
| `worker` | yes | worker kind |
| `instructions` | yes | instructions (template vars supported) |
| `capabilities` | yes | required permissions |
| `timeout` | no | timeout (default: `"30s"`) |

### analyze - result analysis

Analyze workflow results after completion and generate reports/summaries.

```yaml
triggers:
  code-review:
    on: periodic
    workflow: ./workflows/review.yaml

    analyze:
      worker: CUSTOM
      instructions: |
        echo "=== Review Summary ===" > summary.md
        echo "Status: {{workflow_status}}" >> summary.md
        echo "Time: $(date)" >> summary.md
        cat summary.md
      capabilities: [READ, EDIT]
      timeout: "30s"
      outputs:
        - name: review-summary
          path: summary.md
```

| Field | Required | Description |
|-----------|------|------|
| `worker` | yes | worker kind |
| `instructions` | yes | analysis instructions (template vars supported) |
| `capabilities` | yes | required permissions |
| `timeout` | no | timeout (default: `"2m"`) |
| `outputs` | no | file outputs for analysis results |

`analyze` runs only when the workflow completes with `SUCCEEDED`. The worker can access the workflow `context/` directory and read per-step results.

### Template variables

You can use `{{var}}` placeholders in `evaluate` and `analyze` instructions.

| Variable | Description | Where |
|------|------|-------------|
| `{{event}}` | event payload (JSON string) | evaluate, analyze |
| `{{event.type}}` | event type | evaluate, analyze |
| `{{last_result}}` | previous workflow result (JSON string) | evaluate |
| `{{last_result.status}}` | previous status | evaluate |
| `{{timestamp}}` | current time (ISO 8601) | evaluate, analyze |
| `{{trigger_id}}` | trigger id | evaluate, analyze |
| `{{workspace}}` | workspace path | evaluate |
| `{{execution_count}}` | total execution count for this trigger | evaluate, analyze |
| `{{workflow_status}}` | workflow status | analyze |
| `{{steps}}` | step results (JSON) | analyze |
| `{{context_dir}}` | context directory path | analyze |

Dot notation works for nested fields:

```yaml
instructions: |
  Event type: {{event.type}}
  Previous status: {{last_result.status}}
```

Template resolution order:

1. exact key match (e.g. `vars["event.type"]`)
2. dot-path lookup by parsing JSON in `vars["event"]` and accessing `.type`
3. unresolved placeholders are left as-is (`{{unknown_var}}`)

---

## Context injection

Use the trigger's `context` section to pass extra information to workflows.

```yaml
triggers:
  review:
    on: periodic
    workflow: ./workflows/review.yaml
    context:
      env:
        REVIEW_MODE: "strict"
        TARGET_BRANCH: "main"
      last_result: true
      event_payload: true
```

### env - environment variables

When the workflow runs, these environment variables are set on `process.env`, then restored after completion.

### last_result - previous result

If true, the previous workflow result is written to `.daemon-context/last-result.json`. Workflow steps can read this file.

```json
{
  "workflowId": "review-1705312200000",
  "name": "code-review",
  "status": "SUCCEEDED",
  "steps": {},
  "startedAt": 1705312200000,
  "completedAt": 1705312260000
}
```

### event_payload - event payload

If true, the payload of the triggering event is written to `.daemon-context/event.json`.

```json
{
  "type": "cron",
  "schedule": "*/5 * * * *",
  "firedAt": 1705312200000
}
```

---

## State management

Daemon persists state as files under `state_dir` (default: `<workspace>/.daemon-state`).

### Directory layout

```
.daemon-state/
├── daemon.json                  # daemon metadata (PID, start time, status)
└── triggers/
    ├── auto-test/
    │   ├── state.json           # enabled, lastFiredAt, cooldownUntil, executionCount
    │   ├── last-result.json     # last workflow result
    │   └── history/
    │       ├── 1705312200000.json
    │       └── 1705312500000.json
    └── periodic-review/
        ├── state.json
        ├── last-result.json
        └── history/
            └── ...
```

### daemon.json

```json
{
  "pid": 12345,
  "startedAt": 1705312200000,
  "configName": "my-daemon",
  "status": "running"
}
```

### triggers/<id>/state.json

```json
{
  "enabled": true,
  "lastFiredAt": 1705312200000,
  "cooldownUntil": null,
  "executionCount": 42,
  "consecutiveFailures": 0
}
```

`consecutiveFailures` is used with `on_workflow_failure: pause_trigger`. When consecutive failures reach `max_retries`, `enabled` is flipped to `false`.

### triggers/<id>/history/

History is stored as `<completedAt>.json` files. Each includes event info, workflow result, and timestamps.

---

## CLI usage

### Start a daemon

```bash
bun run src/daemon/cli.ts <daemon.yaml> [options]
```

| Option | Description |
|-----------|------|
| `--workspace`, `-w` | override `workspace` via CLI |
| `--verbose`, `-v` | enable verbose logging |
| `--supervised` | run workflows via Core IPC (Supervisor -> Core -> Worker) |
| `--help`, `-h` | show help |

Notes:

- command event `cwd` and relative `fswatch.paths` resolution are based on `workspace`
- `workspace` / `state_dir` / `log_dir` / `triggers.*.workflow` support `${ENV_VAR}` expansion (startup error if missing)

Examples:

```bash
bun run src/daemon/cli.ts my-daemon.yaml
bun run src/daemon/cli.ts my-daemon.yaml --verbose
```

### Stop

On `Ctrl+C` (SIGINT) or SIGTERM, Daemon performs a graceful shutdown:

1. stop receiving new events
2. abort running workflows (best-effort)
3. stop all event sources
4. wait for running workflows to finish (30s timeout)
5. stop webhook server
6. (supervised mode) shut down Core
7. flush state and exit

---

## Walkthrough examples

Sample configs live under `examples/daemon/`.

### Example 1: simple periodic run (simple-cron.yaml)

A minimal setup that runs a health-check workflow every 30 seconds.

```yaml
name: simple-cron
version: "1"
description: "A simple daemon that runs health checks every 30 seconds"

workspace: "/tmp/agentcore-daemon-simple"
state_dir: "/tmp/agentcore-daemon-simple/.daemon-state"

events:
  tick:
    type: interval
    every: "30s"

triggers:
  health-check:
    on: tick
    workflow: ./workflows/health-check.yaml
    on_workflow_failure: ignore
```

Run:

```bash
bun run src/daemon/cli.ts examples/daemon/simple-cron.yaml --verbose
```

The health-check workflow (`workflows/health-check.yaml`) is a 1-step workflow that checks disk usage, memory, and load average.

### Example 2: smart reviewer with an LLM gate (smart-reviewer.yaml)

Fires every 5 minutes via cron. An evaluate gate checks whether there are new commits. Only if there are new commits does it run a review workflow, then generates a summary via analyze.

```yaml
name: smart-reviewer
version: "1"
workspace: "/tmp/agentcore-daemon-reviewer"
state_dir: "/tmp/agentcore-daemon-reviewer/.daemon-state"
max_concurrent_workflows: 1

events:
  periodic:
    type: cron
    schedule: "*/5 * * * *"

triggers:
  code-review:
    on: periodic
    workflow: ./workflows/code-review.yaml
    cooldown: "5m"

    evaluate:
      worker: CUSTOM
      instructions: |
        cd {{workspace}} 2>/dev/null || exit 1
        git rev-parse --git-dir > /dev/null 2>&1 || exit 1

        MARKER=".daemon-state/.last-review-commit"
        CURRENT=$(git rev-parse HEAD 2>/dev/null || echo "none")
        LAST=$(cat "$MARKER" 2>/dev/null || echo "")

        if [ "$CURRENT" = "$LAST" ]; then
          exit 1    # no new commits -> skip
        else
          mkdir -p .daemon-state
          echo "$CURRENT" > "$MARKER"
          exit 0    # new commits -> run
        fi
      capabilities: [READ, RUN_COMMANDS]
      timeout: "15s"

    context:
      last_result: true

    analyze:
      worker: CUSTOM
      instructions: |
        echo "=== Review Summary ===" > summary.md
        echo "Status: {{workflow_status}}" >> summary.md
        echo "Time: $(date)" >> summary.md
        cat summary.md
      capabilities: [READ, EDIT]
      timeout: "30s"
      outputs:
        - name: review-summary
          path: summary.md
```

Key points:

- `evaluate.worker: CUSTOM` uses a shell gate
- `{{workspace}}` template variable references the workspace
- `context.last_result: true` injects the previous result
- `analyze` auto-generates a summary of review results

### Example 3: file watcher (file-watcher.yaml)

Detect TypeScript file changes and run tests automatically.

```yaml
name: file-watcher
version: "1"
workspace: "/tmp/agentcore-daemon-watcher"
state_dir: "/tmp/agentcore-daemon-watcher/.daemon-state"

events:
  src-change:
    type: fswatch
    paths:
      - "src/**/*.ts"
      - "src/**/*.tsx"
    ignore:
      - "**/*.test.ts"
      - "**/*.spec.ts"
      - "**/node_modules/**"
      - "**/dist/**"
    events: [create, modify]

triggers:
  auto-test:
    on: src-change
    workflow: ./workflows/test-suite.yaml
    debounce: "5s"
    cooldown: "30s"
    on_workflow_failure: ignore
```

Key points:

- `debounce: "5s"` aggregates bursts of file-save events
- `cooldown: "30s"` prevents immediate reruns after completion
- test failures are ignored and the daemon waits for the next change

### Example 4: multiple events and triggers (multi-trigger.yaml)

Use interval, cron, and command event sources together and start different workflows conditionally.

```yaml
name: multi-trigger
version: "1"
workspace: "/tmp/agentcore-daemon-multi"
state_dir: "/tmp/agentcore-daemon-multi/.daemon-state"
max_concurrent_workflows: 2

events:
  heartbeat:
    type: interval
    every: "30s"

  hourly:
    type: cron
    schedule: "0 * * * *"

  api-status:
    type: command
    command: "curl -s -o /dev/null -w '%{http_code}' https://httpbin.org/status/200"
    interval: "1m"
    trigger_on: change

triggers:
  # heartbeat -> health check
  health:
    on: heartbeat
    workflow: ./workflows/health-check.yaml
    on_workflow_failure: ignore

  # hourly -> review with evaluate
  hourly-review:
    on: hourly
    workflow: ./workflows/code-review.yaml
    cooldown: "30m"
    evaluate:
      worker: CUSTOM
      instructions: |
        if git rev-parse --git-dir > /dev/null 2>&1; then
          RECENT=$(git log --since="1 hour ago" --oneline 2>/dev/null | wc -l)
          if [ "$RECENT" -gt 0 ]; then
            exit 0
          fi
        fi
        exit 1
      capabilities: [READ, RUN_COMMANDS]
      timeout: "10s"
    context:
      last_result: true
      event_payload: true

  # API change -> run tests
  api-change:
    on: api-status
    workflow: ./workflows/test-suite.yaml
    debounce: "30s"
    cooldown: "5m"
    max_retries: 1
    on_workflow_failure: retry
```

Key points:

- `max_concurrent_workflows: 2` limits concurrency to 2
- three event source kinds each drive different triggers
- `command.trigger_on: change` fires only when API response output changes
- each trigger can have different failure handling (`ignore` / `retry`)

---

## Next steps

- See [`docs/guide/workflow.md`](./workflow.md) for writing workflows
- See [`docs/daemon-design.md`](../daemon-design.md) for design details
- Sample configs live in `examples/daemon/`
