# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows SemVer where practical.

## [Unreleased]

### Added

### Changed

### Fixed

## [0.1.15] - 2026-03-16

### Changed

- Completion checks now isolate their decision files per check invocation instead of sharing one mutable decision path across the run.
- Agent coordination now re-synchronizes workflow status and routed tasks from canonical current-state so new slices regenerate actionable work instead of relying on startup-only task seeding.

### Fixed

- Prevented long-running agent workflows from exhausting 100 completion-check iterations with an empty task queue by detecting routing deadlocks and failing fast with explicit diagnostics.
- Removed unused TypeScript symbols that caused the release verify job (`bun x tsc --noEmit`) to fail before GitHub could publish the release.
- Treated resident `task-orchestrator serve` shutdown aborts as clean exits so release verification does not fail after the clarification-resume acceptance flow has already passed.
- Hardened the clarification-resume acceptance test to wait for clarification-comment materialization before asserting the waiting-state handoff.

## [0.1.12] - 2026-03-15

### Fixed

- Hardened acceptance-test cleanup for resident task-orchestrator serve flows so CI does not fail after the functional assertions have already passed.
- Added a bounded retry in the agents CLI acceptance harness for rare Bun 1.3.8 no-output hangs observed in CI process spawning.


## [0.1.11] - 2026-03-15

### Added

- Added the Task Orchestrator control plane with `roboppi task-orchestrator run|serve|status`, local activity/intent emission, file inbox polling, GitHub issue ingestion, and workflow routing/state persistence.
- Added GitHub task automation helpers for issue-to-workflow routing, PR-open/review actuation flows, and example cron/systemd/demo setups for local or resident operation.
- Added `roboppi agents mcp` plus richer agent runtime visibility, task orchestration examples, and GitHub-backed live agent-team workflows.

### Changed

- Agent coordination now enforces canonical current-state phase routing and keeps task/reporting flows aligned with the new orchestrator integration points.

### Fixed

- Dependent agent tasks now unblock correctly after supersede, and acceptance coverage hardens CLI stdin handling to reduce release-time flakes.


## [0.1.10] - 2026-03-09

### Added

- Added `roboppi agents tasks supersede` and `roboppi agents status get|set` for file-backed workflow status summaries and task replacement flow.
- Extended the agents workflow DSL with seed task `id`/`depends_on`/`tags`/`requires_plan_approval`, member `role`, and worker `defaultArgs`.
- Added TUI Timeline/Raw/Usage tabs with structured LLM log summaries, agent runtime usage stats, and dormant-agent visibility.

### Changed

- Agent coordination now prunes stopped resident agents before reconcile, skips dormant members, restores mailbox body previews, and emits task-superseded activity events.
- The Codex CLI adapter now normalizes legacy sandbox/approval flags and merges task/profile `defaultArgs` before dispatch.

### Fixed

- Clarified agent task claimability and dependency handling, including seeded dependency resolution and broader test coverage.
- Added verification around supervised IPC capability detection, TUI state/runtime accounting, and prompt-byte tracking in worker costs.


## [0.1.9] - 2026-03-06

### Added

- `roboppi agents chat` interactive REPL, `message reply`, and resident-agent dispatch loops so teammates can keep working across the full workflow run.
- Runner-owned lead inbox summaries at `_agents/inbox-summary.json`, dynamic membership reconciliation, and new example workflows for live team reconfiguration.
- TUI agent overview/chat surfaces for inline messaging and richer agent activity inspection.

### Changed

- Renamed the swarm-facing CLI, docs, examples, tests, and runtime modules to the `agents` surface so the feature matches the shipped vocabulary.
- Agent coordination now keeps long-lived LLM teammates resident and routes lead communication through mailbox-backed workflow services instead of prompt-level polling.

### Fixed

- Added reply-token handling and expanded unit/acceptance coverage around agent mailbox, broker, and TUI chat behavior.


## [0.1.8] - 2026-03-02

### Added

- Agents v1: file-backed mailbox + task store for agent teams under `<context_dir>/_agents/`.
- New `roboppi agents` CLI (JSON-only stdout) for members, messaging, tasks, and housekeeping (incl. `message recv --wait-ms`, claim-token ack, stale recovery).
- Workflow YAML `agents:` config for defining members + seeding tasks; inject `ROBOPPI_AGENTS_*` env vars into steps.
- Workflow TUI Agents tab + `agent_*` exec events for metadata-only activity visibility.
- New worker capabilities `MAILBOX` and `TASKS` to gate Agents tooling (Claude Code allowlist support).
- Runner-owned `LeadInboxBroker` for auto-consuming lead inbox and maintaining `_agents/inbox-summary.json`.
- Dynamic membership via `roboppi agents members set|upsert|remove` with coordinator reconcile loop.

### Changed

- Agents conformance checklist is captured in `docs/spec/agents.md` and enforced by the self-dev Agents impl loop.

### Fixed

- Harden `roboppi agents` tool-facing inputs with explicit path-safety validation and JSON-safe error output.

## [0.1.7] - 2026-03-01

### Added

- Workflow Management Agent: optional supervisor hooks (`pre_step`, `pre_check`, `post_check`, `on_stall`) that can annotate, skip, adjust timeouts, or abort workflows based on step state.
- Management hook event isolation: management worker events are written to per-invocation JSONL under `context/_management/` and do not leak into the main workflow telemetry/TUI stream.
- Example self-dev workflow for iterating on the management-agent implementation review (`examples/workflow-management-agent-impl-review-loop.yaml`) + bootstrap helper (`scripts/self-dev/workflow-management-agent-impl-review/bootstrap.sh`).

### Changed

- Workflow parsing for `steps.<id>.management` is stricter: unknown keys are rejected, and step-level per-hook overrides are supported.
- Claude Code adapter uses `--output-format stream-json` automatically for streaming tasks when configured for JSON output.
- Worker tasks accept optional `variant` hints (plumbed through to adapters that support it).
- Embedded Pi SDK management engine is read-only in v1 (no command execution/edit/write tools) to preserve mechanism/policy separation.

### Fixed

- Branch verification no longer leaks ambient `BASE_BRANCH`-related environment into isolated workflow runs.

## [0.1.6] - 2026-02-25

### Added

- Supervised workflow TUI now streams worker events to `2: Logs` in real time (stdout/stderr/progress/patch) via IPC `job_event` messages.

### Changed

- In supervised + TUI mode, stdout/stderr forwarding to `2: Logs` is enabled by default; set `ROBOPPI_TUI_STREAM_STDIO=0` to forward progress/patch only.

### Docs

- Updated workflow/TUI docs and quickstarts.

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
