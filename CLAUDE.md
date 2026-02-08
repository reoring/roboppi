# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AgentCore is an execution control runtime for AI agents. It prevents common failure modes in event-loop-based AI agent systems: duplicate LLM requests, infinite retries, cascading failures, and blocking from heavy processing.

The design document is at `docs/design.md` (written in Japanese).

## Architecture

The system has three layers:

1. **Scheduler (parent process / Supervisor)** — Spawns and supervises AgentCore as a child process. Manages the JobQueue, InFlightRegistry (dedup via idempotency keys with coalesce/latest-wins/reject policies), RetryPolicy, and DLQ. This layer is policy and is swappable.

2. **Core / AgentCore (child process / Runtime)** — Enforces safety invariants that no policy can override: Permit issuance (execution gate), cancellation via AbortSignal/AbortController, execution budget (timeout/maxAttempts/concurrency/RPS/cost), backpressure, Circuit Breaker (for both LLM and Worker providers), Watchdog (stall/delay/failure detection), Escalation Manager, observability, and the Worker Delegation Gateway.

3. **Workers (external agents)** — Execute actual work (code editing, command execution, test running). Supported worker kinds: Codex CLI, Claude Code, OpenCode. Workers run as separate processes for blast-radius isolation.

### Key Design Principle: mechanism vs. policy

- **Core = mechanism** — Provides primitives: stop, limit, observe, isolate. Safety invariants are always enforced.
- **Scheduler = policy** — Decides execution order, dedup handling, retry logic. Swappable per operational needs.

### Communication

Scheduler ↔ AgentCore communicates via **stdin/stdout JSON Lines IPC** (designed to be replaceable with gRPC/HTTP later).

### Data Model

- **Job** — Work unit created by Scheduler, submitted to AgentCore (has jobId, type, priority, idempotency key, payload, limits, context)
- **Permit** — Execution authorization issued by Core (has deadline, attempt index, abort controller, granted tokens, CB state snapshot). Nothing runs without a Permit.
- **WorkerTask** — Delegation instruction from Core to Worker (has workerKind, workspaceRef, instructions, capabilities, budget, abort signal)
- **WorkerResult** — Execution result from Worker (status, artifacts, observations, cost, error class)

### Cancellation Flow

Cancellation propagates through the entire stack: Job cancel → Permit.abort fires → Core calls WorkerAdapter.cancel → Worker process safely stops (or is force-killed).

## Tech Stack

- **Runtime:** Bun
- **IPC:** JSON Lines over stdin/stdout
- **Process management:** Bun's `spawn` + `AbortSignal` for Worker lifecycle

## Project Status

This is a greenfield project. Only the design document (`docs/design.md`) exists. No source code has been written yet.
