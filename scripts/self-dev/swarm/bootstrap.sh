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
# Request: Swarm Gap Closure (Design + Conformance)

Implement/close remaining Swarm gaps so behavior aligns with both:

- `docs/features/swarm.md`
- `docs/spec/swarm.md`

Swarm is a local, file-backed agent team system:

- multiple agent sessions (workers) can coordinate
- inter-agent messaging happens via a robust mailbox
- work is coordinated via a shared task list with race-free claiming

This is inspired by Claude Code agent teams:
- https://code.claude.com/docs/en/agent-teams

## Scope (v1 / MVP + Conformance)

1) Swarm file store (maildir-like)
- Keep file-backed mailbox + task store under `<context_dir>/_swarm/`.
- Keep atomic operations (`tmp` + `rename`) for concurrency safety.

2) CLI tools (model-facing)
- Keep/extend `roboppi swarm` CLI group:
  - `swarm init`
  - `swarm members list`
  - `swarm message send|broadcast|recv|ack`
  - `swarm tasks add|list|claim|complete`
  - `swarm housekeep`
- Implement `swarm message recv --wait-ms`.
- Enforce JSON-safe output contract on all failures (including arg/usage errors).

3) Lifecycle and housekeeping closure
- Coordinator shutdown must include deterministic completion checks and cleanup
  policy application.
- Housekeeping must cover stale task recovery for `tasks/in_progress/` as
  defined by spec.

4) Capability/identity/safety closure
- Keep `MAILBOX` / `TASKS` capability support and gating.
- Keep metadata-only event policy.
- Ensure tool-facing path handling remains traversal-safe.

5) Tests and review quality gate
- Add/extend tests for all spec MUST items.
- `make test-all` should pass in normal local environments.
- Completion review MUST include a conformance audit against
  `docs/spec/swarm.md` section 3.1-3.6.

## Constraints

- Keep changes focused; avoid repo-wide refactors.
- Prefer ASCII in new files.
- Validate paths for swarm mutations stay within `<context_dir>/_swarm/`.
- Bound message/task sizes (e.g. 64KB message body; 256KB task file).

## Acceptance Criteria

- [ ] `docs/features/swarm.md` and `docs/spec/swarm.md` are both accurate
- [ ] `docs/spec/swarm.md` section 3.1 (`recv --wait-ms`) is implemented + tested
- [ ] `docs/spec/swarm.md` section 3.2 (shutdown/cleanup policy + final event) is implemented + tested
- [ ] `docs/spec/swarm.md` section 3.3 (stale `in_progress` task recovery) is implemented + tested
- [ ] `docs/spec/swarm.md` section 3.4 (JSON-safe CLI failure output) is implemented + tested
- [ ] `docs/spec/swarm.md` section 3.5 (path safety for tool-facing inputs) is implemented + tested
- [ ] `docs/spec/swarm.md` section 3.6 (supervised integration using `roboppi swarm`) is implemented + tested
- [ ] `make typecheck` passes
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
