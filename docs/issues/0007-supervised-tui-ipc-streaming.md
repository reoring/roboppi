# Supervised TUI: Logs tab is empty (no real-time monitoring) / IPC streaming extension proposal

Status: design proposal (not implemented)

## Problem

When running `roboppi workflow ... --supervised --tui` (supervised: Supervisor -> Core IPC -> Worker), the TUI `2: Logs` tab does not show stdout/stderr/progress.

Expected behavior:

- In TUI `2: Logs`, track stdout/stderr/progress produced by the agent/worker in real time
- In `3: Diffs`, (if possible) see patches/diffs generated during execution in real time

Current behavior:

- In supervised mode, `2: Logs` is almost always empty ("No logs yet")
- The TUI mainly shows `phase` and the final `Result` (the `result` in `job_completed`)

Relevant files (TUI rendering side):

- `src/tui/components/tabs/logs-tab.ts`
- `src/tui/state-store.ts`
- `src/tui/exec-event.ts`

## Root Causes (Key points)

1) No `ExecEvent: worker_event` in the supervised path

- `TuiStateStore` updates `step.logs.stdout/stderr/progress` upon receiving `ExecEvent.worker_event` (`src/tui/state-store.ts`).
- But the supervised StepRunner (`CoreIpcStepRunner`) only receives the final result (`job_completed`) from Core; there is no path for receiving stdout/stderr/progress as events during execution.

2) The IPC protocol has no "job streaming event" messages

- `OutboundMessage` (Core -> Supervisor) in `src/types/ipc-messages.ts` has `job_completed`, but no streaming notifications for stdout/stderr/progress/patch.

3) Core does not consume `WorkerAdapter.streamEvents()` either

- Core only waits on `adapter.awaitResult()` through `src/worker/worker-gateway.ts` and does not iterate `adapter.streamEvents()`.
- So even if an adapter can stream, the supervised path does not use it.

Note:

- `OutputMode.STREAM` exists (`src/types/worker-task.ts`), but supervised job payload currently uses `BATCH` unconditionally (`src/workflow/core-ipc-step-runner.ts`).

## Goals

- Keep supervised mode (no `--direct`) and update TUI `2: Logs` in real time
- Safely forward `stdout/stderr/progress/patch` events from Core to Supervisor over IPC
- Keep the invariant that stdout is JSONL IPC only (do not mix non-JSON)
- Preserve backward compatibility (new Core/old Runner, new Runner/old Core should not break)

## Proposal: asynchronously stream job events from Core -> Supervisor

### New IPC message (Core -> Supervisor)

Add a new outbound IPC message, e.g. `job_event`.

Important:

- Do not include `requestId` (IpcProtocol request/response correlation is `requestId`-based; async events must be out of band)

Type sketch:

```ts
// src/types/ipc-messages.ts
import type { WorkerEvent } from "../worker/worker-adapter.js";

export interface JobEventMessage {
  type: "job_event";
  jobId: UUID;
  ts: number;
  seq: number;
  event: WorkerEvent;
}
```

Design notes:

- `seq` is monotonically increasing per `jobId`, making ordering reconstruction easier if needed.
- forward `WorkerEvent` with the same shape as `src/worker/worker-adapter.ts`.

### Data flow (Overview)

- Supervisor (Runner)
  - sends `submit_job` / `request_permit` / `cancel_job` (existing)
  - receives new `job_event`, routes to the correct step, and forwards to the TUI sink
  - receives existing `job_completed` and finalizes the result

- Core
  - receives a job and delegates to a Worker (existing)
  - consumes `adapter.streamEvents()` during execution and sends `job_event` for each event (new)
  - on completion, sends `job_completed` (existing)

## Implementation Design (By component)

### A) IPC layer

- `src/types/ipc-messages.ts`
  - add `JobEventMessage` and include it in `OutboundMessage`
- `src/ipc/protocol.ts`
  - add a thin helper like `sendJobEvent(jobId, ts, seq, event)` (wrap `transport.write`)
  - extend `validateMessage()` to validate required `job_event` fields (for safety)

Compatibility:

- old Runner ignores unknown messages (no handler), so a new Core sending `job_event` does not break it
- old Core simply does not send `job_event`; new Runner continues to work (no real-time logs)

### B) Core side (source of streaming)

Current Core execution (`src/core/agentcore.ts`) only waits for the final result via `workerGateway.delegateTask(...)` and does not emit events.

Proposal:

1) Add an event-capable API to `src/worker/worker-gateway.ts`

- e.g. `delegateTaskWithEvents(task, permit, { onEvent })`
- implementation: after `adapter.startTask()`, concurrently run `for await (const ev of adapter.streamEvents(handle)) onEvent(ev)`, and then await `adapter.awaitResult(handle)`
- keep existing responsibilities in WorkerGateway (workspace lock / abort wiring / deadline timers)

2) Call `delegateTaskWithEvents` from `src/core/agentcore.ts`

- enable event forwarding only when `WorkerTask.outputMode === OutputMode.STREAM`
- inside `onEvent`, call `protocol.sendJobEvent(jobId, ...)`

Note:

- avoid heavy `await` inside event send paths to prevent stalling Core; add per-job send queue/limits (see below)

### C) Supervisor side (bridge into the TUI)

Target:

- `src/workflow/core-ipc-step-runner.ts`

Proposal:

- register IPC handler: `ipc.onMessage("job_event", (msg) => ...)`
- keep a `jobId -> stepId` map within the `runWorkerTask` scope
- on `job_event`, look up `stepId` and emit to the TUI sink as `ExecEvent: worker_event`:

```ts
this.sink.emit({
  type: "worker_event",
  stepId,
  ts: msg.ts,
  event: msg.event,
});
```

Then `src/tui/state-store.ts` updates `step.logs.*`, and `src/tui/components/tabs/logs-tab.ts` can render them.

### D) When to enable `OutputMode.STREAM`

Minimal policy:

- when `--tui` and `--supervised` are set, set `outputMode=STREAM` in the job payload sent to Core

Candidate implementation location:

- `buildWorkerJob()` in `src/workflow/core-ipc-step-runner.ts` (currently hard-coded to `BATCH`)

Future option design:

- add an explicit opt-in like `ROBOPPI_TUI_STREAM_STDIO=1`
- default ON for progress/patch, default OFF for stdout/stderr (reduce secret leakage risk)

## Backpressure / limits / security

Unlimited stdout/stderr streaming can cause:

- IPC stalls (JSONL writes delayed)
- increased memory (queues/buffers)
- TUI ring buffer overflow (events are dropped eventually, but transfer cost remains)

Recommended minimum controls:

1) per-event size cap (Core)

- truncate `data/message/diff` per event (e.g. 16KB)
- separate cap for `patch.diff` (e.g. 256KB)

2) per-job send queue cap (Core)

- keep per-job queue limit (e.g. 500 events); drop on overflow
- when dropping starts, emit a single progress note like "(logs dropped)" (avoid spam)

3) progress thinning (Core)

- send only the latest value every N ms (e.g. 100ms)

4) stdout/stderr default OFF (recommended)

- default for supervised TUI: `progress` + `patch` only
- `stdout/stderr` require explicit opt-in (env var or CLI)

Rationale:

- stdout/stderr may contain secrets (tokens, keys, customer data)
- reliable redaction on the Roboppi side is difficult

## Test Plan (Draft)

- unit:
  - `validateMessage(job_event)` validates required fields
  - truncation / drop-on-overflow behave as expected

- integration (supervised):
  - a fake worker emits progress/stdout at intervals
  - Runner receives `job_event` and calls `sink.emit(worker_event)`
  - verify TUI state store accumulates logs

## Acceptance Criteria

- in supervised + TUI, `2: Logs` updates during execution
- progress appears within 1s (feels real-time)
- the process does not hang under heavy logs (no IPC timeout / no runaway memory)
- default behavior for `--no-tui` (BATCH) remains

## Recommended Implementation Steps

1) add `job_event` to IPC (types + protocol helper + `validateMessage`)
2) Core: add `delegateTaskWithEvents` to WorkerGateway, and have AgentCore send `job_event` under `OutputMode.STREAM`
3) Runner: subscribe to `job_event` in `CoreIpcStepRunner` and translate to `ExecEvent: worker_event` for the sink
4) Runner: enable `outputMode=STREAM` in TUI mode (default: progress/patch only)
5) (optional, UX) make `OpenCodeAdapter` / `ClaudeCodeAdapter` yield stderr incrementally (some implementations currently batch until the end)

## Related

- `docs/wip/tui/ipc-streaming.md` (WIP scratchpad for supervised streaming)
