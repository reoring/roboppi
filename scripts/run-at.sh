#!/usr/bin/env bash
set -euo pipefail

# Acceptance Test Runner for AgentCore Workflow System
# Usage: ./scripts/run-at.sh [--full]
#   --full: Also run unit and integration tests

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

FAILED=0

echo "=========================================="
echo " AgentCore Workflow AT Runner"
echo "=========================================="
echo ""

# Step 1: Type checking
echo -e "${YELLOW}[1/3] Type checking...${NC}"
if bun x tsc --noEmit 2>&1; then
  echo -e "${GREEN}  ✓ Type check passed${NC}"
else
  echo -e "${RED}  ✗ Type check failed${NC}"
  FAILED=1
fi
echo ""

# Step 2: Acceptance tests
echo -e "${YELLOW}[2/3] Running acceptance tests...${NC}"
if bun test tests/at/ 2>&1; then
  echo -e "${GREEN}  ✓ Acceptance tests passed${NC}"
else
  echo -e "${RED}  ✗ Acceptance tests failed${NC}"
  FAILED=1
fi
echo ""

# Step 3: Full suite (optional)
if [[ "${1:-}" == "--full" ]]; then
  echo -e "${YELLOW}[3/3] Running full test suite...${NC}"
  if bun test 2>&1; then
    echo -e "${GREEN}  ✓ Full test suite passed${NC}"
  else
    echo -e "${RED}  ✗ Full test suite failed${NC}"
    FAILED=1
  fi
  echo ""
else
  echo -e "${YELLOW}[3/3] Skipped full suite (use --full to include)${NC}"
  echo ""
fi

# Summary
echo "=========================================="
if [[ $FAILED -eq 0 ]]; then
  echo -e "${GREEN} ALL CHECKS PASSED${NC}"
else
  echo -e "${RED} SOME CHECKS FAILED${NC}"
fi
echo "=========================================="

exit $FAILED
