# Agent PR Loop Demo (Produces Real Code)

This demo proves that `examples/agent-pr-loop.yaml` can produce real, testable source code (not just loop artifacts) by generating a Bun + TypeScript mini project in a fresh scratch repo under `/tmp`.

Workflow:

`bootstrap -> branch -> design -> todo -> implement -> (review <-> fix)* -> create_pr` (PR creation is disabled by default)

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

Environment variables:

- `TARGET`: where the scratch repo is created/used
- `VERBOSE`: set to `0` to run without `--verbose`

## What it generates

In the generated workspace:

- `src/` (library + `src/cli.ts`)
- `test/` (unit tests)
- `package.json`, `tsconfig.json`, `bun.lock`
- `.agentcore-loop/` (request/design/todo/review/fix artifacts for the loop)

Tip: You can edit the request at `.agentcore-loop/request.md` in the generated repo and rerun the workflow to drive different outcomes.

## Verify

```bash
cd <printed-workspace-path>
bun test

bun run src/cli.ts solve --A '[[1,2],[3,4]]' --b '[5,6]'
bun run src/cli.ts eigen2x2 --A '[[2,1],[1,2]]'
bun run src/cli.ts project --basis '[[1,1,0],[0,1,1]]' --b '[3,1,2]'
```

Cleanup:

```bash
rm -rf <printed-workspace-path>
```

## PR creation

The final `create_pr` step is intentionally disabled unless you create the marker file:

```bash
touch .agentcore-loop/enable_pr
```

Then rerun the workflow. Note that PR creation requires a configured `origin` remote and `gh`.
