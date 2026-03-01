# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows SemVer where practical.

## [Unreleased]

### Added

- Supervised workflow TUI now streams worker events to `2: Logs` in real time (stdout/stderr/progress/patch) via IPC `job_event` messages.
- Workflow Management Agent: optional supervisor hooks (`pre_step`, `pre_check`, `post_check`, `on_stall`) that can annotate, skip, adjust timeouts, or abort workflows based on step state.
- Management hook event isolation: management worker events are written to per-invocation JSONL under `context/_management/` and do not leak into the main workflow telemetry/TUI stream.
- Example self-dev workflow for iterating on the management-agent implementation review (`examples/workflow-management-agent-impl-review-loop.yaml`) + bootstrap helper (`scripts/self-dev/workflow-management-agent-impl-review/bootstrap.sh`).

### Changed

- In supervised + TUI mode, stdout/stderr forwarding to `2: Logs` is enabled by default; set `ROBOPPI_TUI_STREAM_STDIO=0` to forward progress/patch only.
- Workflow parsing for `steps.<id>.management` is stricter: unknown keys are rejected, and step-level per-hook overrides are supported.
- Claude Code adapter uses `--output-format stream-json` automatically for streaming tasks when configured for JSON output.
- Worker tasks accept optional `variant` hints (plumbed through to adapters that support it).
- Embedded Pi SDK management engine is read-only in v1 (no command execution/edit/write tools) to preserve mechanism/policy separation.

### Fixed

- Branch verification no longer leaks ambient `BASE_BRANCH`-related environment into isolated workflow runs.

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
