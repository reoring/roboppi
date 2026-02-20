#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "${SCRIPT_DIR}/../.." && pwd)

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is required" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required" >&2
  exit 1
fi

HAS_RG=0
if command -v rg >/dev/null 2>&1; then
  HAS_RG=1
fi

VERIFY_DIR=${1:-"$(mktemp -d /tmp/roboppi-branch-verify-XXXXXX)"}
mkdir -p "${VERIFY_DIR}"
LOG_DIR="${VERIFY_DIR}/logs"
mkdir -p "${LOG_DIR}"

cat > "${VERIFY_DIR}/wf-default.yaml" <<'YAML'
name: verify-default-current
version: "1"
timeout: "2m"
create_branch: false
steps:
  one:
    worker: CUSTOM
    instructions: |
      git rev-parse --abbrev-ref HEAD > .branch-before.txt
      echo ok > .ok.txt
    capabilities: [READ, EDIT, RUN_COMMANDS]
    outputs:
      - name: ok
        path: .ok.txt
YAML

cat > "${VERIFY_DIR}/wf-drift.yaml" <<'YAML'
name: verify-drift-detection
version: "1"
timeout: "2m"
create_branch: false
steps:
  mutate_branch:
    worker: CUSTOM
    instructions: |
      git checkout main
      echo switched > .switched.txt
    capabilities: [READ, EDIT, RUN_COMMANDS]
  should_not_run:
    worker: CUSTOM
    depends_on: [mutate_branch]
    instructions: |
      echo should-not-run > .unexpected.txt
    capabilities: [READ, EDIT, RUN_COMMANDS]
YAML

cat > "${VERIFY_DIR}/wf-transition.yaml" <<'YAML'
name: verify-transition
version: "1"
timeout: "2m"
create_branch: true
branch_transition_step: branch
steps:
  branch:
    worker: CUSTOM
    instructions: |
      git checkout -b feature/transition-pass
      echo branched > .branched.txt
    capabilities: [READ, EDIT, RUN_COMMANDS]
  work:
    worker: CUSTOM
    depends_on: [branch]
    instructions: |
      git rev-parse --abbrev-ref HEAD > .branch-after.txt
      echo work-ok > .work.txt
    capabilities: [READ, EDIT, RUN_COMMANDS]
YAML

cat > "${VERIFY_DIR}/wf-protected.yaml" <<'YAML'
name: verify-protected-guard
version: "1"
timeout: "2m"
create_branch: false
steps:
  one:
    worker: CUSTOM
    instructions: |
      echo protected-test > .protected.txt
    capabilities: [READ, EDIT, RUN_COMMANDS]
YAML

init_repo() {
  if [ -d "${VERIFY_DIR}/.git" ]; then
    return
  fi
  git -C "${VERIFY_DIR}" init -b main >/dev/null
  git -C "${VERIFY_DIR}" config user.name "Verify Bot"
  git -C "${VERIFY_DIR}" config user.email "verify@example.com"
  echo "hello" > "${VERIFY_DIR}/README.md"
  git -C "${VERIFY_DIR}" add README.md
  git -C "${VERIFY_DIR}" commit -m "init" >/dev/null
}

run_wf() {
  local wf="$1"
  local log="$2"
  shift 2
  set +e
  (cd "${REPO_ROOT}" && bun run src/workflow/run.ts "${VERIFY_DIR}/${wf}" --workspace "${VERIFY_DIR}" --verbose "$@" > "${log}" 2>&1)
  local code=$?
  set -e
  return "${code}"
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  if [ "${HAS_RG}" = "1" ] && rg -q -- "$pattern" "$file"; then
    return
  fi
  if [ "${HAS_RG}" = "0" ] && grep -Eq -- "$pattern" "$file"; then
    return
  fi
  echo "ASSERTION FAILED: pattern not found" >&2
  echo "  file: $file" >&2
  echo "  pattern: $pattern" >&2
  exit 1
}

init_repo

git -C "${VERIFY_DIR}" checkout -B feature/verify >/dev/null

# TC-01
if run_wf "wf-default.yaml" "${LOG_DIR}/out-default.log"; then
  :
else
  echo "TC-01 failed: expected success" >&2
  exit 1
fi
assert_contains "${LOG_DIR}/out-default.log" "effective_base_branch: feature/verify"
assert_contains "${LOG_DIR}/out-default.log" "effective_base_branch_source: current"
if [ "$(cat "${VERIFY_DIR}/.branch-before.txt")" != "feature/verify" ]; then
  echo "TC-01 failed: .branch-before.txt mismatch" >&2
  exit 1
fi

# TC-02
if run_wf "wf-drift.yaml" "${LOG_DIR}/out-drift.log"; then
  echo "TC-02 failed: expected failure" >&2
  exit 1
fi
assert_contains "${LOG_DIR}/out-drift.log" "Branch drift detected"

# TC-03
git -C "${VERIFY_DIR}" checkout feature/verify >/dev/null
if run_wf "wf-transition.yaml" "${LOG_DIR}/out-transition.log"; then
  :
else
  echo "TC-03 failed: expected success" >&2
  exit 1
fi
assert_contains "${LOG_DIR}/out-transition.log" "branch_transition_step: branch"
if [ "$(cat "${VERIFY_DIR}/.branch-after.txt")" != "feature/transition-pass" ]; then
  echo "TC-03 failed: .branch-after.txt mismatch" >&2
  exit 1
fi

# TC-04 / TC-05
git -C "${VERIFY_DIR}" checkout main >/dev/null
if run_wf "wf-protected.yaml" "${LOG_DIR}/out-protected-block.log"; then
  echo "TC-04 failed: expected failure" >&2
  exit 1
fi
assert_contains "${LOG_DIR}/out-protected-block.log" "expected_work_branch \"main\" is protected"

if run_wf "wf-protected.yaml" "${LOG_DIR}/out-protected-allow.log" --allow-protected-branch; then
  :
else
  echo "TC-05 failed: expected success" >&2
  exit 1
fi
assert_contains "${LOG_DIR}/out-protected-allow.log" "allow_protected_branch: true"

echo "All branch verification test cases passed"
echo "VERIFY_DIR=${VERIFY_DIR}"
echo "LOG_DIR=${LOG_DIR}"
