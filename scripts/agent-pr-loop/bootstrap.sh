#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Error: workspace must be a git repository" >&2
  exit 1
fi

LOOP_DIR=.roboppi-loop
LEGACY_DIR=.agentcore-loop

mkdir -p "${LOOP_DIR}"

# Best-effort migration from legacy loop directory.
# If the legacy dir exists, copy user-provided inputs into the new dir so the
# updated workflow can run without manual moves.
if [ -d "${LEGACY_DIR}" ]; then
  for f in request.md base-branch.txt base-sha.txt branch.txt enable_pr; do
    if [ ! -f "${LOOP_DIR}/${f}" ] && [ -f "${LEGACY_DIR}/${f}" ]; then
      cp "${LEGACY_DIR}/${f}" "${LOOP_DIR}/${f}"
    fi
  done
fi

# Clear derived artifacts from prior runs (keep request + branch/base settings).
rm -f \
  "${LOOP_DIR}/review.md" \
  "${LOOP_DIR}/review.verdict" \
  "${LOOP_DIR}/fix.md" \
  "${LOOP_DIR}/review.base_ref" \
  "${LOOP_DIR}/review.diff" \
  "${LOOP_DIR}/review.status" \
  "${LOOP_DIR}/review.untracked" \
  "${LOOP_DIR}/review.untracked.diff" \
  "${LOOP_DIR}/pr-url.txt" \
  "${LOOP_DIR}/pr-body.md" \
  "${LOOP_DIR}/pr.txt"

if [ ! -f "${LOOP_DIR}/request.md" ]; then
  cat > "${LOOP_DIR}/request.md" <<'EOF'
# Request

(Write what you want to build/change here.)

## Context
- repo: (what is this repo?)
- constraints: (time, scope, compatibility)

## Acceptance Criteria
- [ ] ...
EOF
fi

REQ_BYTES=$(wc -c < "${LOOP_DIR}/request.md" | tr -d ' ')
if [ "${REQ_BYTES}" -lt 120 ]; then
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

if [ -d "${LEGACY_DIR}" ]; then
  echo "${BASE_BRANCH}" > "${LEGACY_DIR}/base-branch.txt"
fi
echo "${BASE_BRANCH}" > "${LOOP_DIR}/base-branch.txt"
git rev-parse "${BASE_BRANCH}^{commit}" > "${LOOP_DIR}/base-sha.txt" 2>/dev/null || true

command -v opencode > /dev/null 2>&1 || { echo "Error: opencode not found in PATH" >&2; exit 1; }
command -v claude > /dev/null 2>&1 || { echo "Error: claude (Claude Code) not found in PATH" >&2; exit 1; }

echo "OK" > "${LOOP_DIR}/bootstrap.ok"
