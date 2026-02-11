#!/usr/bin/env bash
set -euo pipefail

mkdir -p .agentcore-loop
BASE_BRANCH=$(cat .agentcore-loop/base-branch.txt 2>/dev/null || echo main)
BRANCH_FILE=.agentcore-loop/branch.txt

if [ -f "${BRANCH_FILE}" ] && [ -n "$(tr -d ' ' < "${BRANCH_FILE}")" ]; then
  BRANCH=$(cat "${BRANCH_FILE}")
else
  BRANCH="agentcore/loop-$(date +%Y%m%d-%H%M%S)"
  echo "${BRANCH}" > "${BRANCH_FILE}"
fi

git fetch origin "${BASE_BRANCH}" > /dev/null 2>&1 || true
if git show-ref --verify --quiet "refs/remotes/origin/${BASE_BRANCH}"; then
  BASE_REF="origin/${BASE_BRANCH}"
elif git show-ref --verify --quiet "refs/heads/${BASE_BRANCH}"; then
  BASE_REF="${BASE_BRANCH}"
else
  BASE_REF="HEAD"
fi

git checkout -B "${BRANCH}" "${BASE_REF}"

echo "BRANCH=${BRANCH} BASE_REF=${BASE_REF}"
