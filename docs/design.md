# AgentCore Design Document

AgentCore is an execution-control runtime for AI agent systems. It focuses on safety mechanics and delegates heavy work (editing/running/tests) to external worker processes.

This document describes the conceptual architecture and the invariants the runtime enforces.

## 1. Problem

Event-loop agent automation often fails in predictable ways:

- duplicate LLM/tool invocations
- infinite retries
- cascading failures across dependencies
- hangs that block the entire system

AgentCore aims to make these failure modes harder to trigger by enforcing runtime-level guardrails.

## 2. Key principle: mechanism vs policy

- Core (AgentCore runtime) = mechanism
  - stop, limit, observe, isolate
  - enforces safety invariants that policy cannot override

- Scheduler (supervisor) = policy
  - ordering, dedup strategy, retry decisions, DLQ handling
  - can be swapped depending on operational needs

## 3. Layers

The system has three layers:

1) Scheduler (parent process / supervisor)
2) AgentCore runtime (child process)
3) Workers (external processes)

Workers may include OpenCode, Claude Code, Codex CLI, or custom implementations.

## 4. Core invariants

### 4.1 Nothing runs without a Permit

Execution is gated by Permit issuance. A Permit represents authorization to run a specific attempt of a job under a defined budget.

Permit issuance checks:

- budgets (timeout, max attempts, concurrency, RPS, cost)
- backpressure state
- circuit breaker state

If any check fails, the Permit is rejected.

### 4.2 Cancellation propagates end-to-end

Cancellation flows through the entire stack via AbortSignal/AbortController:

cancel job -> abort permit -> cancel worker adapter -> worker stops (or is killed)

### 4.3 Isolation by process boundary

Heavy operations run in worker processes. This reduces blast radius for:

- CPU/memory exhaustion
- hangs
- tool/CLI crashes

## 5. Data model

### Job

A Job is the unit submitted by the Scheduler.

Typical fields:

- `jobId`
- `type`
- `priority`
- `idempotencyKey` (optional)
- `payload`
- `limits`
- `context`

### Permit

A Permit is issued by the runtime and authorizes a specific attempt.

Typical fields:

- `permitId`
- `jobId`
- `deadlineAt`
- `attemptIndex`
- `abortController`
- `tokensGranted`
- `circuitStateSnapshot`

### WorkerTask

A WorkerTask is the delegated instruction to a worker:

- `workerKind`
- `workspaceRef`
- `instructions`
- `model` (optional)
- `env` (optional)
- `capabilities`
- `budget`
- `abortSignal`

### WorkerResult

Result returned to the runtime:

- status
- artifacts/observations
- logs
- cost metadata

## 6. Failure containment

- Backpressure provides uniform reject/defer/degrade behavior.
- Circuit breakers prevent cascading failures from external providers.
- Watchdog detects stalls and abnormal delays.

## 7. Communication

Scheduler and AgentCore communicate via JSON Lines over stdin/stdout. This keeps the runtime replaceable by other transports later (e.g. gRPC/HTTP).

## 8. Related docs

- Workflow guide: `docs/guide/workflow.md`
- Daemon guide: `docs/guide/daemon.md`
- Architecture guide: `docs/guide/architecture.md`
