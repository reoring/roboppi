.PHONY: all build test test-unit test-integration test-at test-all typecheck clean help

BIN := agentcore
SRC := src/cli.ts

all: build ## Build the binary (default)

build: ## Build single binary
	bun build --compile $(SRC) --outfile $(BIN)

test: ## Run all tests
	bun test

test-unit: ## Run unit tests only
	bun test test/unit

test-integration: ## Run integration tests only
	bun test test/integration

test-at: ## Run acceptance tests only
	bun test tests/at

test-all: typecheck test ## Run type check + all tests
	@echo "All checks passed"

typecheck: ## Run TypeScript type checker
	bun x tsc --noEmit

clean: ## Remove build artifacts
	rm -f $(BIN)

install: build ## Install binary to /usr/local/bin
	install -m 755 $(BIN) /usr/local/bin/$(BIN)

uninstall: ## Remove binary from /usr/local/bin
	rm -f /usr/local/bin/$(BIN)

dev: ## Run in dev mode (no build)
	bun run $(SRC)

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
