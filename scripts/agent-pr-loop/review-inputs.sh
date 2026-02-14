#!/usr/bin/env bash
set -euo pipefail

# Generate deterministic review inputs for the agent PR loop.
#
# Outputs:
#   .agentcore-loop/review.base_ref       - resolved base ref used for diffs
#   .agentcore-loop/review.diff           - git diff against base ref (tracked changes)
#   .agentcore-loop/review.status         - git status --porcelain
#   .agentcore-loop/review.untracked      - list of untracked (non-ignored) files
#   .agentcore-loop/review.untracked.diff - diffs for untracked files (as /dev/null -> file)

mkdir -p .agentcore-loop

BASE_BRANCH=$(cat .agentcore-loop/base-branch.txt 2>/dev/null || echo main)

git fetch origin "${BASE_BRANCH}" >/dev/null 2>&1 || true
if git show-ref --verify --quiet "refs/remotes/origin/${BASE_BRANCH}"; then
  BASE_REF="origin/${BASE_BRANCH}"
elif git show-ref --verify --quiet "refs/heads/${BASE_BRANCH}"; then
  BASE_REF="${BASE_BRANCH}"
else
  BASE_REF="HEAD"
fi

echo "${BASE_REF}" > .agentcore-loop/review.base_ref

git diff --no-color "${BASE_REF}" > .agentcore-loop/review.diff || true
git status --porcelain=v1 > .agentcore-loop/review.status || true
git ls-files --others --exclude-standard > .agentcore-loop/review.untracked || true

# For large repos, keep untracked diffs bounded.
MAX_FILES=${AGENTCORE_REVIEW_UNTRACKED_MAX_FILES:-200}
MAX_FILE_BYTES=${AGENTCORE_REVIEW_UNTRACKED_MAX_FILE_BYTES:-200000}
MAX_TOTAL_BYTES=${AGENTCORE_REVIEW_UNTRACKED_MAX_TOTAL_BYTES:-2000000}

out=.agentcore-loop/review.untracked.diff
: > "${out}"

count=0
total=0

while IFS= read -r f; do
  [ -n "${f}" ] || continue
  # Only include regular files. (git ls-files --others should already be files)
  if [ ! -f "${f}" ]; then
    continue
  fi

  count=$((count + 1))
  if [ "${count}" -gt "${MAX_FILES}" ]; then
    printf 'NOTE: untracked diff truncated after %s files\n' "${MAX_FILES}" >> "${out}"
    break
  fi

  # wc is more portable than stat across environments.
  bytes=$(wc -c < "${f}" | tr -d ' ')
  if [ "${bytes}" -gt "${MAX_FILE_BYTES}" ]; then
    printf 'NOTE: skipped large untracked file (%s bytes): %s\n' "${bytes}" "${f}" >> "${out}"
    continue
  fi

  if [ $((total + bytes)) -gt "${MAX_TOTAL_BYTES}" ]; then
    printf 'NOTE: untracked diff truncated at ~%s bytes\n' "${MAX_TOTAL_BYTES}" >> "${out}"
    break
  fi
  total=$((total + bytes))

  # git diff exits 1 when differences exist; ignore that.
  git diff --no-color --no-index -- /dev/null "${f}" >> "${out}" || true
  printf '\n' >> "${out}"
done < .agentcore-loop/review.untracked
