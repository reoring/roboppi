# AgentCore

AgentCore is an execution-control runtime for AI agents. It delegates heavy work (code edits, commands, tests) to external worker CLIs (OpenCode / Claude Code / Codex CLI), while AgentCore focuses on the safety mechanics:

- stop (timeouts, cancellation)
- limit (concurrency/RPS/budgets)
- observe (structured events and artifacts)
- isolate (separate processes for workers)

The goal is to prevent common event-loop automation failures: duplicate runs, infinite retries, cascading failures, and hangs.

## What You Get

- Hard stop guarantees via budgets (timeouts, max attempts, concurrency)
- End-to-end cancellation (Job -> Permit -> Worker) via AbortSignal/AbortController
- Failure containment via circuit breakers (LLM + workers)
- Better auditability: stdout/stderr/progress/patches as events

## Quickstart

Prerequisites:

- Bun
- Worker CLIs you plan to use: `opencode`, `claude`, `codex`
- Optional (PR creation): `gh`

Install:

```bash
bun install
```

## Example: Agent PR Loop

This is the default multi-worker loop:

`design -> todo -> implement -> (review <-> fix)* -> (optional) create_pr`

### 1) Run the demo (creates real code in /tmp)

```bash
bash examples/agent-pr-loop-demo/run-in-tmp.sh
```

This creates a scratch repo under `/tmp/` and runs `examples/agent-pr-loop.yaml` end-to-end.

### 2) Run against your own repo

```bash
AGENTCORE_ROOT=/path/to/agentcore
TARGET=/path/to/your/repo

mkdir -p "$TARGET/.agentcore-loop"
$EDITOR "$TARGET/.agentcore-loop/request.md"

AGENTCORE_ROOT="$AGENTCORE_ROOT" bun run --cwd "$AGENTCORE_ROOT" ./src/workflow/run.ts \
  "$AGENTCORE_ROOT/examples/agent-pr-loop.yaml" \
  --workspace "$TARGET" \
  --verbose
```

Notes:

- Workflow definition: `examples/agent-pr-loop.yaml`
- Helper scripts: `scripts/agent-pr-loop/`
- Loop state/artifacts live under `.agentcore-loop/` (typically gitignored in the target repo)

To enable PR creation (disabled by default), create the marker file in the target repo and rerun:

```bash
touch "$TARGET/.agentcore-loop/enable_pr"
```

## Daemon Mode (manual kick)

Start the daemon:

```bash
bun run src/daemon/cli.ts examples/daemon/agent-pr-loop.yaml --verbose
```

Kick it from another terminal:

```bash
mkdir -p .agentcore-loop
date +%s > .agentcore-loop/kick.txt
```

## One-shot Worker Task

Run a single worker task with a budget:

```bash
bun run src/cli.ts run --worker opencode --workspace /tmp/demo \
  --capabilities READ,EDIT --timeout 60000 "Write a README for this repo"
```

## Project Layout

- AgentCore CLI: `src/cli.ts` (IPC server + one-shot run)
- Workflow runner: `src/workflow/run.ts`
- Multi-worker step runner: `src/workflow/multi-worker-step-runner.ts`
- Design document: `docs/design.md` (currently Japanese)

## Status

This project is still evolving and APIs/behavior may change. See `docs/design.md` for the underlying design principles.

## Development

```bash
bun test
bun run typecheck
```
