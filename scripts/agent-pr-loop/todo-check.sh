#!/usr/bin/env bash
set -euo pipefail

LOOP_DIR=.roboppi-loop

TODO="${LOOP_DIR}/todo.md"
test -s "${TODO}" || { echo "CHECK: missing todo"; exit 1; }

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
