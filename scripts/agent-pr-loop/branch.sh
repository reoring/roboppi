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
git fetch origin "${BRANCH}" > /dev/null 2>&1 || true
if git show-ref --verify --quiet "refs/remotes/origin/${BASE_BRANCH}"; then
  BASE_REF="origin/${BASE_BRANCH}"
elif git show-ref --verify --quiet "refs/heads/${BASE_BRANCH}"; then
  BASE_REF="${BASE_BRANCH}"
else
  BASE_REF="HEAD"
fi

if git show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  git checkout "${BRANCH}"
  ACTION="reuse-local"
elif git show-ref --verify --quiet "refs/remotes/origin/${BRANCH}"; then
  git checkout -b "${BRANCH}" --track "origin/${BRANCH}"
  ACTION="track-remote"
else
  git checkout -b "${BRANCH}" "${BASE_REF}"
  ACTION="create-from-base"
fi

echo "BRANCH=${BRANCH} BASE_REF=${BASE_REF} ACTION=${ACTION}"
