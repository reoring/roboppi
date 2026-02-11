# agent-pr-loop demo (real code output)

This example demonstrates that `examples/agent-pr-loop.yaml` can produce real, testable source code in a fresh scratch repo under `/tmp`.

It creates a Bun + TypeScript linear algebra CLI project and runs the full loop:

- bootstrap -> branch -> design -> todo -> implement -> (review<->fix)* -> create_pr (disabled by default)

## Prerequisites

- `bun`
- `git`
- `opencode` (OpenCode)
- `claude` (Claude Code)
- `codex` (Codex CLI)

The workflow's `bootstrap` step will also validate that the worker CLIs exist in `PATH`.

## Run

From the AgentCore repo root:

```bash
bash examples/agent-pr-loop-demo/run-in-tmp.sh
```

By default, this creates a unique workspace directory under `/tmp/` and prints the path.

### Use a fixed workspace path

```bash
TARGET=/tmp/agentcore-prloop-bun-linalg \
  bash examples/agent-pr-loop-demo/run-in-tmp.sh
```

## What it generates

In the generated workspace:

- `src/` (library + `src/cli.ts`)
- `test/` (unit tests)
- `package.json`, `tsconfig.json`, `bun.lock`
- `.agentcore-loop/` (design/todo/review artifacts for the loop)

## Verify

```bash
cd <printed-workspace-path>
bun test

bun run src/cli.ts solve --A '[[1,2],[3,4]]' --b '[5,6]'
bun run src/cli.ts eigen2x2 --A '[[2,1],[1,2]]'
bun run src/cli.ts project --basis '[[1,1,0],[0,1,1]]' --b '[3,1,2]'
```

## PR creation

The final `create_pr` step is intentionally disabled unless you create the marker file:

```bash
touch .agentcore-loop/enable_pr
```

Then rerun the workflow. Note that PR creation requires a configured `origin` remote and `gh`.
