#!/usr/bin/env bash
set -euo pipefail

# Bootstrap for the Roboppi self-dev loop targeting:
#   docs/features/swarm.md

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Error: workspace must be a git repository" >&2
  exit 1
fi

LOOP_DIR=.roboppi-loop
mkdir -p "${LOOP_DIR}" "${LOOP_DIR}/tmp"

# Clear derived artifacts from prior runs (keep request + branch/base settings).
rm -f \
  "${LOOP_DIR}/review.md" \
  "${LOOP_DIR}/review.verdict" \
  "${LOOP_DIR}/fix.md" \
  "${LOOP_DIR}/review.base_ref" \
  "${LOOP_DIR}/review.diff" \
  "${LOOP_DIR}/review.status" \
  "${LOOP_DIR}/review.untracked" \
  "${LOOP_DIR}/review.untracked.diff"

if [ ! -f "${LOOP_DIR}/request.md" ]; then
  cat > "${LOOP_DIR}/request.md" <<'EOF'
# Request: Implement Swarm (Agent Teams) for Roboppi

Implement the Swarm feature described in `docs/features/swarm.md`.

Swarm is a local, file-backed agent team system:

- multiple agent sessions (workers) can coordinate
- inter-agent messaging happens via a robust mailbox
- work is coordinated via a shared task list with race-free claiming

This is inspired by Claude Code agent teams:
- https://code.claude.com/docs/en/agent-teams

## Scope (v1 / MVP)

1) Swarm file store (maildir-like)
- Create a file-backed mailbox + task store under `<context_dir>/_swarm/` as
  specified in `docs/features/swarm.md`.
- Use atomic operations (`tmp` + `rename`) to avoid corruption under concurrency.

2) CLI tools (model-facing)
- Add a `roboppi swarm` CLI group with JSON outputs:
  - `swarm init`
  - `swarm members list`
  - `swarm message send|broadcast|recv|ack`
  - `swarm tasks add|list|claim|complete`
  - `swarm housekeep` (requeue stale processing messages)
- All commands MUST print machine-readable JSON to stdout on success.
- Errors should be actionable and MUST NOT print non-JSON to stdout.

3) Capability gating for Claude Code
- Add a new `WorkerCapability` (name: `MAILBOX`) and map it so Claude Code gets
  a restricted tool:
  - allow `Bash(roboppi swarm:*)` (or equivalent narrow allowlist)
  - do NOT grant full `Bash` just for mailbox access
- Update documentation and tests accordingly.

4) Tests
- Add unit tests covering:
  - message send -> inbox/new
  - recv claim -> processing
  - ack -> cur
  - broadcast -> N recipients
  - task add/claim/complete transitions
  - housekeeping (stale processing requeue)
- `make test-all` must pass.

## Constraints

- Keep changes focused; avoid repo-wide refactors.
- Prefer ASCII in new files.
- Validate all paths stay within `<context_dir>/_swarm/` (no traversal).
- Bound message/task sizes (e.g. 64KB message body; 256KB task file).

## Acceptance Criteria

- [ ] `docs/features/swarm.md` remains accurate (update if implementation diverges)
- [ ] `roboppi swarm init` creates the expected directory layout + config files
- [ ] `roboppi swarm message send/recv/ack` works end-to-end (file semantics)
- [ ] broadcast delivers to all members
- [ ] `roboppi swarm tasks add/claim/complete` works and is race-safe
- [ ] housekeeping requeues stale `processing/` messages
- [ ] Claude Code capability `MAILBOX` enables only `roboppi swarm:*` bash usage
- [ ] `make test-all` passes
EOF
fi

REQ_BYTES=$(wc -c < "${LOOP_DIR}/request.md" | tr -d ' ')
if [ "${REQ_BYTES}" -lt 400 ]; then
  echo "Error: ${LOOP_DIR}/request.md is too small. Please fill it in first." >&2
  exit 1
fi

if [ -n "${BASE_BRANCH:-}" ]; then
  BASE_BRANCH="${BASE_BRANCH}"
else
  BASE_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
fi

if [ "${BASE_BRANCH}" = "HEAD" ]; then
  echo "Error: detached HEAD detected. Set BASE_BRANCH or checkout a branch." >&2
  exit 1
fi

echo "${BASE_BRANCH}" > "${LOOP_DIR}/base-branch.txt"
git rev-parse "${BASE_BRANCH}^{commit}" > "${LOOP_DIR}/base-sha.txt" 2>/dev/null || true

command -v opencode > /dev/null 2>&1 || { echo "Error: opencode not found in PATH" >&2; exit 1; }
command -v claude > /dev/null 2>&1 || { echo "Error: claude (Claude Code) not found in PATH" >&2; exit 1; }

echo "OK" > "${LOOP_DIR}/bootstrap.ok"
