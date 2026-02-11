#!/usr/bin/env bash
set -euo pipefail

V=$(cat .agentcore-loop/review.verdict 2>/dev/null | tr -d '\r\n\t ')
if [ "${V}" = "PASS" ]; then
  echo "CHECK: PASS"
  exit 0
fi

echo "CHECK: still failing (${V:-missing})"
exit 1
