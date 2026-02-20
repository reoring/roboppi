
.PHONY: all build test tests test-unit test-integration test-at test-branch test-all typecheck clean install uninstall dev help

BIN := roboppi

# Legacy build artifacts (no longer built by default)
EXTRA_BINS := roboppi-core roboppi-workflow roboppi-daemon

SRC := src/cli.ts

# Allow passing Bun runtime flags (e.g. BUN_FLAGS=--smol)
BUN ?= bun
BUN_FLAGS ?=

# Extra flags passed to `bun build` (e.g. BUN_BUILD_FLAGS=--compile-exec-argv=--smol)
BUN_BUILD_FLAGS ?=

all: build ## Build the binary (default)

build: ## Build a single binary (roboppi)
	$(BUN) $(BUN_FLAGS) build $(BUN_BUILD_FLAGS) --compile $(SRC) --outfile $(BIN)

test: ## Run all tests
	$(BUN) $(BUN_FLAGS) test

tests: test ## Alias for `make test`

test-unit: ## Run unit tests only
	$(BUN) $(BUN_FLAGS) test test/unit

test-integration: ## Run integration tests only
	$(BUN) $(BUN_FLAGS) test test/integration

test-at: ## Run acceptance tests only
	$(BUN) $(BUN_FLAGS) test tests/at

test-branch: ## Run branch safety verification tests
	bash tests/branch/run-branch-verification.sh

test-all: typecheck test test-branch ## Run type check + all tests
	@echo "All checks passed"

typecheck: ## Run TypeScript type checker
	$(BUN) $(BUN_FLAGS) x tsc --noEmit

clean: ## Remove build artifacts
	rm -f $(BIN) $(EXTRA_BINS)

install: build ## Install binary to /usr/local/bin
	install -m 755 $(BIN) /usr/local/bin/$(BIN)

uninstall: ## Remove binary from /usr/local/bin
	rm -f /usr/local/bin/$(BIN) $(addprefix /usr/local/bin/,$(EXTRA_BINS))

dev: ## Run in dev mode (no build)
	$(BUN) $(BUN_FLAGS) run $(SRC)

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
