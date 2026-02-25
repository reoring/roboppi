# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows SemVer where practical.

## [0.1.5] - 2026-02-25

### Added

- Allow subworkflow steps (`workflow:`) to use `completion_check` loops (`max_iterations`) to rerun child workflows until complete.
- Add subworkflow event bubbling (`bubble_subworkflow_events`, `subworkflow_event_prefix`) and deterministic export copying (`exports_mode: merge|replace`).
- Improve workflow TUI: ANSI-aware wrapping in tabs, and `y` to copy the visible detail tab to the clipboard (system clipboard commands or OSC52 fallback).
- Add a runnable subworkflow loop example (`examples/subworkflow-loop.yaml`, `examples/subworkflow-loop-child.yaml`).

### Changed

- Completion checks accept decisions from `decision_file` JSON or text markers (`PASS`/`FAIL`/`COMPLETE`/`INCOMPLETE`), and can fall back to parsing worker stdout (JSON or marker).
- Completion check instructions interpolate `$ROBOPPI_COMPLETION_CHECK_ID` / `${ROBOPPI_COMPLETION_CHECK_ID}` to the active check id for robustness.
- `scripts/agent-pr-loop/todo-check.sh` now respects `ROBOPPI_TODO_PATH` / `ROBOPPI_LOOP_DIR` and prefers legacy `.agentcore-loop` when present.

## [0.1.4] - 2026-02-22

### Fixed

- Stabilize OpenTUI workflow TUI rendering by sanitizing ANSI control sequences and using ANSI-aware width/truncation.

## [0.1.3] - 2026-02-22

### Added

- Subworkflow steps via `workflow:`: parent workflows can invoke child workflows, with isolated child context under `_subworkflows/` and optional `exports` to copy child artifacts into the parent context.
- Recursion protection for subworkflow invocations (cycle detection + max nesting depth).
- CLI E2E coverage for subworkflow execution in three modes: direct, supervised (stdio transport), supervised (socket transport).

### Changed

- Agent catalog loading is consolidated in `src/workflow/workflow-loader.ts` and reused by CLI and daemon; child workflows inherit the parent's resolved catalog.
- `make test` / `bun run test` are scoped to this repo's test suites (`test/unit`, `test/integration`, `tests/at`) to avoid running vendored/reference tests.

### Fixed

- Harden workflow parsing and context path handling against path traversal and reserved-name collisions (step IDs and artifact names).

## [0.1.2] - 2026-02-20

- See GitHub release notes.
