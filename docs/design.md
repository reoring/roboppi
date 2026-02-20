# AgentCore Execution-Control Design

**Core/Scheduler separation + Worker Delegation + Scheduler-supervised launch**

---

## Introduction - What This Design Solves

When you run AI agents in an event loop, you tend to hit predictable failure modes: the same LLM request is issued repeatedly and the system gets stuck, retries never stop, failures cascade across dependencies and the whole system stalls, etc.

This document defines an architecture that prevents those problems **mechanically**.

### Problems Addressed

| Problem | Architectural approach |
|------|-------------------------|
| Duplicate execution / stacking of identical LLM requests | Idempotency Keys + dedup policies |
| Infinite retries | Hard limits, backoff, jitter, error classification |
| Cascading fatal failures | Circuit Breaker + escalation + isolation |
| Heavy work blocks the agent runtime | Delegate work to Workers (process isolation) |
| The agent process itself crashes / hangs | Scheduler supervises the child process |

### Assumptions

- Separate the execution system into **Core (mechanism)** and **Scheduler (policy)** so only policy is swappable.
- AgentCore focuses on plan/permit/cancel/observe; actual work is delegated to **Workers (OpenCode / Codex CLI / Claude Code)**.
- The **Scheduler launches and supervises AgentCore as a child process**.

---

## 1. Design Principles

### 1.1 Separate mechanism and policy

The foundation of this design is splitting "mechanism" (enforcement) from "policy" (decisions).

**Core (mechanism)** provides primitives such as "stop", "limit", "observe", and "isolate" and enforces safety invariants. No matter what policy is swapped in, the constraints the Core enforces cannot be broken.

**Scheduler (policy)** makes decisions like execution order, how to handle duplicates, and whether/how to retry. You can swap it depending on operational needs.

### 1.2 Delegation-first (do not hold execution inside the runtime)

AgentCore focuses on **plan, permit, cancel, observe**.

Repository operations, command execution, code generation/edits, and verification are delegated to **external Worker processes**. Isolating heavy work behind a process boundary prevents event-loop stalls from propagating.

---

## 2. Components

The system has three layers.

```
+---------------------------------------------------------------+
| Scheduler (parent process / Supervisor)                        |
|  +---------------------------------------------------------+  |
|  | AgentCore (child process / Runtime)                     |  |
|  |  +-------------+   +----------------------------------+ |  |
|  |  | Permit Gate |   | Worker Delegation Gateway         | |  |
|  |  | Watchdog    |   |  +----+ +----+ +----+             | |  |
|  |  | CB          |   |  | W1 | | W2 | | W3 |             | |  |
|  |  | Escalation  |   |  +----+ +----+ +----+             | |  |
|  |  +-------------+   +----------------------------------+ |  |
|  +---------------------------------------------------------+  |
+---------------------------------------------------------------+

W1 = Codex CLI / W2 = Claude Code / W3 = OpenCode
```

### 2.1 Scheduler (parent process / Supervisor)

The Scheduler treats AgentCore as "one worker process". It is swappable, but the supervision role is close to mandatory in practice.

Responsibilities:

- **Launch and supervise the AgentCore process**
  - spawn the process, connect stdin/stdout IPC
  - health checks (latency, memory, CPU thresholds)
  - restart on hang, overload, or abnormal exit
  - log collection, crash-dump collection (optional)
- **JobQueue management**: priority, fairness, delayed execution
- **InFlightRegistry**: duplicate control (coalesce / latest-wins / reject)
- **RetryPolicy**: retry decisions based on error classification (but hard limits are enforced by Core)
- **DLQ / reinsertion strategy**: storage and recovery flow

Note: In out-of-process deployments, the Scheduler can also horizontally scale multiple AgentCore instances for scale-out and failure isolation.

### 2.2 Core (AgentCore runtime / child process)

Core responsibilities are fixed: it enforces safety invariants independent of policy.

| # | Responsibility | Summary |
|---|------|------|
| 1 | **Cancellation** | unify cancellation via AbortSignal/AbortController |
| 2 | **Execution Budget Gate** | enforce timeout / maxAttempts / concurrency / RPS / cost |
| 3 | **Backpressure API** | unified reject/defer/degrade behavior under load |
| 4 | **Watchdog** | detect stalls, delays, and failure concentration |
| 5 | **Circuit Breaker (CB)** | cut off cascading failures of dependencies (LLM providers, worker providers, etc.); final authority |
| 6 | **Escalation Manager** | isolate/stop/notify based on severity |
| 7 | **Observability** | structured logging, traceId, required metrics fields |
| 8 | **Worker Delegation Gateway** | delegate to workers (start/cancel/result collection) |

Important: Core does not have to hold a queue, but it must hold the authority to issue **Permits** (execution authorization) and the authority to cancel. Workers must not run without a Permit.

### 2.3 Workers (external agents)

Workers provide execution environments and capabilities. AgentCore calls them through a unified protocol.

| Worker | Characteristics |
|--------|------|
| **Codex CLI** | local agent that can read/edit code and run commands |
| **Claude Code** | coding assistant that runs in terminals/IDEs/CI |
| **OpenCode** | supports subagents invoked by a primary agent for specialization |

---

## 3. Launch Model - Scheduler launches AgentCore

### 3.1 Parent/child relationship

```
Scheduler (parent)
  |
  +-- spawn(roboppi, args...)
  +-- JSON Lines IPC over stdin/stdout
  +-- periodic heartbeat/health monitoring
  |
  +-> Roboppi Core (child)
       +-- processes externally submitted jobs
       +-- issues permits and delegates to workers
       +-- observes, limits, cuts off, escalates
```

The Scheduler spawns Roboppi Core as a child process, keeps stdin/stdout open, and uses **JSON Lines** for bidirectional communication. It monitors response latency via heartbeat and checks memory/CPU thresholds periodically.

Roboppi Core behaves as a runtime that processes "jobs given from outside", issues Permits, and spawns/uses workers as needed.

### 3.2 Crash / hang handling (Supervisor policy)

| Situation | Handling |
|------|------|
| **child process crashes** | treat in-flight jobs as failed on the scheduler side; re-enqueue or send to DLQ |
| **child process hangs** | parent sends SIGTERM -> grace period -> SIGKILL (grace period is a policy setting) |
| **crash loop** | isolate the AgentCore instance (CB-like), fail over to another instance |

---

## 4. Data Model

### 4.1 Job - a request created by the Scheduler

A Job is the unit of work created by the Scheduler and submitted to AgentCore.

```
Job {
  jobId         : UUID
  type          : LLM | TOOL | WORKER_TASK | PLUGIN_EVENT | MAINTENANCE ...
  priority      : integer + class (interactive / batch, etc.)
  key?          : Idempotency Key (for dedup)
  payload       : input (prompt, tool args, worker instructions, etc.)
  limits        : requested budgets (timeoutMs, maxAttempts, costHint)
  context       : traceId, correlationId, userId?, sessionId?
}
```

### 4.2 Permit - execution authorization issued by Core

A Permit is the execution authorization issued by Core. Without it, neither Jobs nor Workers run.

```
Permit {
  permitId              : UUID
  jobId                 : UUID
  deadlineAt            : timestamp
  attemptIndex          : attempt number
  abortController       : newly created per attempt
  tokensGranted         : concurrency / RPS / cost quota
  circuitStateSnapshot  : CB state at issuance
}
```

### 4.3 WorkerTask - delegation unit (Core -> Worker)

WorkerTask is the instruction packet passed from AgentCore to a Worker.

```
WorkerTask {
  workerTaskId   : UUID
  workerKind     : CODEX_CLI | CLAUDE_CODE | OPENCODE | CUSTOM
  workspaceRef   : target repo/directory (mount/chdir strategy)
  instructions   : instructions (natural language + constraints)
  capabilities   : allowed actions (e.g. read / edit / run_tests)
  outputMode     : stream | batch
  budget         : deadlineAt, maxSteps?, maxCommandTimeMs?
  abortSignal    : derived from Permit (propagate cancellation)
}
```

### 4.4 WorkerResult - result (Worker -> Core)

WorkerResult is the execution result returned by the Worker.

```
WorkerResult {
  status        : SUCCEEDED | FAILED | CANCELLED
  artifacts     : patches, diffs, logs, references to generated outputs
  observations  : executed commands, changed file list (for audit)
  cost          : estimated / measured (if available)
  errorClass?   : classification for retry decisions
}
```

---

## 5. Interface Design (IPC / SPI)

IPC is based on **stdin/stdout JSON Lines**, but is designed to be replaceable with gRPC/HTTP later.

### 5.1 Scheduler -> AgentCore (submit jobs)

| Method | Description |
|---------|------|
| `submit_job(job)` -> `ack(jobId)` | submit a job to AgentCore |
| `cancel_job(jobId | key, reason)` | request job cancellation |
| `report_queue_metrics(...)` | report queue lag/backlog metrics (optional) |

### 5.2 Scheduler -> Core (request execution permit)

| Method | Description |
|---------|------|
| `request_permit(job, attemptIndex)` -> `Permit | Rejected(reason)` | request a Permit from Core |

Possible values for `Rejected.reason`:

`QUEUE_STALL` / `CIRCUIT_OPEN` / `RATE_LIMIT` / `GLOBAL_SHED` / `FATAL_MODE`

### 5.3 Core -> Scheduler (result notifications)

| Method | Description |
|---------|------|
| `on_job_completed(jobId, outcome, metrics, errorClass?)` | notify job completion |
| `on_job_cancelled(jobId, reason)` | notify job cancellation |
| `on_escalation(event)` | notify escalation events |

### 5.4 Core -> Worker (delegation protocol via WorkerAdapter)

Core contains a **WorkerAdapter layer** to absorb differences across external tools.

| Method | Description |
|---------|------|
| `start_worker_task(workerTask)` -> `handle` | start a worker task |
| `stream_events(handle)` -> `{stdout, stderr, progress, patches...}` | stream events |
| `cancel(handle)` | cancel the task (coupled to Permit abort) |
| `await_result(handle)` -> `WorkerResult` | wait for and collect result |

Note: WorkerAdapter unifies process launch / IO / cancellation so Codex CLI / Claude Code / OpenCode are handled under the same contract.

---

## 6. Worker Delegation

### 6.1 Why delegation is required (runaway/stall containment)

If AgentCore directly performs "huge JSON processing", "long-running LLM calls", or "external command execution", event-loop delays and stalls hit the runtime itself.

By running Workers as **separate processes**, we get:

- **Localized blast radius**: CPU/memory/FD exhaustion does not propagate into AgentCore
- **OS-level hard stop**: hung workers can be killed
- **Precise concurrency control**: enforced via Permits

### 6.2 How each worker is used

**Codex CLI:**
Run inside a fixed `workspaceRef`. Collect changes via diff/patch, and optionally run PR/commit creation as separate jobs.

**Claude Code:**
Launch with injected system prompt and agent settings. Recommend explicit file targets for reproducibility.

**OpenCode:**
Assign subagents by task kind (e.g. Explore for investigation, General for edits). A staged pattern (plan -> explore -> implement -> verify) is possible.

### 6.3 End-to-end cancellation propagation

Cancellation must flow through the entire system.

```
Job cancelled (latest-wins / cancel / timeout)
  |
  v
Permit.abort fires
  |
  v
Core calls WorkerAdapter.cancel
  |
  v
Worker process stops safely (or force-killed)
```

Design stance: "Workers that cannot be stopped" are a design defect. Do not adopt them, or isolate them in a sandbox.

### 6.4 Security boundaries (recommended)

| Mitigation | Description |
|------|------|
| **Constrain workspace** | limit read/write scope to a dedicated directory |
| **Command allowlist** | restrict runnable commands (e.g. `go test`, `cargo test`, `npm test`) |
| **Secret isolation** | avoid passing secrets as env vars; use separate vault-fetch jobs |
| **Audit logging required** | record executed commands, changed files, diff summary, execution time |

---

## 7. Preventing duplicate LLM execution stacks

Use **Idempotency Keys** to prevent repeated identical requests.

### 7.1 Idempotency Key formats

**For LLM requests:**

```
{provider}:{model}:{promptHash}:{toolStateHash}:{userTurnId?}
```

**For worker tasks:**

```
{workerKind}:{workspaceHash}:{taskHash}:{inputsHash}
```

### 7.2 Dedup control flow

Scheduler-side InFlightRegistry detects duplicates by Idempotency Key and applies the policy (coalesce / latest-wins / reject).

Core enforces **Budget / Circuit Breaker / Watchdog** regardless of whether an Idempotency Key exists.

---

## 8. Retry control - preventing infinite retries

### 8.1 Constraints enforced by Core (invariants)

Core always enforces the following. Scheduler policy cannot override these constraints.

- `maxAttempts`: absolute upper bound on attempts
- `timeoutMs`: timeout per attempt
- `retryBudget`: runaway control across time/cost

The same is enforced for WorkerTask. "An infinite loop where tests keep failing" is stopped here.

### 8.2 Policy decided by Scheduler (swappable)

- **Retryability based on error classification**
  - 429 (rate limit) / 5xx (server error) / network errors -> retryable
  - persistent worker-caused failures (lint/tests always fail) -> usually non-retryable (policy-dependent)
- **Backoff strategy**
  - recommend exponential backoff + full jitter

---

## 9. Circuit Breaker (expanded scope)

Expand the Core's Circuit Breaker scope to cover not only LLM providers but also worker providers.

### 9.1 Targets

| Target | Example that trips CB |
|------|------------------------|
| LLM provider / model | errors concentrated on a specific model |
| **Worker provider** | Codex CLI frequently crashes |
| | Claude Code stops responding for a while |
| | OpenCode becomes abnormally slow / runaway |

### 9.2 Behavior

When CB is OPEN, `request_permit` is rejected. The Scheduler can fall back to another Worker.

---

## 10. Watchdog - stall detection

Add worker-related metrics to what Core observes.

### 10.1 Metrics

| Metric | What it measures |
|------|-------------------|
| `worker_inflight_count` | number of worker tasks currently running |
| `worker_queue_lag_ms` | worker queue lag |
| `worker_timeout_rate` | worker task timeout rate |
| `worker_cancel_latency_ms` | time until cancel takes effect |
| `workspace_lock_wait_ms` | contention wait time for same-workspace edits |

### 10.2 Automatic defense

When thresholds are exceeded, defenses escalate in stages: shed (drop load) -> throttle (limit throughput) -> CB OPEN -> escalation.

---

## 11. Escalation - handling fatal failures

### 11.1 FATAL conditions (including workers)

Add worker-related conditions in addition to existing fatal triggers.

- Worker crashes repeatedly in a short time (N times per minute)
- cancel does not work and "ghost processes" remain
- too many latest-wins cancellations against the same workspace (changes do not converge)

### 11.2 Actions

| Scope | Example action |
|---------|-------------|
| `scope=workerKind` | isolate a specific worker kind (stop that kind) |
| `scope=workspace` | lock/isolate a workspace (stop operating on that repo) |
| `scope=global` | safe stop the entire system |

---

## 12. Boundary clarification - what lives where

### 12.1 What can live in the Scheduler (policy)

- JobQueue / InFlightRegistry / retry strategy / DLQ
- AgentCore launch supervision (Supervisor)
- horizontal management of multiple AgentCore instances (pooling/sharding)

### 12.2 What must remain in Core (invariants)

- enforce Permit and budget
- cancellation via AbortSignal (also propagated to workers)
- final authority for Circuit Breaker (LLM and workers)
- Watchdog and Escalation
- minimum required observability fields

### 12.3 What should be pushed to Workers (actual work)

- code edits, command execution, tests, static analysis, diff generation
- optional summarization of work logs (but final decisions remain in Core/Scheduler)

---

## 13. Implementation notes (Bun + process boundary)

- Implement AgentCore naturally as a JSON Lines server: input = jobs, output = events
- Unify WorkerAdapter management via Bun `spawn`, AbortSignal, and timeouts
- Observe worker stdout/stderr as streams and let Watchdog use them to detect stalls
- Place workspace locking either in WorkerAdapter or Scheduler policy. Recommended split: policy in Scheduler, enforcement in Core.

---

## 14. Test Plan

| # | Test item | What to verify |
|---|-----------|---------|
| 1 | **Worker delegation** | WORKER_TASK does not run without a Permit |
| 2 | **Cancellation propagation** | cancel/latest-wins stops the worker process and leaves no residue |
| 3 | **Worker CB** | concentrated worker failures -> OPEN -> fallback to other workers occurs |
| 4 | **Workspace contention** | concurrent edits on same repo do not conflict and follow policy (reject/coalesce/serialize) |
| 5 | **Supervisor restart** | kill AgentCore -> scheduler restarts -> incomplete jobs are re-enqueued / routed to DLQ correctly |

---

## 15. Design validation

Below are notes from validating this design.

### 15.1 Strengths (why the design is sound)

**Mechanism/policy separation is healthy.** The separation between Core-held invariants (Permit, cancellation, final CB authority) and Scheduler-held policy (priority, retry decisions, DLQ) is clear and preserves swappability.

**Worker process isolation is effective blast-radius containment.** Localizing CPU/memory exhaustion and hangs to worker processes is a sound approach for event-loop agent systems.

**Cancellation propagation is consistent.** A single chain Job -> Permit -> WorkerAdapter -> Worker process reduces the risk of unstoppable work remaining.

**Expanding CB to workers is appropriate.** Applying CB not only to LLM providers but also to worker providers prevents a single degraded worker from destabilizing the system.

### 15.2 Risks / areas needing clarification

**Permit issuance flow between Scheduler and Core is ambiguous.** The design defines Scheduler calling `request_permit` and Core returning a Permit, but it also defines `submit_job` as a job submission route. With two paths, it is unclear when to use which. Add a sequence diagram clarifying the timing of submission vs permit requests.

**JSON Lines IPC error handling is unspecified.** The design does not specify handling for transport-level failures (parse errors, mid-stream disconnects, buffer overflow). It is natural for Supervisor logic to detect and react, but the protocol needs specification.

**Grace period for safe stop -> force kill is unspecified.** After cancel, the grace period before kill is not concretely defined. The design includes `worker_cancel_latency_ms` as a watchdog metric, but thresholds and stages (SIGTERM -> grace -> SIGKILL) must be decided during implementation.

**Workspace lock responsibility split is only a recommendation.** The doc recommends "policy in Scheduler, enforcement in Core", but does not define which operation acquires the lock and when it is released. Concurrent edits to the same repo are common; define lock granularity (file/dir/repo) and acquire/release protocol.

**DLQ recovery flow is abstract.** It is not clear how jobs in DLQ are reinserted (manual/automatic/conditional). In operations, you need visibility and a reinsertion interface.

### 15.3 Overall evaluation

Overall, the architecture direction is sound. In particular, separating "Core enforces invariants" from "Scheduler decides policy", and delegating heavy work behind a process boundary, directly address the operational failure modes of event-loop AI agent systems. The risks above can be resolved during implementation.

---

## Appendix: Quotes and sources

### A) Codex CLI can read, modify, and run code locally

> "Codex CLI is OpenAI's coding agent that you can run locally from your terminal. It can read, change, and run code on your machine in the selected directory."

Source: [OpenAI Developers - Codex CLI](https://developers.openai.com/codex/cli/)

This supports the idea that AgentCore can delegate actual work (edit/run) to an external worker while constraining the workspace.

### B) Claude Code runs across terminals/IDEs/CI

> "Claude Code is also available on the web, as a desktop app, in VS Code and JetBrains IDEs, in Slack, and in CI/CD with GitHub Actions and GitLab."

Source: [Claude Code - Quickstart](https://code.claude.com/docs/en/quickstart)

This leaves room to expand beyond CLI-only workers. In this design, we start from process-boundary CLIs for WorkerAdapter.

### C) OpenCode has subagents

> "Subagents are specialized assistants that primary agents can invoke for specific tasks."

Source: [OpenCode - Agents](https://opencode.ai/docs/agents/)

This supports an architecture where delegation is not limited to a single general worker, but can be split across specialized subagents.

### D) Codex CLI can read a repository, make edits, and run commands

> "Codex launches into a full-screen terminal UI that can read your repository, make edits, and run commands as you iterate together."

Source: [OpenAI Developers - Codex CLI features](https://developers.openai.com/codex/cli/features/)

Even when workers are interactive UIs, AgentCore can focus on Permit/cancel/audit/result collection and avoid bringing execution heaviness into the runtime.
