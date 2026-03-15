#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROBOPPI_ROOT=$(cd -- "${SCRIPT_DIR}/../../.." && pwd)

TARGET=${TARGET:-""}

usage() {
  cat <<'EOF'
Usage:
  bash examples/task-orchestrator/file-inbox-demo/run-in-tmp.sh

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
  TARGET=$(mktemp -d /tmp/roboppi-task-orch-file-inbox-XXXXXX)
else
  mkdir -p "${TARGET}"
fi

echo "Workspace: ${TARGET}"

cp -R "${SCRIPT_DIR}/." "${TARGET}/"
rm -f "${TARGET}/run-in-tmp.sh"

bun run --cwd "${ROBOPPI_ROOT}" src/cli.ts -- \
  task-orchestrator run "${TARGET}/task-orchestrator.yaml"

EXPECTED_TASK_ID="file_inbox:inbox:task.json"
ACTUAL_TASK_ID=$(cat "${TARGET}/repo/task-id.txt")
if [[ "${ACTUAL_TASK_ID}" != "${EXPECTED_TASK_ID}" ]]; then
  echo "Error: expected task id ${EXPECTED_TASK_ID}, got ${ACTUAL_TASK_ID}" >&2
  exit 1
fi

ACK_PATH="${TARGET}/inbox/.roboppi-acks/task.json.ack.json"
if [[ ! -f "${ACK_PATH}" ]]; then
  echo "Error: missing ack file: ${ACK_PATH}" >&2
  exit 1
fi

echo
echo "Verified:"
echo "  ${TARGET}/repo/task-id.txt"
echo "  ${ACK_PATH}"
