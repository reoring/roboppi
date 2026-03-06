# Agents Guide

Agents is Roboppi's agent-team coordination feature: a file-backed mailbox and a
shared task store under `<context_dir>/_agents/`.

Use it when you want a "lead + teammates" workflow where teammates can:

- send structured messages to each other
- coordinate work via a shared task list (race-free claim/complete)

Agents works best in supervised mode so the coordinator can shut down teammates
deterministically.

---

## Prerequisites

Agents is exposed via the `roboppi agents` CLI group.

Install/upgrade Roboppi so `roboppi agents` exists on `PATH`:

```bash
make install        # system install (default: /usr/local/bin)
# or
make install-user   # install to ~/.local/bin

roboppi agents --help
```

If you are running from source (dev), you can also invoke the CLI directly:

```bash
bun run src/cli.ts -- agents --help
```

Note: workers call `roboppi agents ...` via `PATH`. Ensure the intended `roboppi`
binary is available to the workflow runner (and thus to supervised workers/Core).

---

## Choosing `context_dir`

Agents state is stored under `<context_dir>/_agents/`.

- Default workflow context dir (when `context_dir` is omitted): `<workspace>/context`
- Recommended: set `context_dir` to an ignored path (per repo conventions), e.g.:

```yaml
context_dir: ".roboppi/context"
```

This keeps Agents artifacts isolated and avoids collisions when multiple workflows
run against the same workspace.

---

## 1) Enable Agents in a workflow (recommended)

Add a top-level `agents:` block to your workflow YAML.

When `agents.enabled: true`, the workflow runner:

- initializes `<context_dir>/_agents/` and writes `_agents/team.json` and
  `_agents/members.json`
- injects these env vars into *all* steps:
  - `ROBOPPI_AGENTS_CONTEXT_DIR`
  - `ROBOPPI_AGENTS_TEAM_ID`
  - `ROBOPPI_AGENTS_MEMBER_ID` (the lead member id)
  - `ROBOPPI_AGENTS_MEMBERS_FILE`
- spawns teammate worker processes for each *non-lead* member as hidden steps:
  - `_agent:<memberId>`

### Safety note: avoid concurrent edits

Agents coordinates communication and task ownership, but it does not prevent git
merge conflicts when multiple members edit the same files.

Recommended patterns:

- Keep teammates read-only (no `EDIT`) and have them report findings to the lead.
- If you need parallel edits, use separate worktrees per member (worktree
automation is not provided by Agents v1).

### Agent catalog (example)

Create `agents.yaml` next to your workflow YAML (or pass `--agents agents.yaml`).

```yaml
version: "1"
agents:
  lead:
    worker: CLAUDE_CODE
    model: claude-opus-4-6
    capabilities: [READ, EDIT, RUN_TESTS]

  scout:
    worker: CLAUDE_CODE
    model: claude-sonnet-4
    # Teammate: do not grant EDIT/RUN_COMMANDS by default.
    capabilities: [READ, MAILBOX, TASKS]
    base_instructions: |
      You are the Scout teammate.
      - Do not edit files.
      - Claim tasks, do research, then message the lead with file-path evidence.
      - Use roboppi agents tasks/message commands.
      - Never include secrets.
```

### Workflow YAML (example)

```yaml
name: demo-agents
version: "1"
timeout: "20m"
concurrency: 2

context_dir: ".roboppi/context"

agents:
  enabled: true
  team_name: "demo-team"
  members:
    lead:
      agent: lead
    scout:
      agent: scout
  tasks:
    - title: "Scan failures"
      description: "Find the first failing test and report evidence + file paths."
      assigned_to: scout

steps:
  main:
    agent: lead
    instructions: |
      You are the lead.
      You can receive teammate messages via:
        roboppi agents message recv --claim --max 20
    capabilities: [READ, EDIT, RUN_TESTS, MAILBOX, TASKS]
```

Run it (supervised + TUI recommended):

```bash
roboppi workflow workflow.yaml --workspace . --supervised --tui --verbose
```

Notes:

- If `agents.members` includes an explicit `lead:` key, that member is used as
  the lead. Otherwise, Roboppi picks the first member key as a deterministic
  fallback (and emits a warning).
- `agents.tasks[].assigned_to` must reference a member id from `agents.members`.

---

## 2) Agents CLI (`roboppi agents ...`)

The Agents CLI is designed as a tool surface:

- stdout: JSON only (exactly one JSON object)
- help: printed to stderr (stdout empty) with exit code 0
- failures: `{ "ok": false, "error": "..." }` on stdout with non-zero exit code

### Context and identity defaults

Most subcommands accept `--context <dir>`. You can default it via env:

```bash
export ROBOPPI_AGENTS_CONTEXT_DIR=/abs/path/to/context
```

Some flags default from env as well:

- `--from` / `--for` / `--member` defaults to `ROBOPPI_AGENTS_MEMBER_ID`

### Messages

Send:

```bash
roboppi agents message send \
  --context "$ROBOPPI_AGENTS_CONTEXT_DIR" \
  --from scout --to lead \
  --topic findings \
  --body "I found the first failing test in pkg/foo/bar_test.go"
```

Receive (non-blocking):

```bash
roboppi agents message recv --context "$ROBOPPI_AGENTS_CONTEXT_DIR" --for lead --max 10
```

Receive and claim (recommended):

```bash
roboppi agents message recv \
  --context "$ROBOPPI_AGENTS_CONTEXT_DIR" \
  --for lead \
  --claim \
  --max 10 \
  --wait-ms 30000
```

Ack claimed messages by claim token (preferred):

```bash
roboppi agents message ack \
  --context "$ROBOPPI_AGENTS_CONTEXT_DIR" \
  --for lead \
  --claim-token "<opaque-token>"
```

### Tasks

Add:

```bash
roboppi agents tasks add \
  --context "$ROBOPPI_AGENTS_CONTEXT_DIR" \
  --title "Investigate flake" \
  --description "Look for the first failing resource and capture evidence" \
  --assigned-to scout
```

List:

```bash
roboppi agents tasks list --context "$ROBOPPI_AGENTS_CONTEXT_DIR" --status pending
```

Claim (race-free):

```bash
roboppi agents tasks claim --context "$ROBOPPI_AGENTS_CONTEXT_DIR" --task-id "<uuid>" --member scout
```

Complete:

```bash
roboppi agents tasks complete \
  --context "$ROBOPPI_AGENTS_CONTEXT_DIR" \
  --task-id "<uuid>" \
  --member scout \
  --artifact "relative/path/inside/workspace"
```

Artifact paths must be relative and must not contain `..` segments.

### Housekeeping

Requeue stale processing messages and stale in-progress tasks:

```bash
roboppi agents housekeep --context "$ROBOPPI_AGENTS_CONTEXT_DIR"
```

---

## 3) Capability gating (Claude Code)

For Claude Code workers, `MAILBOX` and `TASKS` are mapped to a restricted command
surface:

- `Bash(roboppi agents:*)`

This lets a teammate communicate via Agents without granting full `RUN_COMMANDS`.

---

## Observability and artifacts

Agents state lives under `<context_dir>/_agents/`:

- team config: `_agents/team.json`, `_agents/members.json`
- mailbox: `_agents/mailbox/` (messages + mailbox event log)
- tasks: `_agents/tasks/` (task JSON files + task event log)
- agents-level events: `_agents/_events.jsonl` (metadata-only; survives cleanup)

In TUI mode, the Agents tab shows agents activity (metadata only; message bodies
and full task descriptions are not rendered in the TUI event stream).

Workflow shutdown applies the cleanup policy from `team.json`.
Default policy retains tasks but removes mailbox artifacts.

---

## Troubleshooting

- `roboppi agents` is missing / "unknown command": reinstall Roboppi (`make install` or `make install-user`) and re-check with `roboppi agents --help`.
- Workers cannot find the right `roboppi`: ensure the intended `roboppi` binary is on `PATH` for the workflow runner (and thus supervised workers/Core).
- `message ack` fails: prefer ack by claim token returned from `message recv --claim`; claim tokens can expire.

---

## References

- Design: `docs/features/agents.md`
- Conformance and CLI contracts: `docs/spec/agents.md`
