#!/usr/bin/env bash
set -euo pipefail

DEFAULT_LOOP_DIR=.roboppi-loop

# Allow workflows to override where loop artifacts live.
# Compatibility: prefer .agentcore-loop when present (older loop layout).
if [ -n "${ROBOPPI_TODO_PATH:-}" ]; then
  TODO="${ROBOPPI_TODO_PATH}"
elif [ -n "${ROBOPPI_LOOP_DIR:-}" ]; then
  TODO="${ROBOPPI_LOOP_DIR}/todo.md"
elif [ -s ".agentcore-loop/todo.md" ] && [ ! -s "${DEFAULT_LOOP_DIR}/todo.md" ]; then
  TODO=".agentcore-loop/todo.md"
else
  TODO="${DEFAULT_LOOP_DIR}/todo.md"
fi

test -s "${TODO}" || { echo "CHECK: missing todo: ${TODO}"; exit 1; }

COUNT=$(grep -c '^- \[ \] ' "${TODO}" || true)
if [ "${COUNT}" -lt 6 ]; then
  echo "CHECK: too few tasks: ${COUNT}"
  exit 1
fi

if ! grep -Eqi '(test|spec|bun test|npm test|pytest|go test)' "${TODO}"; then
  echo "CHECK: no testing instructions found"
  exit 1
fi

if ! grep -Eq '([A-Za-z0-9_./-]+\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|md|yml|yaml|json))' "${TODO}"; then
  echo "CHECK: no file-path hints found"
  exit 1
fi

echo "CHECK: todo looks complete"
