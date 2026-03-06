# agents-review-loop demo

Demonstrates the agents feature with a realistic implement-review loop:

- **Implementer** (Claude Code / Opus 4.6) builds a word-counter CLI from a spec.
- **Reviewer** (OpenCode / GPT-5.2) reviews the code, runs tests, and sends feedback.
- **Lead** (Claude Code / Sonnet 4) orchestrates the loop, relaying messages between agents.

The three agents run as long-lived agents members, communicating via the agents mailbox and coordinating through the shared task queue.

## Prerequisites

- `bun`
- `git`
- `opencode` (OpenCode CLI)
- `claude` (Claude Code CLI)

## Run

From the Roboppi repo root:

```bash
bash examples/agents-review-loop-demo/run-in-tmp.sh
```

This creates a fresh workspace under `/tmp/` and runs the full agents workflow.

### Use a fixed workspace path

```bash
TARGET=/tmp/roboppi-agents-wordcount \
  bash examples/agents-review-loop-demo/run-in-tmp.sh
```

## What it generates

In the generated workspace:

- `src/cli.ts` — CLI entry point
- `src/counter.ts` — Word counting library
- `test/counter.test.ts` — Unit tests
- `package.json` — Project config

## How it works

1. The workflow starts with agents enabled and 3 members (lead, implementer, reviewer).
2. Two seed tasks are pre-created: "Implement word-counter CLI" (assigned to implementer) and "Review implementation" (assigned to reviewer).
3. The implementer claims its task and builds the CLI from the spec in `.roboppi-loop/request.md`.
4. The reviewer claims its task, reads the code, runs tests, and sends feedback vian agents messages.
5. The lead monitors messages, relays feedback, and tracks task completion.
6. A completion check script verifies all deliverables: files exist, tests pass, CLI outputs valid JSON.
7. The loop repeats (up to 8 iterations) until all deliverables pass.

## Key agents concepts demonstrated

- **Agent catalog** (`agents.yaml`): Defines agent profiles with different workers, models, and capabilities.
- **Capability gating**: The reviewer has no `EDIT` capability — enforced read-only review.
- **Seed tasks**: Pre-created via `agents.tasks` in the workflow YAML.
- **Mailbox messaging**: Agents communicate via `roboppi agents send` / `roboppi agents inbox recv`.
- **Task coordination**: Agents claim, work on, and complete tasks via the shared task queue.
- **Completion check**: A CUSTOM shell script that validates end-to-end deliverables.

## Verify

After the demo completes:

```bash
cd <printed-workspace-path>
bun test
echo "hello world hello" > sample.txt && bun run src/cli.ts sample.txt
```
