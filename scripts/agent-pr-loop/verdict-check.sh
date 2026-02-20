#!/usr/bin/env bash
set -euo pipefail

LOOP_DIR=.roboppi-loop
LEGACY_DIR=.agentcore-loop

VERDICT_FILE="${LOOP_DIR}/review.verdict"
if [ ! -f "${VERDICT_FILE}" ] && [ -f "${LEGACY_DIR}/review.verdict" ]; then
  VERDICT_FILE="${LEGACY_DIR}/review.verdict"
fi

V=$(cat "${VERDICT_FILE}" 2>/dev/null | tr -d '\r\n\t ')

# Preferred: structured JSON verdict file.
if [[ "${V}" == *'"decision":"complete"'* ]]; then
  echo "CHECK: PASS (json)"
  exit 0
fi

# Legacy fallback: PASS/FAIL text.
if [ "${V}" = "PASS" ]; then
  echo "CHECK: PASS"
  exit 0
fi

echo "CHECK: still failing (${V:-missing})"
exit 1
