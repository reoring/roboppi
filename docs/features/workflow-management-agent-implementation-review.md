# Workflow Management Agent Implementation Review (feat/workflow-agent)

This document records an implementation review of the Workflow Management Agent feature.

Related proposal/design: `docs/features/workflow-management-agent.md`

Scope of reviewed changes (high level):
- Management agent runtime + hooks: `src/workflow/management/*`, `src/workflow/executor.ts`, `src/workflow/parser.ts`, `src/workflow/types.ts`
- Pi (coding-agent) SDK engine: `src/workflow/management/pi-sdk-engine.ts`
- Structured concurrency helper + IPC waiter refactor: `src/core/effect-concurrency.ts`, `src/ipc/protocol.ts`

Test status at review time:
- `make typecheck`: PASS
- `make test-unit`: PASS
- `make test-integration`: PASS
- `make test-at`: PASS

Update status (2026-02-27): DONE
- Current verification (2026-02-27):
  - Code audit: PASS (confirmed in code)
    - Event isolation (emitter-level): `src/workflow/multi-worker-step-runner.ts` `MultiWorkerStepRunner.runWorkerTask()` and `src/workflow/core-ipc-step-runner.ts` `CoreIpcStepRunner.onJobEvent()`/`runWorkerTask()` emit `worker_event`/`worker_result` into the *per-invocation* sink (`sinkOverride`), and management invocations use `src/workflow/management/worker-engine.ts` `WorkerEngine.invokeHook()` to pass a dedicated `src/workflow/management/management-event-sink.ts` `ManagementEventSink`.
    - Event isolation (defense-in-depth): `src/workflow/executor.ts` `isManagementEvent()` filters `_management:*` events out of the main sentinel/telemetry sink. Sentinel `activity-tracker.ts` only receives events from the composite sink (which filters management events at line 394).
    - Directive validation parity: `src/workflow/management/management-controller.ts` `ManagementController.invokeHook()` applies `validateDirectiveShape()` + `validateDirective()` to all engine outputs; file decisions add correlation/staleness checks in `src/workflow/management/decision-resolver.ts` `resolveManagementDecision()`; Pi tool-call capture validates shape in `src/workflow/management/pi-sdk-engine.ts` `PiSdkEngine.buildDecisionTool()`.
    - Runaway guard semantics: `src/workflow/management/management-controller.ts` `ManagementController.invokeHook()` resets the streak (line 219-221) when bypassing due to `max_consecutive_interventions`.
    - Pi tool mapping: `src/workflow/management/pi-sdk-engine.ts` `buildPiTools()` ignores declared capabilities and only returns read-only tools.
    - pre_check wiring + timeout/instruction adjustments: `src/workflow/executor.ts` completion_check loop pre_check path (lines 1242-1278, sets `managementCheckOverlays` / `checkTimeoutOverrides`).
    - Agent catalog resolution: `src/workflow/executor.ts` `WorkflowExecutor.resolveManagementConfig()` (lines 741-792) resolves `management.agent.agent` into an effective config (merges worker/model/capabilities/base_instructions).
    - Step-level per-hook overrides: `src/workflow/management/management-controller.ts` `ManagementController.isHookEnabled()` (lines 122-142) applies `steps.<id>.management.<hook>` booleans over workflow-level defaults.
    - Completion_check iteration semantics: `src/workflow/executor.ts` `runStepLifecycle()` re-invokes `pre_step` for iterations >= 2 (lines 930-992) so management overlays can be replaced/cleared.
    - Workflow meta captures abort reason: `src/workflow/executor.ts` `WorkflowExecutor.buildWorkflowMetaExtras()` (lines 2769-2782) writes `management_abort_reason` when `abortReason === "management"`.
    - decisions.jsonl captures engine meta: `src/workflow/management/management-controller.ts` `ManagementController.invokeHook()` (lines 333-336) includes `engineResult.meta.reasoning` / `engineResult.meta.confidence` in `DecisionsLogEntry`.
    - HookContext includes artifact pointers/paths: `src/workflow/management/types.ts` `HookContext.paths` and `src/workflow/management/hook-context-builder.ts` `HookContextBuilder.buildAndWrite()` populate structured artifact pointers.
  - Test verification (2026-02-27): ALL PASS
    - `make test-all` (typecheck + 1384 bun tests + branch verification): PASS
    - `make typecheck`: PASS
    - `bun test` (1384 tests): PASS (0 fail)
    - `make test-branch` (TC-01 through TC-05): PASS
    - `bun test tests/at/cli-subcommands.test.ts -t "TC-CLI-04"`: PASS (1 test)
    - `bun test test/unit/workflow/management-engine.test.ts -t "TC-PI-W-08"`: PASS
    - `bun test test/integration/management-executor.test.ts -t "management worker events do not leak"`: PASS
    - `bun test test/unit/workflow/management-decision-resolver.test.ts`: PASS (10 tests)
    - `bun test test/unit/workflow/management-engine.test.ts -t "TC-PI-P-14|TC-PI-P-15"`: PASS (2 tests)
    - `bun test test/unit/workflow/management-controller.test.ts -t "max_consecutive_interventions"`: PASS
    - `bun test test/unit/workflow/management-engine.test.ts -t "TC-PI-P-09|TC-PI-P-10"`: PASS (2 tests)
    - `bun test test/integration/management-executor.test.ts -t "pre_check"`: PASS (2 tests)
    - `bun test test/integration/management-executor.test.ts -t "catalog"`: PASS
    - `bun test test/integration/management-executor.test.ts -t "per-hook override"`: PASS (2 tests)
    - `bun test test/integration/management-executor.test.ts -t "TC-MA-E-06"`: PASS
    - `bun test test/integration/management-executor.test.ts -t "abort reason"`: PASS
    - `bun test test/unit/workflow/management-controller.test.ts -t "engine meta"`: PASS
    - `bun test test/unit/workflow/management-hook-context-builder.test.ts`: PASS
  - Fix: `tests/branch/run-branch-verification.sh` — unset `BASE_BRANCH` and related env vars in `run_wf()` to prevent ambient environment leakage into isolated branch tests.

## Key Findings

### P0 (must-fix)

- Management worker event isolation is not actually enforced.
  - The executor filters management events via step id prefix (`_management:`) in `src/workflow/executor.ts`, but `worker_event` / `worker_result` are emitted by the `StepRunner` (e.g. `src/workflow/multi-worker-step-runner.ts`) directly to its own sink, bypassing the executor-level filter.
  - Impact: management hook executions can leak into TUI, Sentinel telemetry (`_workflow/events.jsonl`), and activity tracking.
  - References: `src/workflow/executor.ts`, `src/workflow/management/worker-engine.ts`, `src/workflow/multi-worker-step-runner.ts`, `src/workflow/sentinel/activity-tracker.ts`

- PiSdkEngine does not go through the same decision validation guarantees as WorkerEngine.
  - Worker path: decision file -> `resolveManagementDecision()` -> schema checks (required fields, length bounds, staleness).
  - Pi path: tool call -> captured directive -> only minimal `action` validation; required fields for action types are not enforced before executor application.
  - Impact: malformed directives can slip through (especially actions that require fields like `skip.reason`, `adjust_timeout.timeout`).
  - References: `src/workflow/management/pi-sdk-engine.ts`, `src/workflow/management/decision-resolver.ts`, `src/workflow/management/directive-validator.ts`

- `max_consecutive_interventions` runaway guard becomes a permanent bypass.
  - Once `consecutiveInterventions >= max`, `shouldSkipHook()` returns true and the counter never resets because hooks are no longer invoked.
  - Impact: one bad streak disables management hooks for the remainder of the workflow run (stronger behavior than “force proceed”).
  - References: `src/workflow/management/management-controller.ts`

- Pi tool capability mapping can violate mechanism/policy separation for command execution.
  - Current mapping can hand Pi a general-purpose `bash` tool (via Pi SDK helpers) without Roboppi-side enforcement of allowlists/timeouts.
  - Impact: policy constraints (e.g. `max_command_time`, “RUN_TESTS-only commands”) cannot be reliably enforced by Roboppi.
  - References: `src/workflow/management/pi-sdk-engine.ts`, `docs/features/workflow-management-agent.md`

### P1 (feature gaps vs proposal / DSL)

- `pre_check` hook is defined but not wired.
  - Types and permission matrix include `pre_check` and `adjust_timeout` at `pre_check`, but the executor only implements `post_check` today.
  - Impact: configured `management.hooks.pre_check: true` has no effect, and check timeout adjustment cannot work as described.
  - References: `src/workflow/executor.ts`, `src/workflow/management/types.ts`

- Agent catalog reference (`management.agent.agent`) is not resolved at runtime.
  - Parser validates mutual exclusion of `worker` vs `agent`, but there is no runtime resolution path from catalog profile to concrete `worker/model/capabilities/base_instructions` for management.
  - Impact: config can parse but the engine defaults can silently diverge from user intent.
  - References: `src/workflow/parser.ts`, `src/workflow/management/worker-engine.ts`, `src/workflow/executor.ts`

- Step-level per-hook overrides are not supported.
  - Proposal describes per-step hook toggles; current step-level config supports only `enabled` and `context_hint`.
  - Impact: users cannot safely scope management to only specific hooks/steps as designed.
  - References: `src/workflow/types.ts`, `src/workflow/parser.ts`, `docs/features/workflow-management-agent.md`

- Instruction overlay model differs from the proposal (and is not per-iteration).
  - Implementation applies management overlay by concatenating into `StepDefinition.instructions` in `applyManagementOverlay()`.
  - `pre_step` is invoked once per step before the run loop; it is not invoked per completion_check iteration/retry.
  - Impact: “overlay replaced/cleared per iteration” semantics do not hold; prompt growth and audit boundaries can differ from the doc.
  - References: `src/workflow/executor.ts`, `docs/features/workflow-management-agent.md`

### P2 (quality / observability / maintainability)

- Workflow abort metadata does not capture management abort reason text.
  - Executor maps management abort to `WorkflowStatus.CANCELLED`, but the directive’s `reason` is not persisted in workflow meta.
  - References: `src/workflow/executor.ts`, `docs/features/workflow-management-agent.md`

- `decisions.jsonl` does not record engine meta (`reasoning`, `confidence`).
  - `ManagementAgentEngineResult.meta` exists but is not propagated to the log entry.
  - References: `src/workflow/management/management-controller.ts`, `src/workflow/management/types.ts`

- HookContext is minimal compared to the proposal.
  - No artifact pointers, no recent decisions, and no structured references to sentinel/convergence artifacts beyond raw payloads.
  - Impact: the agent is incentivized to “scan the filesystem” and is more exposed to prompt injection via untrusted files.
  - References: `src/workflow/management/hook-context-builder.ts`, `docs/features/workflow-management-agent.md`

- Documentation mismatch: “vendored SDK” vs actual import.
  - The proposal mentions `refs/coding-agent-repo/packages/coding-agent/` while the implementation dynamically imports `@mariozechner/pi-coding-agent`.
  - Impact: packaging expectations and reproducibility differ; compiled/bundled deployments need a clear story.
  - References: `docs/features/workflow-management-agent.md`, `src/workflow/management/pi-sdk-engine.ts`

## Recommended Next Steps (ordered)

1) Make event isolation real by moving filtering/routing to the layer that emits `worker_event`/`worker_result`.
   - Ensure management hook executions never update Sentinel activity tracking and never land in the main telemetry stream.
   - References: `src/workflow/multi-worker-step-runner.ts`, `src/workflow/executor.ts`

2) Unify directive validation across engines.
   - Pi tool call output should be validated with the same schema checks as file-based decisions (required fields, length caps, staleness/correlation).
   - References: `src/workflow/management/pi-sdk-engine.ts`, `src/workflow/management/decision-resolver.ts`

3) Fix runaway guard semantics (`max_consecutive_interventions`) so it degrades to safe `proceed` without permanently disabling management.
   - References: `src/workflow/management/management-controller.ts`

4) Wire missing hooks and config resolution paths.
   - Implement `pre_check` (and check-timeout override) and resolve `management.agent.agent` from the agent catalog.
   - References: `src/workflow/executor.ts`, `src/workflow/parser.ts`

5) Align the instruction overlay behavior with the proposal or update the proposal to match actual semantics.
    - If “per iteration” matters, add a hook point at the top of the iteration loop.
    - References: `src/workflow/executor.ts`, `docs/features/workflow-management-agent.md`

## Resolution Notes (2026-02-27)

Re-verification (2026-02-27): performed a code audit + full test re-run to confirm all P0/P1/P2 fixes. All verification commands listed in “Update status / Current verification” above. Key touch points: `src/workflow/executor.ts`, `src/workflow/management/management-controller.ts`, `src/workflow/management/worker-engine.ts`, `src/workflow/management/management-event-sink.ts`, `src/workflow/management/pi-sdk-engine.ts`, `src/workflow/management/directive-validator.ts`, `src/workflow/management/decision-resolver.ts`, `src/workflow/management/hook-context-builder.ts`, `src/workflow/parser.ts`.

### P0 fixes — ALL VERIFIED (2026-02-27)

- Management worker event isolation is enforced.
  - Management worker runs use a dedicated event sink (`ManagementEventSink`) that writes to `context/_management/inv/<hook_id>/worker.jsonl` and does not forward events to the main sink. Defense-in-depth: `isManagementEvent()` in executor.ts filters `_management:*` events from the composite sink, preventing leakage to sentinel activity tracker.
  - Verified: `bun test test/unit/workflow/management-engine.test.ts -t “TC-PI-W-08”` — PASS
  - Verified: `bun test test/integration/management-executor.test.ts -t “management worker events do not leak”` — PASS
  - References: `src/workflow/executor.ts`, `src/workflow/core-ipc-step-runner.ts`, `src/workflow/multi-worker-step-runner.ts`, `src/workflow/management/worker-engine.ts`, `src/workflow/management/management-event-sink.ts`

- PiSdkEngine directive validation matches WorkerEngine guarantees.
  - Directive shape validation (required fields + bounds) is shared across engines via `validateDirectiveShape()` and applied before executor use. Pi tool-call capture validates in `buildDecisionTool()`.
  - Verified: `bun test test/unit/workflow/management-decision-resolver.test.ts` — PASS (10 tests)
  - Verified: `bun test test/unit/workflow/management-engine.test.ts -t “TC-PI-P-14|TC-PI-P-15”` — PASS (2 tests)
  - References: `src/workflow/management/directive-validator.ts`, `src/workflow/management/decision-resolver.ts`, `src/workflow/management/pi-sdk-engine.ts`, `src/workflow/management/management-controller.ts`

- `max_consecutive_interventions` guard no longer becomes a permanent bypass.
  - Guard bypass forces safe `proceed` for the triggering hook and resets the streak (`management-controller.ts` lines 219-221).
  - Verified: `bun test test/unit/workflow/management-controller.test.ts -t “max_consecutive_interventions”` — PASS
  - References: `src/workflow/management/management-controller.ts`

- PiSdkEngine tool mapping no longer exposes general-purpose command execution.
  - Pi sessions are read-only regardless of declared capabilities (`buildPiTools()` ignores capabilities, only returns read-only tools).
  - Verified: `bun test test/unit/workflow/management-engine.test.ts -t “TC-PI-P-09|TC-PI-P-10”` — PASS (2 tests)
  - References: `src/workflow/management/pi-sdk-engine.ts`

### P1 fixes — ALL VERIFIED (2026-02-27)

- `pre_check` hook is wired and supports `modify_instructions` / `adjust_timeout`.
  - Executor invokes `pre_check` before each completion_check run (lines 1242-1278), applies `managementCheckOverlays` / `checkTimeoutOverrides`.
  - Verified: `bun test test/integration/management-executor.test.ts -t “pre_check”` — PASS (2 tests)
  - References: `src/workflow/executor.ts`

- Management agent catalog reference (`management.agent.agent`) is resolved.
  - Parser validates the agent catalog reference; `resolveManagementConfig()` (lines 741-792) merges resolved profile into worker/model/capabilities/base_instructions.
  - Verified: `bun test test/integration/management-executor.test.ts -t “catalog”` — PASS
  - References: `src/workflow/parser.ts`, `src/workflow/executor.ts`

- Step-level per-hook overrides are supported.
  - Step-level `management.<hook>` booleans override workflow-level hook defaults via `isHookEnabled()` (lines 122-142).
  - Verified: `bun test test/integration/management-executor.test.ts -t “per-hook override”` — PASS (2 tests)
  - References: `src/workflow/management/types.ts`, `src/workflow/parser.ts`, `src/workflow/management/management-controller.ts`

- Instruction overlay behavior supports “replace/clear per iteration” semantics for completion_check loops.
  - `pre_step` is invoked again for completion_check iterations >= 2 (lines 930-992) so management overlays can be replaced/cleared.
  - Verified: `bun test test/integration/management-executor.test.ts -t “TC-MA-E-06”` — PASS
  - References: `src/workflow/executor.ts`

### P2 fixes — ALL VERIFIED (2026-02-27)

- Workflow metadata captures management abort reason text.
  - `buildWorkflowMetaExtras()` (lines 2769-2782) writes `management_abort_reason` when `abortReason === “management”`.
  - Verified: `bun test test/integration/management-executor.test.ts -t “abort reason”` — PASS
  - References: `src/workflow/executor.ts`

- `decisions.jsonl` records engine meta (`reasoning`, `confidence`) when present.
  - `ManagementController.invokeHook()` (lines 333-336) propagates `engineResult.meta.reasoning` / `engineResult.meta.confidence` into `DecisionsLogEntry`.
  - Verified: `bun test test/unit/workflow/management-controller.test.ts -t “engine meta”` — PASS
  - References: `src/workflow/management/types.ts`, `src/workflow/management/management-controller.ts`

- HookContext includes artifact pointers (paths) to reduce agent filesystem scanning.
  - `HookContextBuilder.buildAndWrite()` populates `HookContext.paths` with structured pointers to context_dir, workflow_state_file, management_decisions_log, step_dir, convergence_dir, stall_dir, etc.
  - Verified: `bun test test/unit/workflow/management-hook-context-builder.test.ts` — PASS
  - References: `src/workflow/management/types.ts`, `src/workflow/management/hook-context-builder.ts`

- Documentation mismatch (“vendored SDK” vs actual import) is resolved.
  - `docs/features/workflow-management-agent.md` §15 documents that Roboppi loads Pi via `@mariozechner/pi-coding-agent` (dynamic import) and treats it as an optional dependency; see §15.2 and §15.7 for packaging notes.
  - Verified (2026-02-27): doc text at lines 1460-1464, 1489, 1650 references the real `@mariozechner/pi-coding-agent` packaging/import path.
  - References: `docs/features/workflow-management-agent.md`, `src/workflow/management/pi-sdk-engine.ts`
