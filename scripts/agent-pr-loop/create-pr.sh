#!/usr/bin/env bash
set -euo pipefail

mkdir -p .agentcore-loop

if [ ! -f .agentcore-loop/enable_pr ]; then
  cat > .agentcore-loop/pr.txt <<'EOF'
PR creation is disabled.

To enable it:
  touch .agentcore-loop/enable_pr
Then rerun the workflow.
EOF
  cat .agentcore-loop/pr.txt
  exit 0
fi

command -v gh > /dev/null 2>&1 || { echo "Error: gh not found in PATH" >&2; exit 1; }

BASE_BRANCH=$(cat .agentcore-loop/base-branch.txt 2>/dev/null || echo main)
BRANCH=$(cat .agentcore-loop/branch.txt)

git add -A
if ! git diff --cached --quiet; then
  TITLE=$(head -n 1 .agentcore-loop/request.md | sed -E 's/^#\s*//')
  [ -n "${TITLE}" ] || TITLE="agent loop changes"
  git commit -m "${TITLE}"
fi

if ! git remote get-url origin > /dev/null 2>&1; then
  echo "Error: git remote 'origin' not configured" >&2
  exit 1
fi

git push -u origin "${BRANCH}"

cat > .agentcore-loop/pr-body.md <<'EOF'
## What
Automated change set produced by agent workflow.

## How
- Design + TODO: OpenCode (GPT-5.2)
- Implementation: Claude Code (Opus 4.6)
- Review: OpenCode (GPT-5.2)
- Fixes: Codex CLI (gpt-5.3-codex)

## Notes
- See .agentcore-loop/design.md
- See .agentcore-loop/todo.md
- See .agentcore-loop/review.md
EOF

TITLE=$(head -n 1 .agentcore-loop/request.md | sed -E 's/^#\s*//')
[ -n "${TITLE}" ] || TITLE="agent loop changes"

gh pr create \
  --base "${BASE_BRANCH}" \
  --head "${BRANCH}" \
  --title "${TITLE}" \
  --body-file .agentcore-loop/pr-body.md \
  | tee .agentcore-loop/pr-url.txt

echo "PR URL written to .agentcore-loop/pr-url.txt"
