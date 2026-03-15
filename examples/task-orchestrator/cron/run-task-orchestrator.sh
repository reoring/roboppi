#!/usr/bin/env bash
set -euo pipefail

ROBOPPI_ROOT=${ROBOPPI_ROOT:-/path/to/roboppi}
CONFIG_PATH=${CONFIG_PATH:-${ROBOPPI_ROOT}/examples/task-orchestrator/file-inbox-demo/task-orchestrator.yaml}

cd "${ROBOPPI_ROOT}"

exec bun run src/cli.ts -- task-orchestrator run "${CONFIG_PATH}" --json
