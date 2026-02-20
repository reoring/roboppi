#!/usr/bin/env bash
set -euo pipefail

LOOP_DIR=.roboppi-loop

mkdir -p "${LOOP_DIR}"

BASE_BRANCH_FILE="${LOOP_DIR}/base-branch.txt"

BASE_BRANCH=$(
  cat "${BASE_BRANCH_FILE}" 2>/dev/null \
    || echo "${BASE_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)}"
)

BRANCH_FILE="${LOOP_DIR}/branch.txt"

if [ -f "${BRANCH_FILE}" ] && [ -n "$(tr -d ' ' < "${BRANCH_FILE}")" ]; then
  BRANCH=$(cat "${BRANCH_FILE}")
else
  BRANCH="roboppi/loop-$(date +%Y%m%d-%H%M%S)"
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
