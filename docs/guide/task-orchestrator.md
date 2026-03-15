# Task Orchestrator Guide

Task Orchestrator is a thin control plane above Roboppi workflows. It polls external task systems, normalizes those tasks, routes them to workflows, and records task/run state under a local registry.

Current implementation focus:

- one-shot execution via `roboppi task-orchestrator run <config.yaml>`
- resident polling via `roboppi task-orchestrator serve <config.yaml>`
- operator inspection via `roboppi task-orchestrator status <config.yaml>`
- local activity emission via `roboppi task-orchestrator activity emit ...`
- local file-backed state under `state_dir`
- `file_inbox` and `github_issue` sources
- deterministic routing
- workflow dispatch with injected task context

## Contents

- [When to use it](#when-to-use-it)
- [Run once](#run-once)
- [Serve](#serve)
- [Inspect status](#inspect-status)
- [Emit Activity](#emit-activity)
- [Declarative Reporting](#declarative-reporting)
- [Configuration schema](#configuration-schema)
- [Sources](#sources)
- [Routing](#routing)
- [Injected task context](#injected-task-context)
- [State layout](#state-layout)
- [Machine-readable output](#machine-readable-output)
- [GitHub authentication](#github-authentication)
- [Operational usage](#operational-usage)
- [Examples](#examples)

---

## When to use it

Use Task Orchestrator when the unit of work is an external task rather than a manually selected workflow.

Examples:

- implement a GitHub issue
- process tasks dropped into a local inbox directory
- periodically scan an issue queue and route different labels to different workflows

It is not a replacement for workflow YAML. The orchestrator selects a workflow, injects task metadata, and records outcome.

---

## Run once

```bash
roboppi task-orchestrator run <config.yaml> [options]
# (dev)
bun run src/cli.ts -- task-orchestrator run <config.yaml> [options]
```

Useful options:

| Option | Description |
|------|------|
| `--supervised` | run workflows through Core IPC (default) |
| `--direct` | opt out of Core IPC and spawn worker CLIs directly |
| `--base-dir`, `-C` | base directory for config-relative paths |
| `--json` | emit a machine-readable JSON summary |
| `--verbose` | enable verbose logging |
| `--base-branch` | override branch base resolution |
| `--protected-branches` | override protected branch patterns |
| `--allow-protected-branch` | disable protected branch guard |

Typical v1 usage is to run this command from cron or a systemd timer.

## Serve

```bash
roboppi task-orchestrator serve <config.yaml> [options]
# (dev)
bun run src/cli.ts -- task-orchestrator serve <config.yaml> [options]
```

Useful options:

| Option | Description |
|------|------|
| `--supervised` | run workflows through Core IPC (default) |
| `--direct` | opt out of Core IPC and spawn worker CLIs directly |
| `--poll-every <dur>` | override `runtime.poll_every` |
| `--base-dir`, `-C` | base directory for config-relative paths |
| `--json` | emit newline-delimited JSON events |
| `--verbose` | enable verbose logging |

Behavior:

- polling is continuous until stopped
- task dispatch is detached, so the poll loop continues while workflows are still running
- active tasks are still deduplicated through the local registry
- `Ctrl+C` triggers graceful shutdown

## Inspect status

```bash
roboppi task-orchestrator status <config.yaml> [options]
```

Useful options:

| Option | Description |
|------|------|
| `--json` | emit machine-readable task status |
| `--task-id <id>` | show one task only |
| `--active` | show only tasks with an active run |
| `--limit <n>` | limit returned tasks; default `20` |
| `--base-dir`, `-C` | base directory for config-relative paths |

Human-readable output shows the persisted task lifecycle, source identity, latest run, and landing decision. `--json` additionally includes the latest summary and landing artifacts for automation.

## Emit Activity

Workflow steps can emit task activity into `context/_task/activity.jsonl` without talking to GitHub directly.

```bash
roboppi task-orchestrator activity emit \
  --context "$ROBOPPI_TASK_CONTEXT_DIR" \
  --kind progress \
  --message "Started implementation"
```

Useful options:

| Option | Description |
|------|------|
| `--context <dir>` | required task context directory |
| `--kind <kind>` | activity type |
| `--message <text>` | human-readable message |
| `--phase <name>` | optional phase label |
| `--member-id <id>` | optional agent/member identifier |
| `--metadata-json <obj>` | optional metadata object |

When `activity.github.enabled: true`, resident `serve` mode projects task activity into a GitHub issue status comment for `github_issue` tasks.

## Declarative Reporting

Agents should emit internal task activity, not call GitHub or Linear directly.
External projection belongs to Task Orchestrator.

You can declare that policy in `workflow.yaml`:

```yaml
agents:
  enabled: true
  team_name: "issue-team"
  members:
    lead:
      agent: issue_lead
      roles: [lead, publisher]
    reporter:
      agent: github_reporter
      roles: [publisher, github_reporter]

reporting:
  default_publisher: lead
  sinks:
    github:
      enabled: true
      publisher_member: reporter
      allowed_members: [reporter]
      allowed_roles: [publisher]
      events: [progress, ready_to_land]
      projection: status_comment
      aggregate: latest
```

Behavior:

- `agents.members.<id>.roles` describes reporting-related member roles
- `reporting.sinks.github.publisher_member` declares the external publishing owner
- `allowed_members` / `allowed_roles` decide which emitted events are eligible for GitHub projection
- the workflow still emits activity locally with `roboppi task-orchestrator activity emit`
- GitHub projection only happens in `serve` mode when `activity.github.enabled: true`

---

## Configuration schema

```yaml
name: engineering-backlog
version: "1"
state_dir: ./.roboppi-task
runtime:
  poll_every: 30s
  max_active_instances: 4
clarification:
  enabled: true
  max_round_trips: 2
  reminder_after: 24h
  block_after: 72h
activity:
  github:
    enabled: true

sources:
  github-main:
    type: github_issue
    repo: owner/repo
    labels: ["roboppi"]

  inbox:
    type: file_inbox
    path: ./inbox
    pattern: "**/*.json"

routes:
  bugfix:
    when:
      source: github_issue
      repository: owner/repo
      requested_action: implement
      labels_any: ["bug", "flaky"]
      labels_all: ["roboppi"]
    workflow: ./workflows/agent-pr-loop.yaml
    agents_files:
      - ./agents.yaml
    workspace_mode: worktree
    branch_name: "roboppi/task/{{task.slug}}"
    base_ref: origin/main
    env:
      CI: "true"
    priority_class: background
    management:
      enabled: true

  fallback:
    workflow: ./workflows/triage.yaml
    workspace_mode: shared

landing:
  mode: manual
```

### Top-level fields

| Field | Required | Description |
|------|------|------|
| `name` | yes | config identifier |
| `version` | yes | fixed to `"1"` |
| `state_dir` | no | task registry directory; default `./.roboppi-task` |
| `runtime.poll_every` | no | resident polling interval; default `30s` |
| `runtime.max_active_instances` | no | resident soft capacity guard |
| `clarification.enabled` | no | enable clarification waiting-state policy; default `true` |
| `clarification.max_round_trips` | no | maximum clarification loops before auto-block; default `2` |
| `clarification.reminder_after` | no | planned reminder threshold for waiting tasks |
| `clarification.block_after` | no | auto-block threshold for waiting tasks |
| `activity.github.enabled` | no | enable GitHub status comment projection in `serve`; default `false` |
| `sources` | yes | task sources; at least one |
| `routes` | yes | routing table; at least one |
| `landing.mode` | no | `manual` or `disabled`; default `manual` |

---

## Sources

### `file_inbox`

Poll JSON files from a local directory.

```yaml
sources:
  inbox:
    type: file_inbox
    path: ./inbox
    pattern: "**/*.json"
```

Task file shape:

```json
{
  "title": "Fix flaky test",
  "body": "Normalized task description.",
  "labels": ["bug", "ci-flake"],
  "priority": "high",
  "repository": {
    "id": "owner/repo",
    "default_branch": "main",
    "local_path": "../repo"
  },
  "requested_action": "implement",
  "requested_by": "octocat",
  "metadata": {
    "milestone": "v0.2"
  }
}
```

Notes:

- `repository.local_path` is resolved relative to the task file directory
- ack files are written under `inbox/.roboppi-acks/`
- `pattern` defaults to `*.json`

### `github_issue`

Poll GitHub Issues through `gh api`.

```yaml
sources:
  github-main:
    type: github_issue
    repo: owner/repo
    labels: ["roboppi"]
```

Notes:

- issues are fetched from `repos/<repo>/issues`
- items with a `pull_request` field are ignored
- issue details are fetched from `repos/<repo>/issues/<number>`
- source transport is `gh api`, not a built-in HTTP client
- ack posts a machine-readable issue comment to `repos/<repo>/issues/<number>/comments`
- when `activity.github.enabled: true` and `serve` is used, the latest task activity is projected into an updatable issue status comment

---

## Routing

Routes are evaluated in declaration order. First match wins.

Supported predicates:

- `when.source`
- `when.repository`
- `when.requested_action`
- `when.labels_any`
- `when.labels_all`

Workspace modes:

- `shared`
- `worktree`

Current implementation details:

- `worktree` mode is represented in the routing plan and branch env, but full worktree lifecycle management is still a follow-up area
- the effective workspace currently comes from `task.repository.local_path` when present, otherwise the orchestrator base directory

---

## Injected task context

The dispatcher writes task artifacts under:

- `context/_task/task.json`
- `context/_task/routing.json`
- `context/_task/run.json`
- `context/_task/source-event.json` when available

Workflows may also write `context/_task/landing.json` to request a task-level completion state after a successful run.

Example:

```json
{
  "version": "1",
  "lifecycle": "ready_to_land",
  "rationale": "PR created and awaiting maintainer merge"
}
```

Allowed lifecycle values:

- `waiting_for_input`
- `review_required`
- `blocked`
- `ready_to_land`
- `landed`
- `closed_without_landing`

Behavior:

- `landing.mode=manual`: the directive is honored
- `landing.mode=disabled`: the directive is recorded but ignored, and successful runs stay at the default lifecycle

It also injects environment variables:

- `ROBOPPI_TASK_ID`
- `ROBOPPI_TASK_SOURCE_KIND`
- `ROBOPPI_TASK_EXTERNAL_ID`
- `ROBOPPI_TASK_REQUESTED_ACTION`
- `ROBOPPI_TASK_ROUTE_ID`
- `ROBOPPI_TASK_RUN_ID`
- `ROBOPPI_TASK_CONTEXT_DIR`
- `ROBOPPI_TASK_REPOSITORY` when available
- `ROBOPPI_TASK_REQUESTED_BY` when available

---

## State layout

Task registry data is stored under `state_dir`.

```text
.roboppi-task/
  tasks/
    <task-id>/
      envelope.json
      state.json
      waiting-state.json
      runs/
        <run-id>.json
        <run-id>/
          plan.json
          summary.json
          workflow-result.json
  indexes/
    active.json
    by-source/
```

This state is intended to be inspectable and safe for cron-style repeated runs.

`waiting-state.json` is written when a task enters `waiting_for_input`. It tracks clarification round trips, the last source revision, and reminder/block due times so resident polling can resume or auto-block cleanly.

When `serve` is running with `activity.github.enabled: true`, a due reminder updates the existing clarification issue comment instead of creating a new comment thread.

---

## Machine-readable output

Use `--json` to emit a JSON summary:

```bash
roboppi task-orchestrator run ./task-orchestrator.yaml --json
```

The result includes:

- per-source counters
- ack success/failure counters
- stage-tagged error entries
- aggregate totals

This is useful for cron wrappers, log shippers, or monitoring hooks.

---

## GitHub authentication

`github_issue` uses `gh api`, so authentication is whatever `gh` already supports.

Recommended:

```bash
gh auth login
gh auth status
```

Or set a token that `gh` can consume:

```bash
export GH_TOKEN=...
# or
export GITHUB_TOKEN=...
```

Minimum practical scopes depend on your org policy, but read access to issues in the target repo is required. If you enable source ack, the credential also needs permission to create issue comments.

Operational advice:

- keep `gh auth status` green before enabling timers
- prefer a dedicated bot account or GitHub App token source for automation
- verify `gh api repos/<repo>/issues` manually before wiring the source into Roboppi

---

## Operational usage

For simple setups, a periodic one-shot run is usually enough. Use `serve` when you want a resident poll loop and background workflow dispatch in one process.

### cron

Example wrapper:

```bash
/path/to/repo/examples/task-orchestrator/cron/run-task-orchestrator.sh
```

Example crontab:

```cron
*/5 * * * * /path/to/repo/examples/task-orchestrator/cron/run-task-orchestrator.sh >> /var/log/roboppi-task-orchestrator.log 2>&1
```

### systemd timer

Example unit files:

- `examples/task-orchestrator/systemd/roboppi-task-orchestrator.service`
- `examples/task-orchestrator/systemd/roboppi-task-orchestrator.timer`

Install them under your user or system unit directory, adjust paths, then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now roboppi-task-orchestrator.timer
systemctl --user status roboppi-task-orchestrator.timer
```

---

## Examples

- `examples/task-orchestrator/file-inbox-demo/`
- `examples/task-orchestrator/github-issue-demo/`
- `examples/task-orchestrator/systemd/`
- `examples/task-orchestrator/cron/`
