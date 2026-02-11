#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Error: workspace must be a git repository" >&2
  exit 1
fi

mkdir -p .agentcore-loop

if [ ! -f .agentcore-loop/request.md ]; then
  cat > .agentcore-loop/request.md <<'EOF'
# Request

(Write what you want to build/change here.)

## Context
- repo: (what is this repo?)
- constraints: (time, scope, compatibility)

## Acceptance Criteria
- [ ] ...
EOF
fi

REQ_BYTES=$(wc -c < .agentcore-loop/request.md | tr -d ' ')
if [ "${REQ_BYTES}" -lt 120 ]; then
  echo "Error: .agentcore-loop/request.md is too small. Please fill it in first." >&2
  exit 1
fi

BASE_BRANCH="${BASE_BRANCH:-main}"
echo "${BASE_BRANCH}" > .agentcore-loop/base-branch.txt

command -v opencode > /dev/null 2>&1 || { echo "Error: opencode not found in PATH" >&2; exit 1; }
command -v claude > /dev/null 2>&1 || { echo "Error: claude (Claude Code) not found in PATH" >&2; exit 1; }
command -v codex > /dev/null 2>&1 || { echo "Error: codex (Codex CLI) not found in PATH" >&2; exit 1; }

echo "OK" > .agentcore-loop/bootstrap.ok
