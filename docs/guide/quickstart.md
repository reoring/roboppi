# Quickstart

This page is a practical "get it running" guide.

## Prerequisites

- Bun (for running from source)
- Optional worker CLIs, depending on workflows you want to run:
  - `opencode`
  - `claude`
  - `codex`
- Optional (PR creation): `gh`

## Install

```bash
git clone <repo-url> agentcore
cd agentcore
bun install
```

## Run tests

```bash
bun test
```

## Run a one-shot worker task

```bash
bun run src/cli.ts run --worker opencode --workspace /tmp/demo \
  --capabilities READ,EDIT --timeout 60000 "Write a README for this repo"
```

## Run a workflow

```bash
bun run src/workflow/run.ts examples/hello-world.yaml --workspace /tmp/workflow-demo --verbose
```

## Run the agent PR loop demo

```bash
bash examples/agent-pr-loop-demo/run-in-tmp.sh
```

## Run the daemon

```bash
bun run src/daemon/cli.ts examples/daemon/simple-cron.yaml --verbose
```
