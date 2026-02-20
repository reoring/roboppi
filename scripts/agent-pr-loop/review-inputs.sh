#!/usr/bin/env bash
set -euo pipefail

# Generate deterministic review inputs for the agent PR loop.
#
# Outputs:
#   .roboppi-loop/review.base_ref       - resolved base ref used for diffs
#   .roboppi-loop/review.diff           - git diff against base ref (tracked changes)
#   .roboppi-loop/review.status         - git status --porcelain
#   .roboppi-loop/review.untracked      - list of untracked (non-ignored) files
#   .roboppi-loop/review.untracked.diff - diffs for untracked files (as /dev/null -> file)

LOOP_DIR=.roboppi-loop

mkdir -p "${LOOP_DIR}"

BASE_BRANCH=$(
  cat "${LOOP_DIR}/base-branch.txt" 2>/dev/null \
    || echo "${BASE_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)}"
)

git fetch origin "${BASE_BRANCH}" >/dev/null 2>&1 || true
if git show-ref --verify --quiet "refs/remotes/origin/${BASE_BRANCH}"; then
  BASE_REF="origin/${BASE_BRANCH}"
elif git show-ref --verify --quiet "refs/heads/${BASE_BRANCH}"; then
  BASE_REF="${BASE_BRANCH}"
else
  BASE_REF="HEAD"
fi

echo "${BASE_REF}" > "${LOOP_DIR}/review.base_ref"

git diff --no-color "${BASE_REF}" > "${LOOP_DIR}/review.diff" || true
git status --porcelain=v1 > "${LOOP_DIR}/review.status" || true
git ls-files --others --exclude-standard > "${LOOP_DIR}/review.untracked" || true

# For large repos, keep untracked diffs bounded.
MAX_FILES=${ROBOPPI_REVIEW_UNTRACKED_MAX_FILES:-200}
MAX_FILE_BYTES=${ROBOPPI_REVIEW_UNTRACKED_MAX_FILE_BYTES:-200000}
MAX_TOTAL_BYTES=${ROBOPPI_REVIEW_UNTRACKED_MAX_TOTAL_BYTES:-2000000}

out="${LOOP_DIR}/review.untracked.diff"
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
done < "${LOOP_DIR}/review.untracked"
