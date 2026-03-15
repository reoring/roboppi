# Task Orchestrator Examples

These examples exercise `roboppi task-orchestrator run <config.yaml>` and the same configs can also be used with `serve`.

## Demos

- `examples/task-orchestrator/file-inbox-demo/`
  - Fully local end-to-end demo using the `file_inbox` source.
  - Copies a sample inbox + repo into `/tmp`, runs the task orchestrator once,
    and verifies that task context reached the workflow.

- `examples/task-orchestrator/github-issue-demo/`
  - Local end-to-end demo for the `github_issue` source.
  - Uses a fake `gh` executable so the source can be exercised without network
    access or a real GitHub token.
  - Demonstrates declarative reporting: a `reporter` agent emits internal task
    activity, and `reporting.sinks.github` projects only that activity into an
    updatable issue status comment.

- `examples/task-orchestrator/github-live-agent-team/`
  - Manual/live example for real GitHub issue and PR orchestration.
  - Uses actual agent teams (`lead`, `implementer`/`reviewer`, `reporter`) and
    real worker CLIs instead of `CUSTOM` shell members.
  - Intended for authenticated local runs, not CI.

## Run

```bash
bash examples/task-orchestrator/file-inbox-demo/run-in-tmp.sh
bash examples/task-orchestrator/github-issue-demo/run-with-fake-gh.sh
```

The file inbox demo runs `roboppi task-orchestrator run ...` in supervised mode.
The GitHub demo runs `roboppi task-orchestrator serve ...` so resident status
projection is exercised too.

For a resident poll loop:

```bash
roboppi task-orchestrator serve <config.yaml>
```

If the config enables `activity.github.enabled`, workflows can emit local task activity with:

```bash
roboppi task-orchestrator activity emit --context "$ROBOPPI_TASK_CONTEXT_DIR" --kind progress --message "Started work"
```

For automation examples, see:

- `examples/task-orchestrator/cron/run-task-orchestrator.sh`
- `examples/task-orchestrator/systemd/`

For machine-readable output in your own setup:

```bash
roboppi task-orchestrator run <config.yaml> --json
```
