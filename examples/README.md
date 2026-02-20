# Examples

This directory contains runnable workflow/daemon configs for Roboppi.

## Prerequisites

- `bun`
- Optional worker CLIs (only needed for examples that use them): `opencode`, `claude`, `codex`

## Run a workflow

```bash
./roboppi workflow examples/hello-world.yaml --verbose
# (dev)
bun run src/workflow/run.ts examples/hello-world.yaml --verbose
```

Notes:

- By default the workflow runner uses supervised mode (Supervisor -> Core -> Worker).
- Use `--direct` to run without Core IPC (spawn workers directly).

## Run a daemon

```bash
./roboppi daemon examples/daemon/simple-cron.yaml --verbose
# (dev)
bun run src/daemon/cli.ts examples/daemon/simple-cron.yaml --verbose
```

Stop with `Ctrl+C` (graceful shutdown). For a short smoke test, you can use `timeout`:

```bash
timeout 10s ./roboppi daemon examples/daemon/simple-cron.yaml --verbose
```

## Workflow examples

- `examples/hello-world.yaml`: minimal single-step workflow
- `examples/build-test-report.yaml`: build -> test (parallel) -> report
- `examples/failure-recovery.yaml`: failure handling / retry patterns
- `examples/todo-loop.yaml`: simple iterative loop pattern
- `examples/agent-pr-loop.yaml`: larger multi-step agent loop (see demo under `examples/agent-pr-loop-demo/`)
- `examples/appthrust-dashboard/workflow.yaml`: production workflow for a team project (design -> todo -> implement -> validate)

## Daemon examples

- `examples/daemon/simple-cron.yaml`: interval event -> workflow
- `examples/daemon/smart-reviewer.yaml`: cron + `evaluate` gate + `analyze` summary
- `examples/daemon/multi-trigger.yaml`: interval + cron + command events
- `examples/daemon/file-watcher.yaml`: fswatch example (config reference; planned)

### Directory scan + report (every 1 minute)

Config:

- `examples/daemon/dir-scan-report.yaml`
- `examples/daemon/workflows/dir-scan-report.yaml`

Run:

```bash
ROBOPPI_ROOT="$PWD" \
SCAN_DIR="$ROBOPPI_ROOT/docs" \
REPORT_DIR=/tmp/roboppi-dir-scan-report \
./roboppi daemon examples/daemon/dir-scan-report.yaml --verbose
```

Outputs:

- `$REPORT_DIR/latest.md`: human-readable report
- `$REPORT_DIR/latest.json`: machine-readable summary
- `$REPORT_DIR/last-snapshot.json`: previous snapshot (used for diff)

Tuning env vars:

- `SCAN_MAX_ENTRIES` (default: `20000`)
- `SCAN_TOP_N` (default: `20`)
- `SCAN_IGNORE` (default: `.git,node_modules,.daemon-state`)
