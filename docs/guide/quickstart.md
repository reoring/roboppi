# AgentCore Quickstart

AgentCore is an execution-control runtime for AI agent systems. It provides safe execution control via Permits, failure cut-off via Circuit Breakers, and delegation of actual work to external Workers.

## Prerequisites

Build-only:

- [Bun](https://bun.sh/) v1.0+

If you use a prebuilt binary, Bun is not required.

Optional (if you plan to use them as workers):

- [OpenCode](https://opencode.ai/) - `bun install -g opencode`
- [Claude Code](https://claude.ai/code) - `npm install -g @anthropic-ai/claude-code`
- [Codex CLI](https://github.com/openai/codex) - `npm install -g @openai/codex`

## Install

```bash
git clone <repository-url> agentcore
cd agentcore
bun install
```

## Build

```bash
make            # build a single binary -> ./roboppi (+ ./agentcore alias)
```

Sanity check:

```bash
./agentcore --version
./agentcore --help
```

Other make targets:

```bash
make test       # all tests
make typecheck  # typecheck
make clean      # remove build artifacts
make install    # install to /usr/local/bin
```

---

## Usage 1: One-shot execution with `agentcore run`

Use the `run` subcommand to delegate a task to a Worker using only CLI flags.

```bash
# Generate files with OpenCode
./agentcore run --worker opencode --workspace /tmp/demo "Create hello.ts"

# Fix tests with Claude Code
./agentcore run --worker claude-code --workspace ./my-project \
  --capabilities EDIT,RUN_TESTS "Fix the failing tests"

# Refactor with Codex CLI
./agentcore run --worker codex --workspace ./src "Refactor this function"

# You can also set timeouts and budgets
./agentcore run --worker opencode --workspace /tmp/demo \
  --timeout 60000 --concurrency 5 "Write a README for this repo"
```

`run` mode options:

| Option | Description | Default |
|-----------|------|----------|
| `--worker <kind>` | worker kind: `opencode`, `claude-code`, `codex` | (required) |
| `--workspace <path>` | working directory | (required) |
| `--capabilities <csv>` | `READ,EDIT,RUN_TESTS,RUN_COMMANDS` | `EDIT` |
| `--timeout <ms>` | task timeout | `120000` |

Internally, AgentCore checks PermitGate -> CircuitBreaker -> ExecutionBudget before delegating to the worker.

---

## Usage 2: IPC server mode

If you run `agentcore` with no subcommand, it starts in IPC server mode. A Scheduler or custom driver can talk to it over JSON Lines.

```bash
# Start with defaults
./agentcore

# Start with custom settings
./agentcore --concurrency 20 --rps 100 --log-level debug
```

Shared options (also available in `run` mode):

| Option | Description | Default |
|-----------|------|----------|
| `--concurrency <n>` | max concurrent permits | 10 |
| `--rps <n>` | max requests per second | 50 |
| `--max-cost <n>` | cumulative cost limit | unlimited |
| `--log-level <level>` | log level (debug/info/warn/error/fatal) | info |
| `--cb-threshold <n>` | Circuit Breaker failure threshold | 5 |
| `--cb-reset-ms <n>` | Circuit Breaker reset timeout (ms) | 30000 |
| `--cb-half-open <n>` | Circuit Breaker half-open probe count | 3 |
| `--bp-reject <n>` | Backpressure reject threshold | 100 |
| `--bp-defer <n>` | Backpressure defer threshold | 75 |
| `--bp-degrade <n>` | Backpressure degrade threshold | 50 |

### Example: submit a job via JSON Lines

```bash
echo '{"type":"submit_job","requestId":"req-1","job":{"jobId":"job-001","type":"LLM","priority":{"value":1,"class":"INTERACTIVE"},"payload":{"prompt":"hello"},"limits":{"timeoutMs":5000,"maxAttempts":3},"context":{"traceId":"t-1","correlationId":"c-1"}}}' | ./agentcore 2>/dev/null
```

Output (returned on stdout as JSON Lines):

```json
{"type":"ack","requestId":"req-1","jobId":"job-001"}
```

---

## Usage 3: Use from code

### Basic: call Core components directly

```typescript
import { PermitGate } from "./src/core/permit-gate.js";
import { ExecutionBudget } from "./src/core/execution-budget.js";
import { CircuitBreakerRegistry } from "./src/core/circuit-breaker.js";
import { BackpressureController } from "./src/core/backpressure.js";
import { WorkerDelegationGateway } from "./src/worker/worker-gateway.js";
import { MockWorkerAdapter } from "./src/worker/adapters/mock-adapter.js";
import { WorkerKind, WorkerCapability } from "./src/types/index.js";
import type { WorkerTask } from "./src/types/index.js";
import { generateId } from "./src/types/common.js";

// 1. Initialize core components
const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 50 });
const cbRegistry = new CircuitBreakerRegistry();
const backpressure = new BackpressureController({
  rejectThreshold: 100,
  deferThreshold: 80,
  degradeThreshold: 50,
});
const permitGate = new PermitGate(budget, cbRegistry, backpressure);
const gateway = new WorkerDelegationGateway();

// 2. Register a worker adapter (Mock for this example)
gateway.registerAdapter(
  WorkerKind.CLAUDE_CODE,
  new MockWorkerAdapter(WorkerKind.CLAUDE_CODE, { delayMs: 100 }),
);

// 3. Define a job
const job = {
  jobId: generateId(),
  type: "WORKER_TASK" as any,
  priority: { value: 1, class: "INTERACTIVE" as any },
  payload: {},
  limits: { timeoutMs: 30000, maxAttempts: 3 },
  context: { traceId: generateId(), correlationId: generateId() },
};

// 4. Request a Permit (safety checks: Budget, CB, Backpressure)
const result = permitGate.requestPermit(job, 0);
if (!("permitId" in result)) {
  console.error("Permit rejected:", result.reason);
  process.exit(1);
}
const permit = result;
console.log("Permit granted:", permit.permitId);

// 5. Delegate work to a worker
const task: WorkerTask = {
  workerTaskId: generateId(),
  workerKind: WorkerKind.CLAUDE_CODE,
  workspaceRef: "/tmp/my-workspace",
  instructions: "Run the test suite",
  capabilities: [WorkerCapability.RUN_TESTS],
  outputMode: "BATCH" as any,
  budget: { deadlineAt: Date.now() + 30000 },
  abortSignal: permit.abortController.signal,
};

const workerResult = await gateway.delegateTask(task, permit);
console.log("Result:", workerResult.status);

// 6. Complete the Permit
permitGate.completePermit(permit.permitId);

// Cleanup
permitGate.dispose();
cbRegistry.dispose();
```

Save the code above as `my-script.ts`, then:

```bash
bun run my-script.ts
```

---

## Usage 4: Run a real task with OpenCode (programmatic)

If OpenCode is installed, you can delegate real tasks.

```typescript
// opencode-example.ts
import { generateId, now } from "./src/types/common.js";
import { WorkerKind, WorkerCapability, WorkerStatus } from "./src/types/index.js";
import type { WorkerTask, WorkerResult } from "./src/types/index.js";
import { ProcessManager } from "./src/worker/process-manager.js";
import type { ManagedProcess } from "./src/worker/process-manager.js";
import type { WorkerAdapter, WorkerHandle, WorkerEvent } from "./src/worker/worker-adapter.js";
import { WorkerDelegationGateway } from "./src/worker/worker-gateway.js";
import { PermitGate } from "./src/core/permit-gate.js";
import { ExecutionBudget } from "./src/core/execution-budget.js";
import { CircuitBreakerRegistry } from "./src/core/circuit-breaker.js";
import { BackpressureController } from "./src/core/backpressure.js";

// Minimal adapter for OpenCode
class OpenCodeWorker implements WorkerAdapter {
  readonly kind = WorkerKind.OPENCODE;
  private pm: ProcessManager;
  private procs = new Map<string, ManagedProcess>();
  private starts = new Map<string, number>();

  constructor(pm: ProcessManager) { this.pm = pm; }

  async startTask(task: WorkerTask): Promise<WorkerHandle> {
    const managed = this.pm.spawn({
      command: ["opencode", "run", "--format", "json", task.instructions],
      cwd: task.workspaceRef,
      abortSignal: task.abortSignal,
      timeoutMs: 120000,
    });
    const handle: WorkerHandle = {
      handleId: generateId(),
      workerKind: WorkerKind.OPENCODE,
      abortSignal: task.abortSignal,
    };
    this.procs.set(handle.handleId, managed);
    this.starts.set(handle.handleId, now());
    return handle;
  }

  async *streamEvents(): AsyncIterable<WorkerEvent> {}

  async cancel(handle: WorkerHandle) {
    const p = this.procs.get(handle.handleId);
    if (p) await this.pm.gracefulShutdown(p.pid, 5000);
    this.procs.delete(handle.handleId);
  }

  async awaitResult(handle: WorkerHandle): Promise<WorkerResult> {
    const managed = this.procs.get(handle.handleId)!;
    const exitCode = await managed.exitPromise;
    const wallTimeMs = now() - (this.starts.get(handle.handleId) ?? now());
    this.procs.delete(handle.handleId);
    this.starts.delete(handle.handleId);
    return {
      status: handle.abortSignal.aborted
        ? WorkerStatus.CANCELLED
        : exitCode === 0 ? WorkerStatus.SUCCEEDED : WorkerStatus.FAILED,
      artifacts: [],
      observations: [],
      cost: { wallTimeMs },
    };
  }
}

// --- Run ---
const pm = new ProcessManager();
const budget = new ExecutionBudget({ maxConcurrency: 5, maxRps: 10 });
const cbRegistry = new CircuitBreakerRegistry();
const bp = new BackpressureController({ rejectThreshold: 100, deferThreshold: 80, degradeThreshold: 50 });
const gate = new PermitGate(budget, cbRegistry, bp);
const gw = new WorkerDelegationGateway();

gw.registerAdapter(WorkerKind.OPENCODE, new OpenCodeWorker(pm));

// Request a Permit
const job = {
  jobId: generateId(),
  type: "WORKER_TASK" as any,
  priority: { value: 1, class: "INTERACTIVE" as any },
  payload: {},
  limits: { timeoutMs: 120000, maxAttempts: 1 },
  context: { traceId: generateId(), correlationId: generateId() },
};
const permit = gate.requestPermit(job, 0) as any;
console.log("Permit granted:", permit.permitId);

// Execute a task
const task: WorkerTask = {
  workerTaskId: generateId(),
  workerKind: WorkerKind.OPENCODE,
  workspaceRef: "/tmp/my-project",       // working directory
  instructions: "Implement FizzBuzz in TypeScript and print 1..30",
  capabilities: [WorkerCapability.EDIT],
  outputMode: "BATCH" as any,
  budget: { deadlineAt: Date.now() + 120000 },
  abortSignal: permit.abortController.signal,
};

console.log("Delegating to OpenCode...");
const result = await gw.delegateTask(task, permit);
console.log("Result:", result.status, `(${(result.cost.wallTimeMs / 1000).toFixed(1)}s)`);

gate.completePermit(permit.permitId);
gate.dispose();
cbRegistry.dispose();
process.exit(0);
```

Run:

```bash
mkdir -p /tmp/my-project
bun run opencode-example.ts
```

OpenCode generates files and the result returns `SUCCEEDED`.

---

## Usage 5: Start with a Scheduler (full configuration)

The Scheduler launches and supervises AgentCore as a child process. This includes a job queue, dedup control, retries, and a DLQ.

```typescript
import { Scheduler } from "./src/scheduler/index.js";
import { JobType, PriorityClass } from "./src/types/index.js";
import { generateId } from "./src/types/common.js";

const scheduler = new Scheduler({
  supervisor: { coreEntryPoint: "src/index.ts" },
  retry: { baseDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 3 },
});

// Start AgentCore as a child process
await scheduler.start();

// Submit a job
const result = scheduler.submitJob({
  jobId: generateId(),
  type: JobType.LLM,
  priority: { value: 1, class: PriorityClass.INTERACTIVE },
  key: "my-unique-key",  // Idempotency Key for dedup
  payload: { prompt: "Hello!" },
  limits: { timeoutMs: 10000, maxAttempts: 3 },
  context: { traceId: generateId(), correlationId: generateId() },
});

console.log("Accepted:", result.accepted);

// Wait a bit
await new Promise((r) => setTimeout(r, 5000));

// Shutdown
await scheduler.shutdown();
```

---

## Usage 6: Run a workflow YAML

Define multiple steps in YAML and run them in order.

```yaml
# my-workflow.yaml
name: refactor-and-test
version: "1"
timeout: "30m"

steps:
  refactor:
    worker: OPENCODE
    workspace: ./src
    instructions: "Refactor this function"
    capabilities: [READ, EDIT]
    timeout: "10m"

  test:
    worker: CUSTOM
    depends_on: [refactor]
    instructions: |
      bun test
    capabilities: [READ, RUN_TESTS]
    timeout: "10m"
```

Run:

```bash
roboppi workflow my-workflow.yaml --verbose
# (dev) bun run src/workflow/run.ts my-workflow.yaml --verbose
```

For each step, AgentCore requests a Permit, delegates to the worker, and collects results. If a step fails, it aborts depending on policy.

### Reuse worker settings with agent catalogs

If you repeat the same worker + model + base instructions across steps, define an agent catalog and reference it via `agent:`.

```yaml
# agents.yaml
version: "1"
agents:
  research:
    worker: OPENCODE
    model: openai/gpt-5.2
    capabilities: [READ]
    base_instructions: |
      You are a research agent.
      Only read files. Do not edit.
```

```yaml
# in your workflow
steps:
  investigate:
    agent: research
    instructions: "Investigate the codebase and write notes"
```

The workflow runner auto-loads `agents.yaml` next to the workflow YAML, or you can pass `--agents <path>`.

See the [Workflow guide](./workflow.md) for details.

---

## Usage 7: Run as a daemon

In daemon mode, you can automatically run workflows triggered by events (cron, file changes, webhooks, etc.).

```yaml
# daemon.yaml
name: my-daemon
version: "1"

workspace: "/tmp/my-daemon"
state_dir: "/tmp/my-daemon/.daemon-state"

# Optional: default agent catalog used by workflows (for step.agent)
agents_file: "./agents.yaml"

events:
  tick:
    type: interval
    every: "30s"

triggers:
  auto-test:
    on: tick
    workflow: "./workflows/test.yaml"
    on_workflow_failure: ignore
```

Start:

```bash
roboppi daemon daemon.yaml --verbose
# (dev) bun run src/daemon/cli.ts daemon.yaml --verbose
```

When file changes are detected, workflows run automatically. You can also use cron schedules, webhooks, and manual commands as triggers.

See the [Daemon guide](./daemon.md) for details.

---

## Architecture overview

```
+-----------------------------------------------+
| Scheduler (parent process)                    |
| JobQueue / InFlightRegistry / RetryPolicy     |
|  +-----------------------------------------+  |
|  | AgentCore (child process)               |  |
|  | PermitGate / CircuitBreaker             |  |
|  | Watchdog / EscalationManager            |  |
|  |  +-----------------------------------+  |  |
|  |  | Worker Delegation Gateway          |  |  |
|  |  | OpenCode / Claude Code / Codex     |  |  |
|  |  +-----------------------------------+  |  |
|  +-----------------------------------------+  |
+-----------------------------------------------+
```

### Core ideas

- **Nothing runs without a Permit** - safety invariant
- **Core = mechanism** - stop, limit, observe, isolate
- **Scheduler = policy** - ordering, dedup, retry; swappable
- **Worker = execution** - isolate heavy work behind a process boundary

---

## Run tests

```bash
make test
make test-unit
make test-integration
make typecheck
```

---

## Next steps

- [Architecture guide](./architecture.md) - internal architecture details
- [Workflow guide](./workflow.md) - writing YAML workflows
- [Daemon guide](./daemon.md) - event-driven resident execution
- [Design doc](../design.md) - design principles and rationale
- Worker adapter customization: see `src/worker/adapters/`
- Implementing a custom Scheduler: see `src/scheduler/`
