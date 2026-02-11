# Architecture Guide

This guide explains AgentCore's internal architecture at a conceptual level: the layers, invariants, and the main runtime primitives.

## 1. High-level structure (3 layers)

AgentCore is designed as a layered system:

```
Scheduler (policy)
  - Job queue
  - Dedup / coalescing
  - Retry policy
  - DLQ
  - Supervises AgentCore process

AgentCore Runtime (mechanism)
  - Permit gate (execution authorization)
  - Budgets (timeouts, concurrency, RPS, attempts, cost)
  - Backpressure
  - Circuit breakers
  - Watchdog
  - Observability
  - Worker delegation gateway

Workers (execution)
  - OpenCode / Claude Code / Codex CLI / custom
  - Run in separate processes
```

## 2. Design principles

### 2.1 Mechanism vs policy

- Core (AgentCore) provides mechanisms that cannot be overridden: stop, limit, observe, isolate.
- Scheduler provides policy: ordering, dedup strategy, retry decisions.

### 2.2 Delegation-first

AgentCore does not do heavy work inside the runtime. Editing code, running commands, and running tests are delegated to external worker processes.

Benefits:

- Worker CPU/memory spikes do not block the runtime
- Hangs are contained and can be killed
- Capabilities can be constrained per task

### 2.3 Nothing runs without a Permit

All executions require a Permit issued by the runtime. Permit issuance checks:

- budgets (timeouts/concurrency/RPS/attempts)
- backpressure
- circuit breaker state

If any check fails, the Permit is rejected.

## 3. Core data model

- Job: submitted by the Scheduler
- Permit: execution authorization issued by the runtime
- WorkerTask: delegated instruction to a worker
- WorkerResult: worker output and status

## 4. Cancellation flow

Cancellation propagates end-to-end:

```
cancel job
  -> permit abort signal fires
  -> runtime calls adapter cancel
  -> worker process stops (or is killed)
```

## 5. Failure containment

- Backpressure provides uniform reject/defer/degrade behavior when overloaded.
- Circuit breakers prevent cascading failures from external providers (LLMs/workers).
- Watchdog detects stalls and failure concentration.

## 6. Operational entry points

- One-shot task execution: `src/cli.ts run ...`
- Workflow runner: `src/workflow/run.ts <workflow.yaml> --workspace <dir>`
- Daemon: `src/daemon/cli.ts <daemon.yaml>`
