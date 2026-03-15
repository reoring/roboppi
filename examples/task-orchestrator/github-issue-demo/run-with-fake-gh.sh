#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROBOPPI_ROOT=$(cd -- "${SCRIPT_DIR}/../../.." && pwd)

TARGET=${TARGET:-""}

usage() {
  cat <<'EOF'
Usage:
  bash examples/task-orchestrator/github-issue-demo/run-with-fake-gh.sh

Environment variables:
  TARGET   Scratch directory to create/use (default: mktemp under /tmp)
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: required command not found in PATH: $1" >&2
    exit 1
  }
}

need_cmd bun

if [[ -z "${TARGET}" ]]; then
  TARGET=$(mktemp -d /tmp/roboppi-task-orch-github-issue-XXXXXX)
else
  mkdir -p "${TARGET}"
fi

echo "Workspace: ${TARGET}"

cp -R "${SCRIPT_DIR}/." "${TARGET}/"
rm -f "${TARGET}/run-with-fake-gh.sh"

PATH="${TARGET}/mock-bin:${PATH}" \
ROBOPPI_ROOT="${ROBOPPI_ROOT}" \
  bun run --cwd "${ROBOPPI_ROOT}" src/cli.ts -- \
    task-orchestrator serve "${TARGET}/task-orchestrator.yaml" --poll-every 200ms &
SERVER_PID=$!

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for _ in $(seq 1 200); do
  if [[ -f "${TARGET}/github-task-id.txt" ]] && [[ -f "${TARGET}/github-issue-acks/issue-12-status.md" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -f "${TARGET}/github-task-id.txt" ]]; then
  echo "Error: workflow output was not created" >&2
  exit 1
fi

EXPECTED_TASK_ID="github:issue:acme/widgets#12"
ACTUAL_TASK_ID=$(cat "${TARGET}/github-task-id.txt")
if [[ "${ACTUAL_TASK_ID}" != "${EXPECTED_TASK_ID}" ]]; then
  echo "Error: expected task id ${EXPECTED_TASK_ID}, got ${ACTUAL_TASK_ID}" >&2
  exit 1
fi

if [[ ! -f "${TARGET}/github-task.json" ]]; then
  echo "Error: missing copied task context JSON" >&2
  exit 1
fi

if [[ ! -f "${TARGET}/github-issue-acks/issue-12-comment.md" ]]; then
  echo "Error: missing GitHub issue ack comment artifact" >&2
  exit 1
fi

if ! grep -q 'state=ready_to_land' "${TARGET}/github-issue-acks/issue-12-comment.md"; then
  echo "Error: GitHub issue ack comment did not reflect ready_to_land state" >&2
  exit 1
fi

if [[ ! -f "${TARGET}/github-issue-acks/issue-12-status.md" ]]; then
  echo "Error: missing GitHub issue status comment artifact" >&2
  exit 1
fi

if ! grep -q 'Reporter published initial implementation status' "${TARGET}/github-issue-acks/issue-12-status.md"; then
  echo "Error: GitHub issue status comment did not reflect reporter activity" >&2
  exit 1
fi

if ! grep -q 'Publisher policy: `reporter`' "${TARGET}/github-issue-acks/issue-12-status.md"; then
  echo "Error: GitHub issue status comment did not reflect declarative publisher policy" >&2
  exit 1
fi

echo
echo "Verified:"
echo "  ${TARGET}/github-task-id.txt"
echo "  ${TARGET}/github-task.json"
echo "  ${TARGET}/github-issue-acks/issue-12-comment.md"
echo "  ${TARGET}/github-issue-acks/issue-12-status.md"
