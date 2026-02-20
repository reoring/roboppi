#!/usr/bin/env bash
set -euo pipefail

LOOP_DIR=.roboppi-loop

VERDICT_FILE="${LOOP_DIR}/review.verdict"

V=$(cat "${VERDICT_FILE}" 2>/dev/null | tr -d '\r\n\t ')

# Preferred: structured JSON verdict file.
if [[ "${V}" == *'"decision":"complete"'* ]]; then
  echo "CHECK: PASS (json)"
  exit 0
fi

echo "CHECK: still failing (${V:-missing})"
exit 1
