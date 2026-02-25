# Quickstart — Running Roboppi Workflows as a Team

This guide explains how to introduce Roboppi workflows into a team project and run an automated pipeline for AI-driven design, implementation, and validation.

We use `examples/appthrust-dashboard/workflow.yaml` (a production workflow for the AppThrust Dashboard project) as a running example.

English | [日本語](quickstart.ja.md)

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Installing Roboppi](#2-installing-roboppi)
3. [Workflow Overview](#3-workflow-overview)
4. [Integrating a Workflow into Your Project](#4-integrating-a-workflow-into-your-project)
5. [Writing request.md](#5-writing-requestmd)
6. [Running the Workflow](#6-running-the-workflow)
7. [Step-by-Step Walkthrough](#7-step-by-step-walkthrough)
8. [Artifacts and Directory Layout](#8-artifacts-and-directory-layout)
9. [Branch Safety](#9-branch-safety)
10. [Team Best Practices](#10-team-best-practices)
11. [Troubleshooting](#11-troubleshooting)
12. [Next Steps](#12-next-steps)

---

## 1. Prerequisites

### Required

| Tool | Purpose | Install |
|------|---------|---------|
| [Bun](https://bun.sh/) v1.0+ | Runtime / package manager | `curl -fsSL https://bun.sh/install \| bash` |
| [Git](https://git-scm.com/) | Branch management, diff generation | OS package manager |

### Worker CLIs (used by the workflow)

| Tool | Role in the Workflow | Install |
|------|---------------------|---------|
| [OpenCode](https://opencode.ai/) | Design (`design`) and TODO generation (`todo`) | `bun install -g opencode` |
| [Claude Code](https://claude.ai/code) | Implementation (`implement`) | `npm install -g @anthropic-ai/claude-code` |

Which tools you need depends on the `worker:` field of each step. `CUSTOM` steps run shell scripts directly and require no extra installation.

### Optional

| Tool | Purpose |
|------|---------|
| `gh` (GitHub CLI) | If you add a PR-creation step |
| `codex` (Codex CLI) | If you use Codex CLI as a worker |

---

## 2. Installing Roboppi

### Prebuilt binary (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/reoring/roboppi/main/install.sh | bash
roboppi --help
```

### Build from source

```bash
git clone https://github.com/reoring/roboppi.git
cd roboppi
bun install
make build
./roboppi --help
```

During development you can also run directly with `bun run src/workflow/run.ts` (no build step needed).

---

## 3. Workflow Overview

The AppThrust Dashboard workflow (`examples/appthrust-dashboard/workflow.yaml`) automates the following pipeline:

```
bootstrap ─→ branch ─→ deps ─→ design ─→ todo ─→ implement ─→ validate
   │            │         │        │         │         │            │
   │  Validate  │ Create/ │ bun    │ Create  │ Create │ Implement  │ lint/
   │  env &     │ reuse   │install │ design  │ TODO   │ + generate │ format/
   │  init      │ branch  │        │ doc(AI) │ (AI)   │ review     │ build
   │            │         │        │         │        │ inputs     │
   └────────────┴─────────┴────────┴─────────┴────────┴────────────┴────────
```

### Step roles

| Step | Worker | Description |
|------|--------|-------------|
| `bootstrap` | CUSTOM | Validate the git repo, check `roboppi/request.md` exists, clear previous artifacts |
| `branch` | CUSTOM | Create or restore a work branch (persisted in `roboppi/branch.txt`) |
| `deps` | CUSTOM | `bun install` to install dependencies |
| `design` | OPENCODE (GPT-5.2) | Read `request.md` and generate a design doc at `roboppi/design.md` |
| `todo` | OPENCODE (GPT-5.2) | Convert the design into an implementation checklist at `roboppi/todo.md` (with completion_check) |
| `implement` | CLAUDE_CODE (Opus 4.6) | Implement the TODO list, pass lint/format/build, generate review diff files |
| `validate` | CUSTOM | Final `bun run lint` / `bun run format:check` / `bun run build` |

### Why different workers?

This workflow intentionally splits **design/planning with OpenCode (GPT-5.2)** and **implementation with Claude Code (Opus 4.6)**:

- **OpenCode** — Best for read-only steps. Produces design docs and TODOs without editing code.
- **Claude Code** — Strong implementation capabilities. Handles code editing, command execution, and test fixing end-to-end.
- **CUSTOM** — Shell scripts for deterministic operations (branch switching, lint, build).

---

## 4. Integrating a Workflow into Your Project

### Directory layout

Create the following structure in your project repository:

```
your-project/
├── roboppi/
│   ├── request.md          # Implementation request (written by a team member)
│   ├── workflow.yaml        # Workflow definition (copy or symlink)
│   ├── base-branch.txt      # Base branch name (auto-generated)
│   ├── branch.txt           # Work branch name (auto-generated)
│   └── context/             # Inter-step artifacts (auto-generated)
├── .gitignore
└── ... (existing source code)
```

### Setup steps

```bash
cd /path/to/your-project

# 1. Create the roboppi directory
mkdir -p roboppi

# 2. Copy the workflow (or create a symlink)
cp /path/to/roboppi/examples/appthrust-dashboard/workflow.yaml roboppi/workflow.yaml

# 3. Add generated artifacts to .gitignore
cat >> .gitignore << 'EOF'

# Roboppi workflow artifacts
roboppi/design.md
roboppi/todo.md
roboppi/fix.md
roboppi/review.*
roboppi/validate.ok
roboppi/bootstrap.ok
roboppi/context/
EOF
```

We recommend committing `roboppi/request.md` and `roboppi/workflow.yaml` so the entire team shares the same workflow and request.

---

## 5. Writing request.md

`roboppi/request.md` is the input for the entire workflow. AI agents read this file to drive their design and implementation.

### Template

```markdown
# Feature Name (short and clear)

## Goal
What you want to achieve, in 1-3 sentences.

## Requirements
- Specific requirements as bullet points
- If there is a UI, describe appearance and interactions
- Data flow (API / local mock / integration with existing code)

## Out of scope
- Explicitly list what is NOT included

## Acceptance criteria
- [ ] Checklist format
- [ ] `bun test` passes
- [ ] `bun run lint` passes
- [ ] `bun run build` passes

## References
- Related docs, file paths, or external links
```

### Tips

- Must be **at least 200 bytes**; the bootstrap step rejects empty or tiny requests.
- Writing acceptance criteria as checklists (`- [ ]`) helps the design/todo steps reference them directly.
- The more concrete the file paths, API shapes, and expected behavior, the higher quality the agent output.

---

## 6. Running the Workflow

### Basic usage

```bash
# Set AGENTCORE_ROOT to where you cloned Roboppi
export AGENTCORE_ROOT="$HOME/roboppi"

# Run the workflow
bun run --cwd "$AGENTCORE_ROOT" src/workflow/run.ts \
  /path/to/your-project/roboppi/workflow.yaml \
  --workspace /path/to/your-project \
  --base-branch main \
  --supervised --verbose
```

TUI notes:

- TUI is enabled by default when stderr is a TTY (disable with `--no-tui`).
- In supervised + TUI mode, `2: Logs` shows real-time worker output (stdout/stderr/progress/patch). To disable stdout/stderr forwarding, set `ROBOPPI_TUI_STREAM_STDIO=0`.

### Arguments

| Argument | Description |
|----------|-------------|
| `--cwd "$AGENTCORE_ROOT"` | Run from the Roboppi source root (`bun run` resolves `src/workflow/run.ts` here) |
| 1st positional | Path to the workflow YAML |
| `--workspace` | Root directory of the target project |
| `--base-branch` | Base branch (default: current branch) |
| `--supervised` | Run in 3-layer mode: Supervisor -> Core -> Worker (default) |
| `--verbose` | Show output from each step |

### Using the prebuilt binary

```bash
roboppi workflow /path/to/your-project/roboppi/workflow.yaml \
  --workspace /path/to/your-project \
  --base-branch main \
  --verbose
```

### Convenient aliases

For frequent use, add a script to your project's `Makefile` or `package.json`:

```makefile
# Makefile
AGENTCORE_ROOT ?= $(HOME)/roboppi

roboppi:
	bun run --cwd "$(AGENTCORE_ROOT)" src/workflow/run.ts \
	  roboppi/workflow.yaml \
	  --workspace "$(PWD)" \
	  --base-branch main \
	  --supervised --verbose
```

```bash
make roboppi
```

---

## 7. Step-by-Step Walkthrough

### bootstrap — Environment validation

```yaml
bootstrap:
  worker: CUSTOM
  instructions: |
    set -euo pipefail
    # Check this is a git repo
    # Validate roboppi/request.md exists and has minimum size
    # Clear previous intermediate artifacts
    # Verify required commands (bun, opencode, claude) are in PATH
```

**Common failures:**
- `roboppi/request.md not found` → Create the file first
- `roboppi/request.md is too small` → Add more content (need 200+ bytes)
- `bun/opencode/claude not found in PATH` → Install the missing tool

### branch — Branch management

Handles three cases:

| Case | Behavior |
|------|----------|
| `roboppi/branch.txt` has a name + branch exists locally | Checkout that branch |
| `roboppi/branch.txt` has a name + branch exists only on remote | Track and checkout |
| No branch name (first run) | Create `roboppi/features-YYYYMMDD-HHMMSS` |

Committing `roboppi/branch.txt` lets team members share the same working branch.

### design — AI-generated design doc

OpenCode (GPT-5.2) reads `roboppi/request.md` and existing project docs, then generates `roboppi/design.md` containing:

- MVP scope declaration
- Route map
- UI components list
- Data fetching strategy
- Auth considerations
- Edge cases and risks
- Verification plan
- Acceptance criteria checklist

**`on_failure: retry` + `max_retries: 1`** — Retries once on failure.

### todo — Loop with completion_check

OpenCode generates a TODO checklist from the design doc. A `completion_check` validates quality:

```yaml
completion_check:
  worker: CUSTOM
  instructions: |
    # At least 10 checklist items?
    # Contains lint/format/build commands?
    # Contains file path hints?
```

**`max_iterations: 3`** — Up to 3 attempts. Aborts if the check never passes.

This mechanically prevents "too-thin TODOs" or "missing validation steps".

### implement — The core implementation step

Claude Code (Opus 4.6) implements the TODO list.

Key behaviors:
- If `roboppi/fix.md` exists, applies only those targeted fixes (for review loops)
- Must pass `bun run lint` / `bun run format:check` / `bun run build`
- Generates review input files at the end:
  - `roboppi/review.base_ref` — Base commit for diffs
  - `roboppi/review.diff` — Full diff from base
  - `roboppi/review.status` — `git status --porcelain`
  - `roboppi/review.untracked` — Untracked file list
  - `roboppi/review.untracked.diff` — Untracked file diffs (size-bounded)

### validate — Final checks

Runs `bun run lint` / `bun run format:check` / `bun run build` as a shell script. Writes `roboppi/validate.ok` on success.

---

## 8. Artifacts and Directory Layout

After a successful workflow run:

```
your-project/
├── roboppi/
│   ├── request.md              # Input (written by team)
│   ├── workflow.yaml            # Workflow definition
│   ├── base-branch.txt          # Base branch name
│   ├── branch.txt               # Work branch name
│   ├── bootstrap.ok             # Bootstrap success marker
│   ├── design.md                # AI-generated design doc
│   ├── todo.md                  # AI-generated TODO (with checked items)
│   ├── validate.ok              # Validate success marker
│   ├── review.base_ref          # Review input: base ref
│   ├── review.diff              # Review input: full diff
│   ├── review.status            # Review input: git status
│   ├── review.untracked         # Review input: untracked files
│   ├── review.untracked.diff    # Review input: untracked file diffs
│   └── context/                 # Inter-step context
│       ├── _workflow.json
│       ├── design/
│       │   └── _meta.json
│       ├── todo/
│       │   └── _meta.json
│       └── validate/
│           └── _meta.json
└── (implemented changes)
```

### How teams use these artifacts

- `roboppi/design.md` — Review design intent before looking at a PR
- `roboppi/todo.md` — Track progress (checked `[x]` vs unchecked `[ ]` items)
- `roboppi/review.diff` — Use as input for manual code review
- `roboppi/context/` — Step execution metadata (duration, retry count, etc.)

---

## 9. Branch Safety

This workflow sets `create_branch: true` and `branch_transition_step: "branch"`.

### What Roboppi guarantees

1. **Deterministic base branch resolution** — Records the base commit SHA at startup and uses a consistent reference across all steps.
2. **Branch Lock** — Before each step, verifies the worktree and branch match expectations. Fails fast if the branch drifted.
3. **Protected branch guard** — Blocks direct edits to `main`, `master`, and `release/*` by default.

### Safe execution pattern

```bash
# Start on main → the branch step creates a work branch → all subsequent steps run on it
roboppi workflow roboppi/workflow.yaml \
  --workspace . \
  --base-branch main \
  --verbose
```

### Resuming after a failure

If the workflow fails mid-run, `roboppi/branch.txt` retains the work branch name. Re-running restores the same branch:

```bash
# Re-run — the branch step checks out the existing branch
roboppi workflow roboppi/workflow.yaml \
  --workspace . \
  --base-branch main \
  --verbose
```

Details: [docs/guides/branch.md](./guides/branch.md)

---

## 10. Team Best Practices

### File management

| Practice | Rationale |
|----------|-----------|
| Commit `roboppi/workflow.yaml` to the repo | Everyone uses the same workflow |
| Commit `roboppi/request.md` alongside PRs | Records what was requested |
| Add `roboppi/design.md` / `roboppi/todo.md` to `.gitignore` | Regenerated on every run |
| `roboppi/branch.txt` — case by case | Commit if you want to share the branch; `.gitignore` for personal work |

### Team conventions for request.md

```
1. One request.md per feature (keep scope narrow)
2. Always include acceptance criteria as checklists
3. Specify the impact on existing code
4. Explicitly list out-of-scope items (prevents agent drift)
```

### Customizing the workflow

Adjust the workflow to match your project's needs:

**Adjusting timeouts:**

```yaml
timeout: "240m"         # Workflow-level
# Each step also has its own timeout
```

**Adding a review loop:**

Add a `completion_check` to the implement step for AI review -> fix iteration:

```yaml
  implement:
    # ...
    completion_check:
      worker: OPENCODE
      model: "openai/gpt-5.2"
      decision_file: "roboppi/review.verdict"
      instructions: |
        # Review instructions...
      capabilities: [READ, EDIT, RUN_COMMANDS]
      timeout: "15m"
    max_iterations: 5
    on_iterations_exhausted: abort
```

**Adding convergence control:**

Prevent non-terminating review loops:

```yaml
  implement:
    # ...
    convergence:
      enabled: true
      stall_threshold: 2       # Escalate after the same issue repeats 2 times
      max_stage: 3             # 3 stages max
      fail_on_max_stage: true  # Fail-fast at final stage
```

### CI/CD integration

Example GitHub Actions workflow:

```yaml
# .github/workflows/roboppi.yml
name: Roboppi Workflow
on:
  push:
    paths:
      - 'roboppi/request.md'

jobs:
  run-workflow:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install Roboppi
        run: |
          curl -fsSL https://raw.githubusercontent.com/reoring/roboppi/main/install.sh | bash

      - name: Run workflow
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: |
          roboppi workflow roboppi/workflow.yaml \
            --workspace . \
            --base-branch main \
            --verbose
```

### Parallel work by team members

When team members work on different features concurrently:

```bash
# Member A: auth feature
git checkout -b feat/auth
vim roboppi/request.md  # Write the auth request
roboppi workflow roboppi/workflow.yaml --workspace . --base-branch main --verbose

# Member B: dashboard feature
git checkout -b feat/dashboard
vim roboppi/request.md  # Write the dashboard request
roboppi workflow roboppi/workflow.yaml --workspace . --base-branch main --verbose
```

Each member works on a separate branch, so workflow artifacts never conflict.

---

## 11. Troubleshooting

### bootstrap fails

| Error | Cause | Fix |
|-------|-------|-----|
| `roboppi/request.md not found` | File does not exist | Create `roboppi/request.md` |
| `roboppi/request.md is too small` | Content under 200 bytes | Add more detail to the request |
| `bun not found in PATH` | Bun not installed | Install Bun |
| `opencode not found in PATH` | OpenCode not installed | `bun install -g opencode` |
| `claude not found in PATH` | Claude Code not installed | `npm install -g @anthropic-ai/claude-code` |

### todo step hits max_iterations

The `completion_check` validates:

- At least 10 checklist items (`- [ ]`) in `roboppi/todo.md`
- At least one of `bun run lint` / `bun run format:check` / `bun run build` mentioned
- At least one file path (`.ts`, `.tsx`, `.md`, etc.) included

If it fails after 3 iterations, your `request.md` may be too vague for the agent. Add more specific requirements.

### implement step fails

1. **lint/format/build errors** — The implement step tries to self-repair, but may not always succeed. Check the logs and either fix manually or write specific instructions in `roboppi/fix.md` and re-run.

2. **Timeout** — The default is `timeout: "120m"`. If exceeded, the task may be too large. Narrow the scope in `request.md`.

### Branch-related errors

| Error | Cause | Fix |
|-------|-------|-----|
| Branch Lock drift detected | Branch changed between steps | Manually checkout the expected branch |
| Protected branch guard | Attempting direct edits on main/master | Use `--base-branch` so a work branch is created |

### Debugging environment variables

```bash
# Enable IPC trace
ROBOPPI_IPC_TRACE=1 roboppi workflow ...

# Verbose logging
ROBOPPI_VERBOSE=1 roboppi workflow ... --verbose

# Extend IPC request timeout
ROBOPPI_IPC_REQUEST_TIMEOUT=5m roboppi workflow ...
```

---

## 12. Next Steps

### Documentation

- [docs/guide/workflow.md](./guide/workflow.md) — Full workflow YAML schema reference
- [docs/guide/daemon.md](./guide/daemon.md) — Daemon mode (event-driven execution)
- [docs/guide/architecture.md](./guide/architecture.md) — Internal architecture details
- [docs/guides/branch.md](./guides/branch.md) — Branch safety details
- [docs/guides/agents.md](./guides/agents.md) — Agent catalogs (reusable profiles)
- [docs/design.md](./design.md) — Core design document

### Advanced usage

- **Review loop** — Add a `completion_check` to the implement step for AI review -> fix iteration (see `examples/agent-pr-loop.yaml`)
- **Daemon mode** — Auto-trigger on `roboppi/request.md` changes (see `examples/daemon/agent-pr-loop.yaml`)
- **Agent catalogs** — Reuse worker settings across steps (see `docs/guides/agents.md`)
- **Auto PR creation** — Add a `create_pr` step after implement (see `examples/agent-pr-loop.yaml`)

### Creating a custom workflow

Use this workflow as a starting point and adapt it to your team's development flow:

```bash
# Example: copy and customize
cp examples/appthrust-dashboard/workflow.yaml my-team/workflow.yaml
# Add/edit steps as needed
```

See [docs/guide/workflow.md](./guide/workflow.md) for the full YAML schema.
