# Swarm v1 Conformance Specification (Gap Closure)

Status: implemented
Last updated: 2026-03-02

This document defines the conformance requirements needed for the current Swarm
implementation to fully align with `docs/features/swarm.md`.

It records review findings as normative requirements.
Items already implemented in code are listed as baseline and are not redefined
here unless clarification is needed.

## 0. Scope

This spec covers the remaining conformance work for:

- `roboppi swarm` CLI behavior
- coordinator lifecycle and cleanup guarantees
- housekeeping/crash-recovery coverage
- path and output safety rules
- test strategy alignment

Out of scope for this document:

- multi-host swarm support
- nested swarms
- MCP transport delivery (`roboppi swarm mcp`) in v1

## 1. Source Of Truth

Primary design:

- `docs/features/swarm.md`

This document is a conformance addendum and MUST be interpreted together with
that design document.

## 2. Baseline (Already Implemented)

The following are treated as implemented baseline:

- File-backed mailbox/task store with atomic rename-based transitions.
- Core CLI surface:
  - `init`
  - `members list`
  - `message send|broadcast|recv|ack`
  - `tasks add|list|claim|complete`
  - `housekeep`
- Metadata-only `_events.jsonl` emission for mailbox/tasks.
- Capability wiring of `MAILBOX` / `TASKS` in workflow/daemon/type layers.
- Workflow top-level `swarm:` integration and TUI swarm tab visibility.

This spec focuses only on residual gaps.

## 3. Normative Gap-Closure Requirements

### 3.1 `message recv --wait-ms` MUST be implemented

`roboppi swarm message recv` MUST support:

- `--wait-ms <M>` where `M` is an integer `>= 0`.

Behavior:

- If messages are immediately available, return immediately.
- Otherwise, poll until either:
  - at least one message becomes available, or
  - elapsed time reaches `wait-ms`.
- On timeout, return success with an empty `messages` array.
- `--wait-ms 0` MUST be equivalent to non-blocking current behavior.

Polling interval MAY use a default constant; it MUST be deterministic and
bounded.

### 3.2 Coordinator shutdown MUST verify completion and apply cleanup policy

Coordinator shutdown MUST satisfy all of:

1. Send `shutdown_request` to all running teammates.
2. Wait for teammate completion and/or explicit `shutdown_ack` evidence within a
   bounded timeout.
3. Force-abort only remaining non-settled teammates after timeout.
4. Apply cleanup policy from `team.json.cleanup_policy`:
   - if `retain_mailbox=false`, mailbox artifacts are removed at shutdown
   - if `retain_tasks=false`, tasks artifacts are removed at shutdown
5. Emit a final metadata-only cleanup event documenting completion and what was
   retained/removed.

Cleanup and event emission MUST be best-effort and MUST NOT leave partial
deletions that violate store consistency guarantees.

### 3.3 Task orphan recovery MUST include stale `in_progress` handling

Housekeeping MUST handle stale tasks in `tasks/in_progress/`:

- detect stale tasks via TTL
- move stale tasks to either:
  - `pending/` (requeue), or
  - `orphaned/` (if introduced)
- update task metadata atomically (`status`, timestamps, ownership fields)
- emit metadata-only event for audit

The operation MUST be idempotent and race-safe under concurrent housekeeping
runs.

### 3.4 CLI output contract MUST be JSON-safe for all failures

For every `roboppi swarm` subcommand failure, including argument/usage errors:

- stdout MUST contain exactly one JSON object:
  - `{ "ok": false, "error": "<message>" }`
- exit code MUST be non-zero.

For help output (`-h` / `--help`):

- help text MUST go to stderr
- stdout MUST be empty
- exit code MUST be `0`.

### 3.5 Path safety MUST be explicit for tool-facing path inputs

All tool-facing path inputs MUST be constrained to Swarm-safe boundaries.

Requirements:

- All filesystem mutations for swarm data MUST remain inside
  `<context_dir>/_swarm`.
- User-supplied path values (including artifact-like values) MUST reject:
  - absolute paths (unless explicitly allowed by command contract)
  - `..` traversal
  - symlink escape outside allowed roots after resolution.

Validation errors MUST follow the JSON error contract in section 3.4.

### 3.6 Integration testing MUST match section 11 intent

Test suite MUST include at least one supervised integration/AT scenario that:

- runs with supervised mode enabled
- uses `roboppi swarm ...` commands (not only direct store API calls)
- includes two `CUSTOM` workers exchanging messages/tasks
- verifies emitted `swarm_*` exec events and/or `_swarm/*/_events.jsonl`
  artifacts

## 4. Capability And Identity Clarifications

### 4.1 `MAILBOX` and `TASKS` separation

`MAILBOX` and `TASKS` MUST remain independently gateable from
`RUN_COMMANDS`.

It is acceptable in v1 that both map to the same restricted `roboppi swarm:*`
surface, but adapters SHOULD evolve toward least-privilege separation by
subcommand group.

### 4.2 Identity anti-spoofing

Current membership validation is mandatory baseline.

Optional per-member token-file verification is a future hardening and is NOT
required for v1 conformance.

## 5. Conformance Checklist

A release is considered conformant to this spec only when all items below are
true:

- [x] 3.1 implemented and covered by unit/AT tests
  - `--wait-ms 0`, timeout, and arrival-during-wait AT coverage in `tests/at/swarm-cli.test.ts`
- [x] 3.2 implemented and covered by lifecycle tests
  - Shutdown bounded end-to-end: `teammateShutdownWaitMs` deadline + 5s settle cap
  - All unsettled teammates force-aborted after deadline (regardless of ack evidence)
  - Cleanup trash kept within `_swarm/.trash/` (not `os.tmpdir()`)
  - `tests/unit/swarm/coordinator.test.ts` (bounded timeout, abort-only-unsettled, cleanup policy, cleanup event)
- [x] 3.3 implemented and covered by housekeeping tests
  - `tests/unit/swarm/housekeeping-tasks.test.ts` (stale detection, metadata rewrite, idempotency, concurrent safety)
- [x] 3.4 implemented and covered by CLI error/help tests
  - Unknown subcommand, missing flag, semantic failure AT coverage in `tests/at/swarm-cli.test.ts`
- [x] 3.5 implemented and covered by path-safety tests
  - `assertSwarmRootSafe()` + `validateMemberIdPath()` applied to all mutating commands including `init`, `recv`, `ack`, `housekeep`
  - `init` validates `--lead` and all `--json-stdin` member IDs via `validateMemberIdPath()`
  - Symlink escape + traversal rejection AT in `tests/at/swarm-cli.test.ts` (including `init` subcommand)
- [x] 3.6 implemented and verified in CI test targets
  - `tests/at/swarm-supervised-custom.test.ts` uses CLI subprocess calls (not direct store API)

## 6. Compatibility

This specification preserves compatibility with the `version: "1"` swarm
on-disk objects and with the design direction in `docs/features/swarm.md`.
