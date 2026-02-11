# Daemon Guide

The AgentCore daemon is a long-running process that listens to event sources and triggers workflows when conditions are met.

Supported triggers include:

- interval (fixed frequency)
- cron (cron schedule)
- fswatch (filesystem changes)
- webhook (HTTP)
- command (poll external state)

## Table of Contents

1. Use cases
2. Minimal configuration
3. YAML schema
4. Event sources
5. Triggers
6. Evaluate and analyze
7. Template variables
8. CLI usage
9. Examples

---

## 1. Use Cases

- periodic health checks
- auto-test on file changes
- "smart" periodic tasks gated by an evaluate step
- webhook-driven workflow execution

---

## 2. Minimal Configuration

```yaml
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

Run:

```bash
bun run src/daemon/cli.ts my-daemon.yaml --verbose
```

Stop with Ctrl+C.

---

## 3. YAML Schema

Top-level fields:

| Field | Required | Notes |
|------:|:--------:|------|
| `name` | yes | daemon id |
| `version` | yes | must be `"1"` |
| `description` | no | human description |
| `workspace` | yes | base directory for triggers |
| `log_dir` | no | default `./logs` (relative paths are resolved against workspace) |
| `state_dir` | no | default `<workspace>/.daemon-state` (relative paths are resolved against workspace) |
| `max_concurrent_workflows` | no | default 5 |
| `events` | yes | map of event id -> event definition |
| `triggers` | yes | map of trigger id -> trigger definition |

Notes:

- Relative `fswatch.paths` are resolved against `workspace`.
- `command` event commands run with `cwd = workspace`.
- `workspace`, `state_dir`, `log_dir`, and `triggers.*.workflow` support `${ENV_VAR}` expansion; missing env vars cause a startup error.

DurationString formats:

- `"200ms"`, `"30s"`, `"5m"`, `"2h"`, `"1h30m"`

---

## 4. Event Sources

### interval

```yaml
events:
  tick:
    type: interval
    every: "30s"
```

### cron

```yaml
events:
  periodic:
    type: cron
    schedule: "*/5 * * * *"
```

### fswatch

```yaml
events:
  src-change:
    type: fswatch
    paths:
      - "src/**/*.ts"
    ignore:
      - "**/node_modules/**"
    events: [create, modify]
```

### webhook

```yaml
events:
  github:
    type: webhook
    path: "/hooks/github"
    port: 3000
    secret: "${GITHUB_WEBHOOK_SECRET}"
```

### command

```yaml
events:
  api-status:
    type: command
    command: "curl -s https://example.com/status"
    interval: "1m"
    trigger_on: change   # change or always
```

---

## 5. Triggers

Basic trigger:

```yaml
triggers:
  health:
    on: tick
    workflow: ./workflows/health-check.yaml
    on_workflow_failure: ignore
```

Optional controls:

- `debounce`: suppress bursts
- `cooldown`: minimum time between runs
- `max_queue`: queue cap
- `filter`: simple payload filtering

---

## 6. Evaluate and Analyze

Two optional "intelligent" hooks:

- `evaluate`: decide whether to run the workflow
- `analyze`: inspect workflow results and generate a report

Both can be executed by `CUSTOM` or LLM-backed workers.

---

## 7. Template Variables

Common variables:

- `{{workspace}}`
- `{{context_dir}}`
- `{{workflow_status}}`

---

## 8. CLI Usage

```bash
bun run src/daemon/cli.ts <daemon.yaml> [--workspace <dir>] [--verbose]
```

---

## 9. Examples

- `examples/daemon/simple-cron.yaml`
- `examples/daemon/file-watcher.yaml`
- `examples/daemon/smart-reviewer.yaml`
- `examples/daemon/multi-trigger.yaml`
