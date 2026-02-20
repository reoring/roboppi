# AGENTS.md

This repository ("Roboppi" / package name: `roboppi`) is a Bun + TypeScript (ESM)
codebase that implements an execution-control runtime for agentic workers.

## Build / Lint / Test

Prefer `make` targets (CI uses them), but `bun` equivalents work.

### Install

```bash
bun install
bun install --frozen-lockfile  # CI
```

CI currently uses Bun 1.3.8 (see `.github/workflows/ci.yml`).

### Typecheck (acts as "lint")

There is no ESLint/Prettier/Biome config today; use TypeScript strict checks + tests.

```bash
make typecheck
# or
bun run typecheck
```

### Tests

```bash
make test              # bun test
make test-unit         # bun test test/unit
make test-integration  # bun test test/integration
make test-at           # bun test tests/at
make test-branch       # bash tests/branch/run-branch-verification.sh
make test-all          # CI: typecheck + test + test-branch
```

Acceptance test helper runner:

```bash
bash scripts/run-at.sh        # typecheck + tests/at
bash scripts/run-at.sh --full # + bun test
```

### Run A Single Test

```bash
bun test test/unit/ipc/protocol.test.ts
bun test test/unit/ipc/protocol.test.ts -t "routes submit_job"   # regex on test name
bun test -t "routes submit_job"                                  # match across all tests
bun test --only                                                   # only test.only/describe.only
bun test --timeout 20000 test/integration                         # per-test timeout (ms)
bun test --watch test/unit                                        # watch mode
```

### Build

Builds a native executable `./roboppi` (gitignored).

```bash
make build      # or: bun run build
make install    # /usr/local/bin/roboppi
make uninstall
```

### Dev / Run

```bash
make dev              # bun run src/cli.ts
bun run dev           # bun run src/index.ts
bun run dev:scheduler # bun run src/scheduler/index.ts
```

## Project Layout (high-level)

- Runtime entrypoints: `src/cli.ts` (bin), `src/index.ts` (Core process)
- Core safety mechanisms: `src/core/**`
- IPC JSONL protocol/transport: `src/ipc/**`
- Daemon entrypoints: `src/daemon/**`
- Worker adapters + process mgmt: `src/worker/**`
- Workflow runner/executor: `src/workflow/**`
- Scheduler layer: `src/scheduler/**`
- Design notes: `docs/**`
- Unit/integration tests: `test/**`
- Acceptance + branch-safety tests: `tests/**`

## Code Style Guidelines

### TypeScript / Module System

- ESM everywhere (`package.json` has `"type": "module"`).
- Relative imports for local modules MUST include the `.js` extension.
  - Example: `import { AgentCore } from "./core/agentcore.js";`
- Use `node:` specifiers for built-in modules.
  - Example: `import { readFile } from "node:fs/promises";`
- Use `import type { ... }` for type-only imports.
- Avoid the `@/*` path alias unless you confirm runtime resolution; prefer relative imports.

### Formatting

- 2-space indentation, semicolons, trailing commas in multiline constructs.
- Keep changes minimal: no repo-wide reformatting sweeps (no formatter is enforced).

### Imports

- No enforced ordering; keep import groups consistent within the file you touch.
- Keep `import ...` statements at the top of the file.
- Prefer `../types/index.js` barrel exports for shared types/enums.
- Avoid default exports for local modules; use named exports (existing pattern).

### Types

- `tsconfig.json` is strict (`noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, etc.).
- Avoid `any` in `src/**`.
  - Use `unknown` in `catch` and narrow via `instanceof Error`, `typeof`, etc.
- Add explicit return types for exported functions and public class methods.
- Prefer small discriminated unions / string enums for protocol/state machines.

### Naming

- Files: `kebab-case.ts` (e.g., `json-lines-transport.ts`).
- Classes/types/interfaces/enums: `PascalCase`.
- Functions/locals: `camelCase`.
- Constants: `SCREAMING_SNAKE_CASE`.
- IDs are UUID strings: use `generateId()` / `crypto.randomUUID()`.

### Error Handling

- Throw `Error` (or subclasses), never strings.
- Set `err.name` on custom error classes; attach `cause` when useful.
- When surfacing errors across boundaries (IPC/worker/workflow), include context: `requestId`, `jobId`, `permitId`, `stepId`.
- Use `ErrorClass` for retryability when returning `WorkerResult`-style failures.

### Cancellation / Timeouts / Cleanup

- If a function can block (IO, process spawn, long loop), accept an `AbortSignal`
  and stop promptly when aborted.
- Always clear timers and remove event listeners in `finally` blocks.
- When spawning subprocesses, prefer `ProcessManager` (abort, timeout, best-effort process-group termination).

### IPC Safety

- IPC is JSON Lines over stdout. In server/Core mode, NEVER write non-JSON to stdout (use stderr/loggers).
- Validate message shape before acting (see `src/ipc/protocol.ts`).

### Tests

- Use `bun:test` (`describe`, `test`/`it`, `expect`).
- Keep tests deterministic; avoid network and real worker CLIs in unit tests.
- Use temp dirs for filesystem work; clean up after.

## Cursor / Copilot Rules

- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` found in this repo.
