#!/usr/bin/env bash
set -euo pipefail

# Bootstrap for the Roboppi self-dev loop targeting:
#   docs/features/workflow-management-agent-implementation-review.md

if ! git rev-parse --git-dir > /dev/null 2>&1; then
  echo "Error: workspace must be a git repository" >&2
  exit 1
fi

LOOP_DIR=.roboppi-loop
mkdir -p "${LOOP_DIR}"

# Clear derived artifacts from prior runs (keep request + branch/base settings).
rm -f \
  "${LOOP_DIR}/review.md" \
  "${LOOP_DIR}/review.verdict" \
  "${LOOP_DIR}/fix.md" \
  "${LOOP_DIR}/review.base_ref" \
  "${LOOP_DIR}/review.diff" \
  "${LOOP_DIR}/review.status" \
  "${LOOP_DIR}/review.untracked" \
  "${LOOP_DIR}/review.untracked.diff"

if [ ! -f "${LOOP_DIR}/request.md" ]; then
  cat > "${LOOP_DIR}/request.md" <<'EOF'
# Request

Roboppi を使って Roboppi 自体を開発するために、
`docs/features/workflow-management-agent-implementation-review.md` に記載されている
指摘 (P0/P1/P2) をすべて解消してください。

## Scope
- 対象: `docs/features/workflow-management-agent-implementation-review.md`
- 目的: TODO 化 -> 実装 -> テストパス -> 実装レビュー完了 までのループ

## Acceptance Criteria
- [ ] `docs/features/workflow-management-agent-implementation-review.md` の P0 指摘が解消されている
- [ ] P1/P2 も必要な分だけ解消され、仕様/実装/ドキュメントが整合している
- [ ] `make test-all` が PASS
- [ ] 実装レビュー (差分+仕様照合) が PASS
EOF
fi

REQ_BYTES=$(wc -c < "${LOOP_DIR}/request.md" | tr -d ' ')
if [ "${REQ_BYTES}" -lt 120 ]; then
  echo "Error: ${LOOP_DIR}/request.md is too small. Please fill it in first." >&2
  exit 1
fi

if [ -n "${BASE_BRANCH:-}" ]; then
  BASE_BRANCH="${BASE_BRANCH}"
else
  BASE_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)"
fi

if [ "${BASE_BRANCH}" = "HEAD" ]; then
  echo "Error: detached HEAD detected. Set BASE_BRANCH or checkout a branch." >&2
  exit 1
fi

echo "${BASE_BRANCH}" > "${LOOP_DIR}/base-branch.txt"
git rev-parse "${BASE_BRANCH}^{commit}" > "${LOOP_DIR}/base-sha.txt" 2>/dev/null || true

command -v opencode > /dev/null 2>&1 || { echo "Error: opencode not found in PATH" >&2; exit 1; }

echo "OK" > "${LOOP_DIR}/bootstrap.ok"
