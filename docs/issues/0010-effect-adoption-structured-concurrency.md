# Adopt Effect for structured concurrency (reduce Promise.race / AbortSignal / timer complexity)

Status: proposal (incremental adoption; no API-breaking rewrite)

## Problem

Roboppi currently implements cancellation / timeouts / concurrency using a mix of:

- `AbortController` / `AbortSignal` listeners
- `setTimeout` / `clearTimeout`
- `Promise.race` / ad-hoc backoff loops
- manual cleanup in `finally` blocks

This is workable but has predictable failure modes as complexity grows:

1) duplicated patterns with subtle differences
- `waitForAbort`, `sleep(ms, signal)`, `createScopedAbort`, and repeated `Promise.race([...])` exist in multiple places

2) cleanup correctness is hard to audit
- listeners and timers must be removed on *every* exit path
- request maps / waiter maps can leak when new early-return paths are added

3) error handling is fragmented
- some paths intentionally suppress unhandled rejections (`p.catch(() => {})`)
- some timeouts are modeled as exceptions, others as sentinel values (e.g. `null`)

4) concurrency semantics are implicit
- cancellation propagation (parent abort -> child operations) is often implemented manually
- multi-step flows (submit_job -> permit -> execute -> cancel) interleave timeouts and cancellation in ways that are hard to reason about

Representative hotspots:

- `src/workflow/core-ipc-step-runner.ts` (multiple races + scoped abort + cancel best-effort)
- `src/ipc/protocol.ts` (`pendingRequests` + timers + fast-fail on disconnect)
- `src/worker/process-manager.ts` (graceful shutdown uses multiple races / timeouts)
- `src/scheduler/supervisor.ts` (spawn + transport bridging has several `new Promise` blocks)

## Goals

1) make cancellation / timeout behavior explicit and composable
2) centralize cleanup via structured resource management
3) reduce `Promise.race` / timer / listener boilerplate and the chance of leaks
4) keep external behavior stable (Promise-returning public APIs can remain)
5) preserve Bun + ESM runtime compatibility

## Proposed Approach (Effect-TS)

Adopt `effect` (Effect-TS) for *internal* concurrency primitives:

- interruption-aware async boundaries: `Effect.async((resume, signal) => ...)`
- timeouts: `Effect.timeout` / `Effect.timeoutFail`
- racing: `Effect.race`
- structured finalization: `Effect.acquireRelease` (Scope)
- retry/backoff: `Effect.retry` + `Schedule` (exponential + jitter)
- structured concurrency: fibers (`Effect.fork`, `Fiber.interrupt`, `Effect.all/forEach` with concurrency)

Key idea: do not rewrite the entire codebase to be Effect-first. Instead:

- keep call sites `async/await`-friendly by bridging at module boundaries (`Effect.runPromise`)
- move the most fragile Promise patterns behind small, well-tested Effect helpers

## Migration Plan (Staged)

### Phase 0: feasibility + footprint

- Add dependency: `bun add effect`
- Validate Bun+ESM integration in CI (`make typecheck`, `make test`)
- Decide a minimal internal wrapper surface (avoid importing many submodules everywhere)

Deliverable:

- new internal module (name TBD) that provides a tiny bridge layer
  - `runPromise` wrapper
  - `sleep`, `waitForAbort`, `withTimeout`, `raceAbort`, etc.

### Phase 1: IPC request/response waiter (highest leverage)

Target: `src/ipc/protocol.ts` `waitForResponse()`.

Replace the manual `{ timer, pendingRequests Map }` pattern with an Effect-based implementation:

- register waiter in a single place
- guarantee cleanup in a finalizer (remove from map + clear timer)
- fail-fast on transport close without callers needing to add special logic

Keep `waitForResponse()` returning `Promise<unknown>` for now:

- internal: Effect
- boundary: `Effect.runPromise`

### Phase 2: Core IPC step flow (submit/permit/execute/cancel)

Target: `src/workflow/core-ipc-step-runner.ts`.

Goals:

- remove ad-hoc races (`Promise.race([completionPromise, waitForAbort(...)])`)
- model cancellation and timeouts as interruption and structured timeouts
- guarantee listener cleanup in one place

Nice-to-have:

- express "best-effort cancel then wait up to 5s for completion" as a clear combinator

### Phase 3: Process lifecycle (spawn + graceful shutdown)

Target: `src/worker/process-manager.ts`.

Replace multi-race shutdown logic with:

- `acquireRelease` for registration and abort-listener lifecycle
- `timeoutFail` for grace windows
- clear modeling of escalation: SIGTERM -> SIGKILL -> "stuck" fallback

### Phase 4: Supervisor spawn / transport bridging

Target: `src/scheduler/supervisor.ts`.

This file has several promise-wrapped callbacks and error/close paths.

- wrap callback-style writes / server close into `Effect.async`
- make cleanup uniform (close server, rm temp dirs) via finalizers

### Phase 5 (Optional): Workflow-level structured concurrency

Target: `src/workflow/executor.ts`.

This is the biggest payoff but also the biggest rewrite.

- model step execution with fibers and a concurrency limit using `Effect.forEach(..., { concurrency })`
- ensure workflow abort interrupts all child fibers
- keep existing `ExecEventSink` emission semantics

## Acceptance Criteria

1) `make typecheck` passes
2) `make test` passes
3) no regressions in cancellation semantics:
- parent abort cancels in-flight waits without leaking listeners/timers
- step deadlines still apply to worker budget the same way as today
4) no unbounded growth in internal maps (`pendingRequests`, waiters)
5) new helpers have unit tests for:
- timeout
- interrupt
- finalizer cleanup on all exit paths

## Non-goals

- converting the entire codebase to functional style
- introducing Effect contexts (Layers/Services) across the whole runtime immediately
- replacing existing logging/telemetry wholesale

## Risks & Mitigations

1) learning curve / mixed paradigm
- mitigate by keeping Effect usage behind a small internal helper layer at first

2) new dependency footprint
- mitigate by limiting surface imports and using staged adoption

3) subtle semantic drift (e.g., timeouts vs cancellation)
- mitigate via tests that assert current behavior at module boundaries

4) stack traces / debugging ergonomics
- mitigate by enabling Effect tracing only where needed and preserving existing error messages

## Reference

- Effect docs: https://github.com/Effect-TS/effect
- Related: `docs/issues/0005-supervised-ipc-submit-job-timeout.md` (IPC timeouts / correlation)
