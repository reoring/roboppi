# AgentCore Architecture Guide

This guide explains AgentCore's internal architecture in detail. By understanding the design principles, responsibilities of each layer, and the data flow, you can understand how AgentCore works.

---

## 1. High-level structure - a 3-layer architecture

AgentCore is composed of three layers.

```
+---------------------------------------------------------------+
| Scheduler (parent process / Supervisor)                        |
| JobQueue / InFlightRegistry / RetryPolicy / DLQ                |
|  +---------------------------------------------------------+  |
|  | AgentCore (child process / Runtime)                     |  |
|  | PermitGate / ExecutionBudget                            |  |
|  | CircuitBreaker / Watchdog                               |  |
|  | EscalationManager / BackpressureCtrl                    |  |
|  |  +-----------------------------------------------+      |  |
|  |  | Worker Delegation Gateway                      |      |  |
|  |  | Codex CLI / Claude Code / OpenCode             |      |  |
|  |  +-----------------------------------------------+      |  |
|  +---------------------------------------------------------+  |
+---------------------------------------------------------------+
```

| Layer | Role | Process |
|---------|------|---------|
| **Scheduler** | job management, dedup control, retries, supervising the AgentCore process | parent process |
| **Core (AgentCore)** | enforce safety invariants (Permits, cutoffs, monitoring, cancellation) | child process |
| **Worker** | actual work (code edits, tests, command execution) | external processes |

---

## 2. Design principles

### 2.1 Separate mechanism and policy

The foundation of this design is separating "mechanism" (enforcement) and "policy" (decisions).

- **Core = mechanism**: provides safety invariants such as stop/limit/observe/isolate. No matter what policy is swapped in, Core constraints cannot be broken.
- **Scheduler = policy**: decides ordering, dedup behavior, and retry decisions. Swappable depending on operational needs.

### 2.2 Delegation-first

AgentCore focuses on **plan, permit, cancel, observe**. Actual work such as code edits, running commands, and running tests is delegated to **Workers (external processes)**.

By isolating behind a process boundary:

- worker CPU/memory exhaustion does not propagate into AgentCore
- hung workers can be force-killed at the OS level
- concurrency can be controlled precisely via Permits

### 2.3 Nothing runs without a Permit

This is the most important invariant in AgentCore. All job execution and worker delegation requires acquiring a **Permit**. When issuing a Permit, Budget, Circuit Breaker, and Backpressure are checked, and unsafe requests are rejected.

### 2.4 Consistent cancellation propagation

Cancellation flows end-to-end:

```
Job cancelled
  |
  v
Permit.abortController.abort() fires
  |
  v
Core calls WorkerAdapter.cancel()
  |
  v
Worker process stops safely (or is force-killed)
```

---

## 3. Core layer (AgentCore)

Core enforces safety invariants. It is composed of the components below.

### 3.1 PermitGate - the execution authorization gate

Source: `src/core/permit-gate.ts`

PermitGate issues Permits for all job executions.

```typescript
class PermitGate {
  requestPermit(job: Job, attemptIndex: number): Permit | PermitRejection;
  completePermit(permitId: UUID): void;
  cancelPermit(permitId: UUID): void;
  dispose(): void;
}
```

`requestPermit()` checks in this order:

1. **Backpressure** - check system load state (REJECT => immediate reject)
2. **Circuit Breaker** - check CB snapshot (any OPEN => reject)
3. **ExecutionBudget** - check concurrency, RPS, cost, attempts

Only if all checks pass does it return a `Permit`. A Permit contains an `abortController`, which is the root of cancellation propagation.

Permit shape:

```typescript
interface Permit {
  permitId: UUID;
  jobId: UUID;
  deadlineAt: Timestamp;            // timeout timestamp
  attemptIndex: number;             // attempt number
  abortController: AbortController; // cancellation control
  tokensGranted: PermitTokens;      // granted resource quota
  circuitStateSnapshot: Record<string, CircuitState>; // CB state at issuance
}
```

Rejection reasons:

| Reason | Description |
|------|------|
| `GLOBAL_SHED` | system overloaded (Backpressure) |
| `CIRCUIT_OPEN` | Circuit Breaker is OPEN |
| `RATE_LIMIT` | RPS limit exceeded |
| `BUDGET_EXHAUSTED` | cumulative cost budget exceeded |
| `CONCURRENCY_LIMIT` | max concurrency exceeded |
| `FATAL_MODE` | system is in FATAL mode |

### 3.2 ExecutionBudget - enforce resource limits

Source: `src/core/execution-budget.ts`

ExecutionBudget enforces upper bounds on resource consumption.

```typescript
class ExecutionBudget {
  constructor(config: {
    maxConcurrency: number;   // max concurrent permits
    maxRps: number;           // max requests per second
    maxCostBudget?: number;   // optional cumulative cost cap
  });

  checkAttempts(jobId: string, attemptIndex: number, maxAttempts: number): boolean;
  tryAcquireSlot(): boolean;
  releaseSlot(): void;
  checkRps(): boolean;
  addCost(amount: number): boolean;
}
```

| Constraint | Description |
|------|------|
| `maxConcurrency` | max number of active permits |
| `maxRps` | sliding-window RPS limiting |
| `maxCostBudget` | cumulative cost cap (e.g. LLM token costs) |
| `maxAttempts` | per-job attempt limit |

These constraints are **Core invariants** and cannot be relaxed by Scheduler policy.

### 3.3 CircuitBreakerRegistry - cut off cascading failures

Source: `src/core/circuit-breaker.ts`

CircuitBreakerRegistry manages multiple Circuit Breakers to prevent dependency failures from cascading into the entire system.

```typescript
class CircuitBreaker {
  recordSuccess(): void;
  recordFailure(): void;
  isCallPermitted(): boolean;
  getState(): CircuitState;  // CLOSED | HALF_OPEN | OPEN
}

class CircuitBreakerRegistry {
  getOrCreate(key: string, config?: CircuitBreakerConfig): CircuitBreaker;
  getSnapshot(): Record<string, CircuitState>;
  dispose(): void;
}
```

State transitions:

```
CLOSED ---[failures reach failureThreshold]---> OPEN
OPEN   ---[resetTimeoutMs elapsed]-----------> HALF_OPEN
HALF_OPEN ---[success]----------------------> CLOSED
HALF_OPEN ---[failure]----------------------> OPEN
```

Global safety valve: if **any CB is OPEN**, CircuitBreakerRegistry rejects all Permit requests. This design ensures a single failing dependency can safely stop the system.

CB targets:

| Target | Examples |
|------|---|
| LLM providers | errors concentrated on a specific model |
| worker providers | frequent Codex CLI crashes, Claude Code response delays |

### 3.4 Watchdog - detect stalls and latency

Source: `src/core/watchdog.ts`

Watchdog periodically monitors system health and, when it detects anomalies, triggers staged defenses.

```typescript
class Watchdog {
  constructor(config: WatchdogConfig);
  registerSource(source: MetricSource): void;
  start(): void;
  stop(): void;
  getDefenseLevel(): DefenseLevel;
}
```

Observed metrics:

| Metric | What it monitors |
|------|------------------|
| `worker_inflight_count` | number of running worker tasks |
| `worker_queue_lag_ms` | worker queue lag |
| `worker_timeout_rate` | worker task timeout rate |
| `worker_cancel_latency_ms` | time until cancellation takes effect |
| `workspace_lock_wait_ms` | contention wait time for workspace locks |

Defense levels (staged escalation):

```
normal -> shed -> throttle -> circuit_open -> escalation
```

### 3.5 EscalationManager - staged handling of fatal failures

Source: `src/core/escalation-manager.ts`

EscalationManager detects fatal failures and executes actions based on scope.

```typescript
class EscalationManager {
  constructor(config?: {
    crashThreshold: number;       // FATAL if >= N crashes per minute
    cancelTimeoutMs: number;      // cancellation response time limit
    latestWinsThreshold: number;  // latest-wins threshold per workspace
  });
  reportWorkerCrash(workerKind: string): void;
  reportCancelTimeout(handleId: string): void;
  reportLatestWins(workspaceRef: string): void;
}
```

FATAL conditions:

- repeated worker crashes in a short time (`crashThreshold` per minute)
- cancellation does not work and "ghost processes" remain (`cancelTimeoutMs` exceeded)
- too many latest-wins cancellations against the same workspace (changes do not converge)

Escalation scopes and actions:

| Scope | Action | Description |
|---------|-----------|------|
| `WORKER_KIND` | `ISOLATE` / `STOP` | stop a specific worker kind |
| `WORKSPACE` | `ISOLATE` | lock/isolate a workspace |
| `GLOBAL` | `STOP` / `NOTIFY` | safe stop the entire system |

### 3.6 BackpressureController - overload behavior

Source: `src/core/backpressure.ts`

BackpressureController monitors load state and returns appropriate responses under overload.

```typescript
class BackpressureController {
  constructor(thresholds: {
    rejectThreshold: number;   // reject threshold
    deferThreshold: number;    // defer threshold
    degradeThreshold: number;  // degrade threshold
  });
  check(): BackpressureResponse;  // ACCEPT | REJECT | DEFER | DEGRADE
  updateMetrics(metrics: BackpressureMetrics): void;
}
```

Responses:

| Response | Description | Load |
|------|------|----------|
| `ACCEPT` | normal processing | low |
| `DEGRADE` | process with reduced functionality | medium |
| `DEFER` | postpone processing | high |
| `REJECT` | reject processing | very high |

---

## 4. Worker layer

The Worker layer performs actual work (code edits, tests, commands). Workers run as external processes and are isolated from AgentCore at the process boundary.

### 4.1 WorkerDelegationGateway - adapter registry and delegation

Source: `src/worker/worker-gateway.ts`

WorkerDelegationGateway routes tasks to the correct adapter and manages cancellation propagation.

```typescript
class WorkerDelegationGateway {
  registerAdapter(kind: WorkerKind, adapter: WorkerAdapter): void;
  delegateTask(task: WorkerTask, permit: Permit): Promise<WorkerResult>;
  cancelTask(handleId: string): Promise<void>;
}
```

Internal behavior of `delegateTask()`:

1. get the adapter for `task.workerKind`
2. start the worker process via `adapter.startTask(task)`
3. register an `abort` listener on `permit.abortController.signal` (cancellation propagation)
4. wait for result via `adapter.awaitResult(handle)`
5. cleanup listeners and handles

### 4.2 WorkerAdapter interface

Source: `src/worker/worker-adapter.ts`

WorkerAdapter is a unified interface that absorbs differences between worker kinds.

```typescript
interface WorkerAdapter {
  readonly kind: WorkerKind;
  startTask(task: WorkerTask): Promise<WorkerHandle>;
  streamEvents(handle: WorkerHandle): AsyncIterable<WorkerEvent>;
  cancel(handle: WorkerHandle): Promise<void>;
  awaitResult(handle: WorkerHandle): Promise<WorkerResult>;
}
```

WorkerHandle:

```typescript
interface WorkerHandle {
  handleId: UUID;
  workerKind: WorkerKind;
  abortSignal: AbortSignal;
}
```

WorkerEvent (stream):

| type | content |
|------|------|
| `stdout` | stdout |
| `stderr` | stderr |
| `progress` | progress reports (message, percent) |
| `patch` | file changes (path, diff) |

### 4.3 Concrete adapter implementations

Source: `src/worker/adapters/`

| Adapter | File | Use |
|---------|---------|------|
| `MockWorkerAdapter` | `mock-adapter.ts` | test mock |
| `ClaudeCodeAdapter` | `claude-code-adapter.ts` | invoke Claude Code CLI |
| `CodexCliAdapter` | `codex-cli-adapter.ts` | invoke Codex CLI |
| `OpenCodeAdapter` | `opencode-adapter.ts` | invoke OpenCode CLI |

Adapters use `ProcessManager` to spawn processes and observe worker stdout/stderr as streams.

### 4.4 ProcessManager - process lifecycle management

Source: `src/worker/process-manager.ts`

ProcessManager manages worker process launch, timeouts, and safe stopping.

```typescript
class ProcessManager {
  spawn(options: SpawnOptions): ManagedProcess;
  gracefulShutdown(pid: number, gracePeriodMs: number): Promise<void>;
  killAll(): Promise<void>;
}
```

SpawnOptions:

```typescript
interface SpawnOptions {
  command: string[];       // command
  cwd?: string;            // working directory
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}
```

Safe stop flow: send SIGTERM -> wait grace period -> if no response, send SIGKILL.

### 4.5 WorkspaceLock - prevent concurrent edits

Source: `src/worker/workspace-lock.ts`

WorkspaceLock prevents concurrent edits to the same workspace directory.

```typescript
class WorkspaceLock {
  acquire(workspaceRef: string, taskId: UUID): boolean;
  release(workspaceRef: string, taskId: UUID): boolean;
}
```

Locking at the workspace level prevents multiple workers from editing the same repository concurrently and causing conflicts.

---

## 5. Scheduler layer

The Scheduler launches and supervises AgentCore as a child process. It owns policy (decisions) and is swappable.

Source: `src/scheduler/index.ts`

### 5.1 Supervisor - launch and supervise the child process

Source: `src/scheduler/supervisor.ts`

Supervisor spawns AgentCore as a child process and connects IPC via stdin/stdout.

```typescript
class Supervisor {
  constructor(config?: {
    coreEntryPoint: string;  // entry point of AgentCore
    healthCheck?: HealthCheckerConfig;
    ipc?: IpcProtocolOptions;
  });
  start(): Promise<IpcProtocol>;
  shutdown(): Promise<void>;
  onCrash(callback: (exitCode: number | null) => void): void;
  onHang(callback: () => void): void;
}
```

Handling on failures:

| Situation | Handling |
|------|------|
| child process crashes | treat unfinished jobs as failed -> re-enqueue or DLQ |
| child process hangs | SIGTERM -> grace period -> SIGKILL |
| repeated crashes | isolate the instance |

### 5.2 JobQueue - priority queue

Source: `src/scheduler/job-queue.ts`

JobQueue is a priority queue: INTERACTIVE jobs are processed before BATCH jobs. Within the same class, higher `priority.value` comes out first.

```typescript
class JobQueue {
  enqueue(job: Job): void;
  dequeue(): Job | undefined;
  peek(): Job | undefined;
  size(): number;
}
```

Priority classes:

| Class | Use |
|--------|------|
| `INTERACTIVE` | user-interactive (high priority) |
| `BATCH` | background (low priority) |

### 5.3 InFlightRegistry - dedup control

Source: `src/scheduler/inflight-registry.ts`

InFlightRegistry uses Idempotency Keys to control duplicate requests.

```typescript
class InFlightRegistry {
  register(key: string, jobId: UUID, policy: DeduplicationPolicy): RegisterResult;
  complete(key: string): void;
}
```

Deduplication policies:

| Policy | Behavior |
|---------|------|
| `COALESCE` | join the existing job and share its result |
| `LATEST_WINS` | cancel the existing job and run the new one |
| `REJECT` | reject duplicates |

### 5.4 RetryPolicy - retry decisions

Source: `src/scheduler/retry-policy.ts`

RetryPolicy decides whether to retry and how long to wait based on error classification.

```typescript
class RetryPolicy {
  constructor(config?: {
    baseDelayMs: number;   // base delay (default: 1000ms)
    maxDelayMs: number;    // max delay (default: 30000ms)
    maxAttempts: number;   // max attempts (default: 3)
  });
  shouldRetry(errorClass: ErrorClass, attemptIndex: number): RetryDecision;
}
```

Error classes and retryability:

| ErrorClass | Retry | Examples |
|-----------|---------|---|
| `RETRYABLE_TRANSIENT` | yes | 5xx errors, network failures |
| `RETRYABLE_RATE_LIMIT` | yes | 429 rate limits |
| `NON_RETRYABLE` | no | 4xx client errors |
| `FATAL` | no | system failures |

Backoff uses **exponential backoff + full jitter**.

### 5.5 DeadLetterQueue (DLQ) - store failed jobs

Source: `src/scheduler/dlq.ts`

DLQ stores jobs that hit retry limits or are deemed unrecoverable.

```typescript
class DeadLetterQueue {
  push(job: Job, reason: string, errorClass?: ErrorClass, attemptCount?: number): void;
  peek(): DlqEntry | undefined;
  pop(): DlqEntry | undefined;
  drain(): DlqEntry[];
  size(): number;
}
```

---

## 6. IPC layer - inter-process communication

Scheduler and AgentCore communicate via **stdin/stdout JSON Lines**.

Source: `src/ipc/protocol.ts`, `src/ipc/json-lines-transport.ts`

### 6.1 Transport

`JsonLinesTransport` sends/receives JSON Lines (one JSON object per line) over ReadableStream/WritableStream. The maximum line size is 10MB.

### 6.2 Message types

Scheduler -> AgentCore (inbound):

| Message | Use |
|-----------|------|
| `submit_job` | submit a job |
| `cancel_job` | request cancellation |
| `request_permit` | request execution permit |
| `report_queue_metrics` | report queue metrics |

AgentCore -> Scheduler (outbound):

| Message | Use |
|-----------|------|
| `ack` | acknowledge job acceptance |
| `permit_granted` | Permit granted |
| `permit_rejected` | Permit rejected (with reason) |
| `job_completed` | job completed notification (succeeded/failed/cancelled) |
| `job_cancelled` | job cancelled notification |
| `escalation` | escalation event |
| `heartbeat` | health check response |
| `error` | error notification |

### 6.3 Future extensions

The IPC protocol is based on JSON Lines, but designed to be replaceable with gRPC/HTTP later. `IpcProtocol` abstracts protocol details.

---

## 7. Data flow - from submission to result collection

Below is the end-to-end flow from job submission to worker result.

```
  Scheduler                   AgentCore (Core)              Worker
     |                              |                         |
     | submit_job(job)              |                         |
     |----------------------------->|                         |
     |                              |                         |
     | ack(jobId)                   |                         |
     |<-----------------------------|                         |
     |                              |                         |
     | request_permit(job, 0)       |                         |
     |----------------------------->|                         |
     |                              |                         |
     | [Backpressure check]         |                         |
     | [CircuitBreaker check]       |                         |
     | [ExecutionBudget check]      |                         |
     |                              |                         |
     | permit_granted(permit)       |                         |
     |<-----------------------------|                         |
     |                              |                         |
     |                              | startTask(workerTask)   |
     |                              |------------------------>| 
     |                              |                         |
     |                              | [Worker runs task]      |
     |                              |                         |
     |                              | WorkerResult            |
     |                              |<------------------------|
     |                              |                         |
     | job_completed(result)        |                         |
     |<-----------------------------|                         |
     |                              |                         |
```

### Cancellation flow

```
  Scheduler                   AgentCore (Core)              Worker
     |                              |                         |
     | cancel_job(jobId)            |                         |
     |----------------------------->|                         |
     |                              |                         |
     |                              | permit.abort()          |
     |                              | cancel(handle)          |
     |                              |------------------------>| 
     |                              |                         |
     |                              | [SIGTERM -> grace -> SIGKILL]
     |                              |                         |
     |                              | WorkerResult(CANCELLED) |
     |                              |<------------------------|
     |                              |                         |
     | job_cancelled(reason)        |                         |
     |<-----------------------------|                         |
```

---

## 8. Data model

### 8.1 Job - unit of work

```typescript
interface Job {
  jobId: UUID;            // unique id
  type: JobType;          // LLM | TOOL | WORKER_TASK | PLUGIN_EVENT | MAINTENANCE
  priority: Priority;     // { value: number, class: INTERACTIVE | BATCH }
  key?: string;           // Idempotency Key (dedup)
  payload: unknown;       // input payload
  limits: BudgetLimits;   // { timeoutMs, maxAttempts, costHint? }
  context: TraceContext;  // { traceId, correlationId, userId?, sessionId? }
}
```

### 8.2 Permit - execution authorization

```typescript
interface Permit {
  permitId: UUID;
  jobId: UUID;
  deadlineAt: Timestamp;
  attemptIndex: number;
  abortController: AbortController;
  tokensGranted: PermitTokens;  // { concurrency, rps, costBudget? }
  circuitStateSnapshot: Record<string, CircuitState>;
}
```

### 8.3 WorkerTask - instructions to a worker

```typescript
interface WorkerTask {
  workerTaskId: UUID;
  workerKind: WorkerKind;               // CODEX_CLI | CLAUDE_CODE | OPENCODE | CUSTOM
  workspaceRef: string;                 // working directory
  instructions: string;                 // natural language instructions
  capabilities: WorkerCapability[];     // READ | EDIT | RUN_TESTS | RUN_COMMANDS
  outputMode: OutputMode;               // STREAM | BATCH
  budget: WorkerBudget;                 // { deadlineAt, maxSteps?, maxCommandTimeMs? }
  abortSignal: AbortSignal;             // cancellation signal derived from Permit
}
```

### 8.4 WorkerResult - execution result

```typescript
interface WorkerResult {
  status: WorkerStatus;          // SUCCEEDED | FAILED | CANCELLED
  artifacts: Artifact[];         // patches, diffs, generated outputs
  observations: Observation[];   // executed commands, changed files
  cost: WorkerCost;              // { estimatedTokens?, wallTimeMs }
  errorClass?: ErrorClass;       // classification for retry decisions
}
```

---

## 9. Summary - safety guarantees

AgentCore provides these safety guarantees:

| Guarantee | Mechanism |
|------|---------|
| **Prevent duplicate execution** | Idempotency Key + InFlightRegistry |
| **Prevent infinite retries** | ExecutionBudget (maxAttempts, retryBudget) |
| **Cut off cascading failures** | CircuitBreakerRegistry + global safety valve |
| **Control overload** | BackpressureController + ExecutionBudget (RPS) |
| **Detect stalls** | periodic monitoring via Watchdog |
| **Staged incident handling** | EscalationManager (ISOLATE / STOP / NOTIFY) |
| **Isolate execution** | worker process isolation |
| **Reliable cancellation** | consistent AbortController propagation |
| **Nothing runs without a Permit** | PermitGate invariant |

---

## Related documents

- [Quickstart](./quickstart.md) - install and basics
- [Workflow guide](./workflow.md) - writing YAML workflows
- [Daemon guide](./daemon.md) - event-driven resident execution
- [Design doc](../design.md) - design principles and rationale
