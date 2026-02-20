#!/usr/bin/env bash
set -euo pipefail

LOOP_DIR=.roboppi-loop
LEGACY_DIR=.agentcore-loop

mkdir -p "${LOOP_DIR}"

if [ ! -f "${LOOP_DIR}/request.md" ] && [ -f "${LEGACY_DIR}/request.md" ]; then
  cp "${LEGACY_DIR}/request.md" "${LOOP_DIR}/request.md"
fi
if [ ! -f "${LOOP_DIR}/base-branch.txt" ] && [ -f "${LEGACY_DIR}/base-branch.txt" ]; then
  cp "${LEGACY_DIR}/base-branch.txt" "${LOOP_DIR}/base-branch.txt"
fi
if [ ! -f "${LOOP_DIR}/branch.txt" ] && [ -f "${LEGACY_DIR}/branch.txt" ]; then
  cp "${LEGACY_DIR}/branch.txt" "${LOOP_DIR}/branch.txt"
fi

if [ ! -f "${LOOP_DIR}/enable_pr" ] && [ -f "${LEGACY_DIR}/enable_pr" ]; then
  cp "${LEGACY_DIR}/enable_pr" "${LOOP_DIR}/enable_pr"
fi

if [ ! -f "${LOOP_DIR}/enable_pr" ]; then
  cat > "${LOOP_DIR}/pr.txt" <<EOF
PR creation is disabled.

To enable it:
  touch ${LOOP_DIR}/enable_pr
Then rerun the workflow.
EOF
  cat "${LOOP_DIR}/pr.txt"
  exit 0
fi

command -v gh > /dev/null 2>&1 || { echo "Error: gh not found in PATH" >&2; exit 1; }

BASE_BRANCH=$(
  cat "${LOOP_DIR}/base-branch.txt" 2>/dev/null \
    || echo "${BASE_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)}"
)
BRANCH=$(cat "${LOOP_DIR}/branch.txt")

git add -A
if ! git diff --cached --quiet; then
  TITLE=$(head -n 1 "${LOOP_DIR}/request.md" | sed -E 's/^#\s*//')
  [ -n "${TITLE}" ] || TITLE="agent loop changes"
  git commit -m "${TITLE}"
fi

if ! git remote get-url origin > /dev/null 2>&1; then
  echo "Error: git remote 'origin' not configured" >&2
  exit 1
fi

git push -u origin "${BRANCH}"

cat > "${LOOP_DIR}/pr-body.md" <<EOF
## What
Automated change set produced by agent workflow.

## How
- Design + TODO: OpenCode (GPT-5.2)
- Implementation: Claude Code (Opus 4.6)
- Review: OpenCode (GPT-5.2)
- Fixes: Claude Code (Opus 4.6)

## Notes
- See ${LOOP_DIR}/design.md
- See ${LOOP_DIR}/todo.md
- See ${LOOP_DIR}/review.md
EOF

TITLE=$(head -n 1 "${LOOP_DIR}/request.md" | sed -E 's/^#\s*//')
[ -n "${TITLE}" ] || TITLE="agent loop changes"

gh pr create \
  --base "${BASE_BRANCH}" \
  --head "${BRANCH}" \
  --title "${TITLE}" \
  --body-file "${LOOP_DIR}/pr-body.md" \
  | tee "${LOOP_DIR}/pr-url.txt"

echo "PR URL written to ${LOOP_DIR}/pr-url.txt"
