# AgentCore Daemon Design

**Automated workflow execution via an event-driven long-running process**

---

## 1. Background and Goals

AgentCore currently runs a workflow YAML as a **one-shot execution**.
In real-world use cases, however, an agent often needs to **stay resident and keep acting autonomously in response to events**.

- Check the repository state every 5 minutes and fix issues if found
- Detect file changes and automatically run tests + reviews
- Receive external events via webhooks and start the corresponding workflow
- Let an LLM evaluate the previous workflow result and decide the next action

This document defines a **Daemon**. A Daemon stays resident based on a YAML configuration, monitors event sources, and starts workflows when trigger conditions are met. Additionally, it can delegate execution decisions and result analysis to an LLM worker to enable **intelligent autonomous execution**.

### Problems This Solves

| Problem | Approach |
|------|-----------|
| Manual workflow starts are required | Auto-trigger via event sources (cron / file watch / webhook) |
| Only fixed conditions can start workflows | Dynamic decisions via an LLM execution gate (evaluate) |
| Results require manual review | Automated evaluation/reporting via LLM result analysis (analyze) |
| Repetitive tasks do not fit one-shot runs | Continuous monitoring/execution via the daemon event loop |
| Integrating multiple event sources is hard | Declare all event sources + triggers in a single YAML |

---

## 2. Architecture Overview

```
+------------------------------------------------------------------+
| Daemon Process                                                   |
|                                                                  |
|  +--------------------+       +-------------------------------+  |
|  | Event Sources      |       | Trigger Engine                 |  |
|  |                    |       |                               |  |
|  |  - CronSource      |  -->  | Event -> Filter               |  |
|  |  - FSWatchSource   |  -->  |      -> Debounce             |  |
|  |  - WebhookSource   |  -->  |      -> Evaluate (LLM Gate)  |  |
|  |  - CommandSource   |  -->  |      -> Run Workflow         |  |
|  |                    |       |      -> Analyze (LLM Result) |  |
|  +--------------------+       +---------------+---------------+  |
|                                              |                  |
|                                              v                  |
|  +------------------------------------------------------------+  |
|  | Workflow Executor (existing)                                |  |
|  |  - DAG scheduler                                            |  |
|  |  - Context manager                                          |  |
|  |  - Step runners                                             |  |
|  +------------------------------------------------------------+  |
|                                              |                  |
|                                              v                  |
|  +------------------------------------------------------------+  |
|  | AgentCore (existing)                                        |  |
|  |  Permit Gate | Circuit Breaker | Watchdog | Budgets          |  |
|  +------------------------------------------------------------+  |
|                                              |                  |
|                                              v                  |
|  +------------------------------------------------------------+  |
|  | Workers (Claude Code / Codex CLI / OpenCode)                |  |
|  +------------------------------------------------------------+  |
+------------------------------------------------------------------+
```

### Design Principles

1. **Daemon = orchestration policy**: the daemon is the decision layer that determines what to run and when. Existing safety mechanisms in WorkflowExecutor and AgentCore are reused as-is.
2. **Event sources are plugins**: CronSource / FSWatchSource / WebhookSource share a common interface so new sources can be added.
3. **LLM-based intelligent gate**: execution gating (evaluate) and result evaluation (analyze) can be delegated to a worker, enabling context-aware dynamic decisions.
4. **One YAML = one daemon**: the configuration file declaratively defines the daemon's behavior.

---

## 3. YAML Schema Definition

### 3.1 Top-Level Structure

```yaml
# daemon.yaml
name: string                       # daemon name (unique identifier)
version: "1"                       # schema version
description?: string               # optional description

# daemon-wide defaults
workspace: string                  # working directory (default shared by all triggers)
log_dir?: string                   # log output dir (default: ./logs)
max_concurrent_workflows?: number  # max concurrent workflows (default: 1)

# daemon state persistence
state_dir?: string                 # history/state directory (default: ./.daemon-state)

# event source definitions
events:
  <event_id>:                      # event id (unique within the daemon)
    <EventSourceDef>

# trigger definitions (event -> workflow)
triggers:
  <trigger_id>:                    # trigger id (unique within the daemon)
    <TriggerDef>
```

### 3.2 EventSourceDef

#### Cron events

```yaml
events:
  every-5min:
    type: cron
    schedule: "*/5 * * * *"        # standard cron expression

  daily-morning:
    type: cron
    schedule: "0 9 * * *"          # every day at 09:00

  every-30s:
    type: interval
    every: "30s"                   # DurationString (simple interval)
```

#### File system watch events

```yaml
events:
  src-change:
    type: fswatch
    paths:                         # paths to watch (glob supported)
      - "src/**/*.ts"
      - "src/**/*.tsx"
    ignore:                        # ignore paths (optional)
      - "**/*.test.ts"
      - "**/node_modules/**"
    events:                        # event kinds to watch (optional; default: all)
      - create
      - modify
      - delete
```

#### Webhook events

```yaml
events:
  github-push:
    type: webhook
    path: "/hooks/github"          # endpoint path
    port?: number                  # listen port (daemon shares one HTTP server)
    secret?: string                # HMAC verification key (env ref allowed: ${GITHUB_WEBHOOK_SECRET})
    method?: string                # HTTP method (default: POST)
```

#### Custom events (stdin / command)

```yaml
events:
  manual-trigger:
    type: command
    command: "curl -s https://api.example.com/status"
    interval: "1m"                 # command execution interval
    trigger_on: "change"           # change = when stdout differs from previous / always = every run
```

### 3.3 TriggerDef

```yaml
triggers:
  <trigger_id>:
    # ---- basics ----
    on: string                     # event id (key under events)
    workflow: string               # workflow YAML path
    enabled?: boolean              # enabled/disabled (default: true)

    # ---- filtering ----
    filter?:                       # optional payload filter
      <field>: <value>             # exact match
      <field>:
        pattern: string            # regex match
      <field>:
        in: [value1, value2]       # list membership

    # ---- rate control ----
    debounce?: DurationString      # suppress burst events (e.g. "10s")
    cooldown?: DurationString      # cooldown after execution (e.g. "5m")
    max_queue?: number             # max pending queue size (discard overflow; default: 10)

    # ---- execution gate (LLM decision) ----
    evaluate?:
      worker: WorkerKind           # CLAUDE_CODE | CODEX_CLI | OPENCODE | CUSTOM
      instructions: string         # instructions to the LLM (decision criteria)
      capabilities: Capability[]   # e.g. [READ, RUN_COMMANDS]
      timeout?: DurationString     # gate timeout
      # Worker exit 0 -> run, exit 1 -> skip
      # For non-CUSTOM: decide based on worker output containing "run" / "skip"

    # ---- context injection ----
    context?:
      env?:                        # env vars passed to the workflow
        <KEY>: <value>
      last_result?: boolean        # inject previous run result (default: false)
      event_payload?: boolean      # inject event payload (default: false)

    # ---- result analysis (LLM evaluation) ----
    analyze?:
      worker: WorkerKind
      instructions: string         # analysis instructions (how to evaluate and what to do)
      capabilities: Capability[]
      timeout?: DurationString
      outputs?:                    # where to save analysis outputs
        - name: string
          path: string
      # analysis worker can access workflow context/ directory

    # ---- failure handling ----
    on_workflow_failure?: "ignore" | "retry" | "pause_trigger"
                                  # ignore = wait for next event
                                  # retry = rerun (up to max_retries)
                                  # pause_trigger = pause this trigger
    max_retries?: number           # max retry count (default: 3)
```

### 3.4 Full Configuration Example

```yaml
# daemon.yaml - repository watch + periodic review daemon
name: repo-guardian
version: "1"
description: "Monitor the repository; run tests on changes; run periodic code reviews"

workspace: "/home/user/my-project"
max_concurrent_workflows: 2
state_dir: "./.daemon-state"

events:
  code-change:
    type: fswatch
    paths:
      - "src/**/*.ts"
    ignore:
      - "**/*.test.ts"
      - "**/node_modules/**"

  every-5min:
    type: cron
    schedule: "*/5 * * * *"

  github-pr:
    type: webhook
    path: "/hooks/github"
    secret: "${GITHUB_WEBHOOK_SECRET}"

triggers:
  # --- run tests on file changes ---
  auto-test:
    on: code-change
    workflow: ./workflows/test-suite.yaml
    debounce: "10s"
    on_workflow_failure: ignore

  # --- intelligent review every 5 minutes ---
  periodic-review:
    on: every-5min
    workflow: ./workflows/code-review.yaml

    # LLM decides whether a review is needed
    evaluate:
      worker: CLAUDE_CODE
      instructions: |
        Check the latest commits in the repository.
        If there are commits since the last review, output "run".
        Otherwise, output "skip".

        Previous review result: {{last_result}}
      capabilities: [READ, RUN_COMMANDS]
      timeout: "30s"

    context:
      last_result: true

    # After workflow completion, LLM analyzes the result
    analyze:
      worker: CLAUDE_CODE
      instructions: |
        Analyze the workflow execution result.
        - Summarize code review findings
        - If there are critical issues, record what to focus on in the next review
        - Write the result to summary.md
      capabilities: [READ, EDIT]
      timeout: "2m"
      outputs:
        - name: review-summary
          path: summary.md

  # --- run CI via PR webhook ---
  pr-check:
    on: github-pr
    workflow: ./workflows/ci-pipeline.yaml
    filter:
      action: "opened"
      pull_request.base.ref: "main"
    cooldown: "1m"
    on_workflow_failure: retry
    max_retries: 2
```

---

## 4. Component Design

### 4.1 EventSource Interface

```typescript
/** Common interface for event sources. */
interface EventSource {
  /** Source id (event_id in YAML). */
  readonly id: string;

  /** Async iterator of events; lives as long as the daemon. */
  events(): AsyncIterable<DaemonEvent>;

  /** Stop the source. */
  stop(): Promise<void>;
}

/** Event delivered to the daemon. */
interface DaemonEvent {
  sourceId: string;           // event source id
  timestamp: number;          // epoch ms
  payload: EventPayload;      // source-specific payload
}

type EventPayload =
  | CronPayload
  | FSWatchPayload
  | WebhookPayload
  | CommandPayload;

interface CronPayload {
  type: "cron";
  schedule: string;           // schedule expression that fired
  firedAt: number;
}

interface FSWatchPayload {
  type: "fswatch";
  changes: Array<{
    path: string;
    event: "create" | "modify" | "delete";
  }>;
}

interface WebhookPayload {
  type: "webhook";
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface CommandPayload {
  type: "command";
  stdout: string;
  exitCode: number;
  changed: boolean;           // whether stdout differs from previous run
}
```

### 4.2 TriggerEngine

```typescript
/** Trigger execution manager. */
class TriggerEngine {
  constructor(
    private readonly config: DaemonConfig,
    private readonly workflowRunner: WorkflowRunner,
    private readonly stateStore: DaemonStateStore,
  ) {}

  /**
   * Accept an event, evaluate matching triggers, and enqueue execution.
   * A single event may match multiple triggers.
   */
  async handleEvent(event: DaemonEvent): Promise<void> {
    const matchingTriggers = this.findMatchingTriggers(event);

    for (const trigger of matchingTriggers) {
      if (!trigger.enabled) continue;
      if (this.isDebounced(trigger, event)) continue;
      if (this.isInCooldown(trigger)) continue;
      if (this.isQueueFull(trigger)) continue;

      this.enqueueTriggerExecution(trigger, event);
    }
  }

  /**
   * Trigger execution pipeline
   * Filter -> Debounce -> Evaluate -> Execute -> Analyze
   */
  private async executeTrigger(
    trigger: TriggerDef,
    event: DaemonEvent,
  ): Promise<TriggerResult> {
    // 1. Filter
    if (!this.matchesFilter(trigger, event)) {
      return { action: "filtered" };
    }

    // 2. LLM gate (evaluate)
    if (trigger.evaluate) {
      const shouldRun = await this.runEvaluateGate(trigger, event);
      if (!shouldRun) {
        return { action: "skipped_by_evaluate" };
      }
    }

    // 3. Prepare context
    const context = await this.prepareContext(trigger, event);

    // 4. Run workflow
    const workflowResult = await this.workflowRunner.run(
      trigger.workflow,
      context,
    );

    // 5. Persist result
    await this.stateStore.recordExecution(trigger.id, event, workflowResult);

    // 6. LLM analysis (analyze)
    if (trigger.analyze && workflowResult.status === "SUCCEEDED") {
      await this.runAnalysis(trigger, workflowResult);
    }

    // 7. Failure handling
    if (workflowResult.status === "FAILED") {
      await this.handleWorkflowFailure(trigger, workflowResult);
    }

    return { action: "executed", result: workflowResult };
  }
}
```

### 4.3 DaemonStateStore (State persistence)

```typescript
/**
 * Persist daemon execution state.
 * Store files under state_dir.
 */
interface DaemonStateStore {
  /** Get the last execution result. */
  getLastResult(triggerId: string): Promise<WorkflowState | null>;

  /** Record an execution in history. */
  recordExecution(
    triggerId: string,
    event: DaemonEvent,
    result: WorkflowState,
  ): Promise<void>;

  /** Track debounce/cooldown timestamps. */
  getLastFired(triggerId: string): Promise<number | null>;
  setLastFired(triggerId: string, timestamp: number): Promise<void>;

  /** Dynamically enable/disable a trigger. */
  setTriggerEnabled(triggerId: string, enabled: boolean): Promise<void>;
  isTriggerEnabled(triggerId: string): Promise<boolean>;

  /** Fetch recent N records. */
  getHistory(triggerId: string, limit: number): Promise<ExecutionRecord[]>;
}

interface ExecutionRecord {
  triggerId: string;
  event: DaemonEvent;
  result: WorkflowState;
  startedAt: number;
  completedAt: number;
  evaluateResult?: "run" | "skip";
  analyzeResult?: unknown;
}
```

### 4.4 Evaluate Gate (LLM execution decision)

```typescript
/**
 * If the evaluate field is defined, consult an LLM worker before running a workflow.
 *
 * Decision rules by worker kind:
 * - CUSTOM: exit 0 -> run, exit 1 -> skip
 * - CLAUDE_CODE / CODEX_CLI / OPENCODE:
 *   if output contains "run" -> run; if it contains "skip" -> skip
 */
class EvaluateGate {
  async shouldRun(
    evaluate: EvaluateDef,
    event: DaemonEvent,
    lastResult: WorkflowState | null,
    workspaceDir: string,
  ): Promise<boolean> {
    // 1. Expand template variables in instructions
    const instructions = this.expandTemplate(evaluate.instructions, {
      event: JSON.stringify(event.payload),
      last_result: lastResult ? JSON.stringify(lastResult) : "null",
      timestamp: new Date().toISOString(),
    });

    // 2. Run worker
    const result = await this.runWorker({
      worker: evaluate.worker,
      instructions,
      capabilities: evaluate.capabilities,
      timeout: evaluate.timeout ?? "30s",
      workspaceDir,
    });

    // 3. Decide
    if (evaluate.worker === "CUSTOM") {
      return result.exitCode === 0;
    }
    return this.parseDecision(result.output);
  }

  private parseDecision(output: string): boolean {
    const lower = output.toLowerCase().trim();
    // Prefer the last non-empty line (LLMs often put the final decision last).
    const lines = lower.split("\n").filter((l) => l.trim().length > 0);
    const lastLine = lines[lines.length - 1] ?? "";
    if (lastLine.includes("run")) return true;
    if (lastLine.includes("skip")) return false;
    // Fallback: scan the entire output.
    if (lower.includes("run")) return true;
    return false; // default is skip (safer)
  }
}
```

### 4.5 ResultAnalyzer (LLM result analysis)

```typescript
/**
 * If the analyze field is defined, request an LLM worker to analyze results after workflow completion.
 * The worker can access the workflow context/ directory and write analysis artifacts as files.
 */
class ResultAnalyzer {
  async analyze(
    analyzeDef: AnalyzeDef,
    workflowResult: WorkflowState,
    contextDir: string,
    workspaceDir: string,
  ): Promise<AnalyzeResult> {
    const instructions = this.expandTemplate(analyzeDef.instructions, {
      workflow_status: workflowResult.status,
      steps: JSON.stringify(workflowResult.steps),
      context_dir: contextDir,
    });

    const result = await this.runWorker({
      worker: analyzeDef.worker,
      instructions,
      capabilities: analyzeDef.capabilities,
      timeout: analyzeDef.timeout ?? "2m",
      workspaceDir,
    });

    return {
      output: result.output,
      artifacts: analyzeDef.outputs ?? [],
    };
  }
}
```

---

## 5. Event Source Implementations

### 5.1 CronSource

```typescript
/**
 * Fires periodic events based on a cron expression.
 * Internally uses cron-parser to compute the next fire time, then schedules via setTimeout.
 */
class CronSource implements EventSource {
  readonly id: string;
  private timer: Timer | null = null;
  private abortController = new AbortController();

  constructor(
    id: string,
    private readonly schedule: string,
  ) {
    this.id = id;
  }

  async *events(): AsyncIterable<DaemonEvent> {
    while (!this.abortController.signal.aborted) {
      const nextFire = this.computeNext(this.schedule);
      const delay = nextFire - Date.now();

      if (delay > 0) {
        await this.sleep(delay);
      }

      if (this.abortController.signal.aborted) break;

      yield {
        sourceId: this.id,
        timestamp: Date.now(),
        payload: {
          type: "cron",
          schedule: this.schedule,
          firedAt: Date.now(),
        },
      };
    }
  }

  async stop(): Promise<void> {
    this.abortController.abort();
  }
}
```

#### IntervalSource (simplified)

`type: interval` accepts a DurationString and fires on a fixed interval. Internally it is equivalent to `setInterval`.

### 5.2 FSWatchSource

```typescript
/**
 * Watches filesystem changes.
 * Uses Bun's fs.watch() or a chokidar-like mechanism.
 * Applies glob filtering and ignore patterns.
 *
 * Batching: if many changes occur in a short time, batch them into a single event
 * using a 200ms window.
 */
class FSWatchSource implements EventSource {
  private watcher: FSWatcher | null = null;
  private batchWindow = 200; // ms

  async *events(): AsyncIterable<DaemonEvent> {
    // Bun.file watcher or node:fs.watch with recursive option
    // batching: aggregate changes within 200ms window
    // apply glob match + ignore filter
  }
}
```

### 5.3 WebhookSource

```typescript
/**
 * Starts an HTTP server and accepts webhooks on configured paths.
 * A daemon shares a single HTTP server across all WebhookSources.
 *
 * HMAC verification: if secret is configured, validate request signatures
 * via the X-Hub-Signature-256 header.
 */
class WebhookServer {
  private routes = new Map<string, WebhookHandler>();

  /** Start the HTTP server via Bun.serve. */
  start(port: number): void {
    Bun.serve({
      port,
      fetch: (req) => this.handleRequest(req),
    });
  }
}

class WebhookSource implements EventSource {
  constructor(
    private readonly server: WebhookServer,
    private readonly config: WebhookConfig,
  ) {
    server.registerRoute(config.path, this);
  }
}
```

### 5.4 CommandSource

```typescript
/**
 * Periodically runs an external command and emits the result as an event.
 * If trigger_on: "change", emit only when stdout differs from the previous run.
 * If trigger_on: "always", emit every time.
 */
class CommandSource implements EventSource {
  private lastOutput: string | null = null;

  async *events(): AsyncIterable<DaemonEvent> {
    while (!this.aborted) {
      const result = await this.runCommand(this.config.command);
      const changed = this.lastOutput !== null && result.stdout !== this.lastOutput;
      this.lastOutput = result.stdout;

      if (this.config.triggerOn === "always" || changed) {
        yield {
          sourceId: this.id,
          timestamp: Date.now(),
          payload: {
            type: "command",
            stdout: result.stdout,
            exitCode: result.exitCode,
            changed,
          },
        };
      }

      await this.sleep(this.intervalMs);
    }
  }
}
```

---

## 6. Daemon Lifecycle

### 6.1 Startup Flow

```
1. Load YAML and validate
2. Initialize state_dir (restore previous state)
3. Create EventSource instances
4. Start WebhookServer (if webhook sources exist)
5. Initialize TriggerEngine
6. Start event loop
7. Register signal handlers (SIGTERM / SIGINT -> graceful shutdown)
```

### 6.2 Event Loop

```typescript
class Daemon {
  async run(): Promise<void> {
    // Merge events from all EventSources into a single stream
    const merged = mergeAsyncIterables(
      ...this.sources.map((s) => s.events()),
    );

    for await (const event of merged) {
      if (this.shutdownRequested) break;
      await this.triggerEngine.handleEvent(event);
    }
  }
}
```

### 6.3 Graceful Shutdown

```
1. Receive SIGTERM / SIGINT
2. Set shutdownRequested = true
3. Call EventSource.stop() for all sources (stop new events)
4. Send AbortSignal to running workflows
5. Wait for running workflows to finish (with timeout)
6. Flush DaemonStateStore
7. Stop WebhookServer
8. Exit process
```

### 6.4 Concurrent workflow scheduling

```typescript
/**
 * Limit concurrency via max_concurrent_workflows.
 * When at capacity, enqueue new triggers and dequeue when running workflows complete.
 * If max_queue is exceeded, discard the oldest queued item.
 */
class WorkflowScheduler {
  private running = 0;
  private queue: QueuedTrigger[] = [];

  async submit(trigger: TriggerDef, event: DaemonEvent): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      this.execute(trigger, event).finally(() => {
        this.running--;
        this.dequeueNext();
      });
    } else {
      this.enqueue(trigger, event);
    }
  }
}
```

---

## 7. Template Variables

Template variables available in `evaluate` / `analyze` instructions:

| Variable | Description | Where |
|------|------|-------------|
| `{{event}}` | event payload (JSON) | evaluate, analyze |
| `{{event.type}}` | event type | evaluate, analyze |
| `{{last_result}}` | previous execution result (JSON), only when `context.last_result: true` | evaluate |
| `{{last_result.status}}` | previous status | evaluate |
| `{{timestamp}}` | current time (ISO 8601) | evaluate, analyze |
| `{{trigger_id}}` | trigger id | evaluate, analyze |
| `{{workflow_status}}` | workflow status | analyze |
| `{{steps}}` | step results (JSON) | analyze |
| `{{context_dir}}` | context directory path | analyze |
| `{{execution_count}}` | total execution count for this trigger | evaluate, analyze |

---

## 8. CLI Interface

```bash
# start daemon
agentcore daemon start <daemon.yaml> [--verbose]

# check daemon status (from another terminal)
agentcore daemon status [--state-dir <dir>]

# manual trigger (debug)
agentcore daemon trigger <trigger_id> [--state-dir <dir>]

# pause/resume trigger
agentcore daemon pause <trigger_id>
agentcore daemon resume <trigger_id>

# show execution history
agentcore daemon history [--trigger <trigger_id>] [--limit 10]

# stop daemon
agentcore daemon stop [--state-dir <dir>]
```

---

## 9. State Directory Layout

```
.daemon-state/
├── daemon.json                 # daemon metadata (PID, start time, status)
├── triggers/
│   ├── auto-test/
│   │   ├── state.json          # enabled, lastFired, cooldownUntil
│   │   └── history/
│   │       ├── 2024-01-15T09-30-00.json
│   │       └── 2024-01-15T09-35-00.json
│   └── periodic-review/
│       ├── state.json
│       ├── last-result.json    # last workflow result
│       ├── last-analyze.json   # last LLM analysis result
│       └── history/
│           └── ...
└── webhook-server.json         # webhook server metadata (port, etc.)
```

---

## 10. Integration With Existing Components

### 10.1 Relationship with WorkflowExecutor

The daemon's TriggerEngine reuses the existing `WorkflowExecutor` unchanged. The only difference is **who starts WorkflowExecutor and when**:

- **Current**: CLI -> `run.ts` -> `WorkflowExecutor.execute()`
- **Daemon**: `TriggerEngine` -> `WorkflowRunner` -> `WorkflowExecutor.execute()`

### 10.2 Relationship with AgentCore / Scheduler

In the future, the daemon can leverage AgentCore's Permit Gate / Circuit Breaker / Watchdog. In an initial implementation, the daemon can call WorkflowExecutor directly and integrate with AgentCore incrementally:

**Phase 1 (initial)**: Daemon -> WorkflowExecutor -> ShellStepRunner (keep the current setup as-is)

**Phase 2 (integrated)**: Daemon -> WorkflowExecutor -> AgentCore -> Workers (fully utilize safety mechanisms)

### 10.3 Worker usage

Workers used by evaluate/analyze reuse the same worker foundation as workflow steps:

- `CUSTOM`: shell script execution (ShellStepRunner)
- `CLAUDE_CODE` / `CODEX_CLI` / `OPENCODE`: AI workers (via Worker Delegation Gateway)

---

## 11. Design Considerations

### 11.1 Idempotency

The daemon must be safe across crashes and restarts:

- Persist execution state under `state_dir` and restore on startup
- Record the "last fired time" for cron to avoid firing a backlog immediately after restart
- If the daemon crashes mid-workflow, detect the "in progress" state on restart and notify the user (do not auto-retry)

### 11.2 Memory management

- Persist execution history to files under state_dir rather than keeping it in memory
- Aggregate large bursts of FSWatch events via a 200ms batching window
- Set a body size limit for WebhookSource (default: 1MB)

### 11.3 Security

- Configure webhook secrets via environment variables (`${ENV_VAR}`); do not put secrets directly into YAML
- Require HMAC-SHA256 signature verification when a secret is configured
- Restrict workflow workspaces to be under the daemon workspace

### 11.4 Observability

```typescript
interface DaemonMetrics {
  eventsReceived: Record<string, number>;     // received events by source id
  triggersEvaluated: Record<string, number>;  // evaluated triggers by trigger id
  triggersExecuted: Record<string, number>;   // executed triggers by trigger id
  triggersSkipped: Record<string, number>;    // skipped by evaluate
  workflowsSucceeded: number;
  workflowsFailed: number;
  activeWorkflows: number;
  uptime: number;
}
```

Log tags:

- `[daemon:event]` - event reception
- `[daemon:trigger]` - trigger evaluation/execution
- `[daemon:evaluate]` - LLM gate decisions
- `[daemon:analyze]` - LLM result analysis
- `[daemon:workflow]` - workflow start/finish

---

## 12. Implementation Plan

### Phase 1: Core foundation

- [ ] YAML parser + validation (DaemonConfig types)
- [ ] EventSource interface + CronSource + IntervalSource
- [ ] TriggerEngine (filter + debounce + cooldown)
- [ ] DaemonStateStore (file-based persistence)
- [ ] Daemon class (event loop + graceful shutdown)
- [ ] CLI: `agentcore daemon start`

### Phase 2: Expand event sources

- [ ] FSWatchSource (glob / ignore / batching)
- [ ] WebhookSource + WebhookServer (HMAC verification)
- [ ] CommandSource (change detection)

### Phase 3: Intelligent layer

- [ ] EvaluateGate (CUSTOM + LLM worker support)
- [ ] ResultAnalyzer (context/ access + output persistence)
- [ ] Template variable expansion
- [ ] Context injection (last_result, event_payload)

### Phase 4: Operations features

- [ ] CLI: status / trigger / pause / resume / history / stop
- [ ] Observability (metrics + structured logs)
- [ ] Concurrent workflow scheduling (max_concurrent_workflows)

### Phase 5: AgentCore integration

- [ ] WorkflowExecutor -> AgentCore -> Worker path
- [ ] Apply Circuit Breaker / Permit Gate at the daemon level
