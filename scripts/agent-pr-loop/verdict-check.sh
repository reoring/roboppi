#!/usr/bin/env bash
set -euo pipefail

V=$(cat .agentcore-loop/review.verdict 2>/dev/null | tr -d '\r\n\t ')

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
