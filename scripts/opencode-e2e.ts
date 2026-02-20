/**
 * E2E test: AgentCore Core components → OpenCode worker (real CLI).
 *
 * Since the OpenCodeAdapter's buildArgs generates --subagent/--prompt flags
 * that don't match the real opencode CLI (which uses `opencode run <message>`),
 * we directly use ProcessManager + WorkerGateway with a lightweight wrapper.
 */
import { generateId, now } from "../src/types/common.js";
import { WorkerKind, WorkerCapability, WorkerStatus } from "../src/types/index.js";
import type { WorkerTask, WorkerResult } from "../src/types/index.js";
import { ProcessManager } from "../src/worker/process-manager.js";
import type { ManagedProcess } from "../src/worker/process-manager.js";
import type { WorkerAdapter, WorkerHandle, WorkerEvent } from "../src/worker/worker-adapter.js";
import { WorkerDelegationGateway } from "../src/worker/worker-gateway.js";
import { PermitGate } from "../src/core/permit-gate.js";
import { ExecutionBudget } from "../src/core/execution-budget.js";
import { CircuitBreakerRegistry } from "../src/core/circuit-breaker.js";
import { BackpressureController } from "../src/core/backpressure.js";
import type { PermitHandle, PermitRejection } from "../src/types/index.js";

const log = (msg: string) => console.error(`[opencode-e2e] ${msg}`);

function isPermit(result: PermitHandle | PermitRejection): result is PermitHandle {
  return "permitId" in result;
}

/**
 * Real OpenCode adapter that maps to the actual `opencode run` CLI.
 */
class RealOpenCodeAdapter implements WorkerAdapter {
  readonly kind = WorkerKind.OPENCODE;
  private readonly pm: ProcessManager;
  private readonly procs = new Map<string, ManagedProcess>();
  private readonly starts = new Map<string, number>();

  constructor(pm: ProcessManager) {
    this.pm = pm;
  }

  async startTask(task: WorkerTask): Promise<WorkerHandle> {
    const command = [
      "opencode", "run",
      "--format", "json",
      task.instructions,
    ];

    log(`  Spawning: ${command.join(" ").slice(0, 120)}...`);

    const managed = this.pm.spawn({
      command,
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

  async *streamEvents(handle: WorkerHandle): AsyncIterable<WorkerEvent> {
    const managed = this.procs.get(handle.handleId);
    if (!managed) return;

    const reader = managed.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.length > 0 ? (lines.pop() ?? "") : "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === "tool_use") {
              const tool = evt.part?.tool ?? "unknown";
              const title = evt.part?.state?.title ?? "";
              yield { type: "progress", message: `[${tool}] ${title}` };
            } else if (evt.type === "text") {
              yield { type: "stdout", data: evt.part?.text ?? line };
            } else {
              yield { type: "stdout", data: `[${evt.type}]` };
            }
          } catch {
            yield { type: "stdout", data: line };
          }
        }
      }
    } catch {
      // stream closed
    } finally {
      reader.releaseLock();
    }
  }

  async cancel(handle: WorkerHandle): Promise<void> {
    const managed = this.procs.get(handle.handleId);
    if (!managed) return;
    await this.pm.gracefulShutdown(managed.pid, 5000);
    this.procs.delete(handle.handleId);
  }

  async awaitResult(handle: WorkerHandle): Promise<WorkerResult> {
    const managed = this.procs.get(handle.handleId);
    if (!managed) {
      return { status: WorkerStatus.FAILED, artifacts: [], observations: [], cost: { wallTimeMs: 0 }, durationMs: 0 };
    }

    const exitCode = await managed.exitPromise;
    const wallTimeMs = now() - (this.starts.get(handle.handleId) ?? now());
    this.procs.delete(handle.handleId);
    this.starts.delete(handle.handleId);

    if (handle.abortSignal.aborted) {
      return { status: WorkerStatus.CANCELLED, artifacts: [], observations: [], cost: { wallTimeMs }, durationMs: wallTimeMs };
    }

    return {
      status: exitCode === 0 ? WorkerStatus.SUCCEEDED : WorkerStatus.FAILED,
      artifacts: [],
      observations: [],
      cost: { wallTimeMs },
      durationMs: wallTimeMs,
    };
  }
}

// --- Main ---

log("=== AgentCore → OpenCode E2E Test ===\n");

// Setup
const processManager = new ProcessManager();
const budget = new ExecutionBudget({ maxConcurrency: 5, maxRps: 10 });
const cbRegistry = new CircuitBreakerRegistry();
const backpressure = new BackpressureController({ rejectThreshold: 1.0, deferThreshold: 0.8, degradeThreshold: 0.5 });
const permitGate = new PermitGate(budget, cbRegistry, backpressure);
const workerGateway = new WorkerDelegationGateway();

workerGateway.registerAdapter(WorkerKind.OPENCODE, new RealOpenCodeAdapter(processManager));
log("Core initialized. OpenCode adapter registered.\n");

// Request permit
const jobId = generateId();
const job = {
  jobId,
  type: "WORKER_TASK" as any,
  priority: { value: 1, class: "INTERACTIVE" as any },
  payload: {},
  limits: { timeoutMs: 120000, maxAttempts: 1 },
  context: { traceId: generateId(), correlationId: generateId() },
};

log("Requesting permit...");
const permitResult = permitGate.requestPermit(job, 0);
if (!isPermit(permitResult)) {
  log(`Permit REJECTED: ${permitResult.reason}`);
  process.exit(1);
}
log(`Permit GRANTED: ${permitResult.permitId}\n`);

// Create task
const task: WorkerTask = {
  workerTaskId: generateId(),
  workerKind: WorkerKind.OPENCODE,
  workspaceRef: "/tmp/roboppi-opencode-test",
  instructions: "Create a simple TypeScript project with: 1) hello.ts that exports a greet(name: string) function returning a greeting string, 2) main.ts that imports greet from hello.ts and calls it with 'AgentCore', logging the result, 3) README.md explaining the project. No external dependencies.",
  capabilities: [WorkerCapability.EDIT, WorkerCapability.RUN_COMMANDS],
  outputMode: "BATCH" as any,
  budget: { deadlineAt: Date.now() + 120000 },
  abortSignal: permitResult.abortController.signal,
};

log(`Workspace: ${task.workspaceRef}`);
log(`Task: ${task.instructions}\n`);
log("--- OpenCode Output ---");

// Delegate
const startTime = Date.now();
const result = await workerGateway.delegateTask(task, permitResult);
const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

log("--- End Output ---\n");
log(`=== Result ===`);
log(`  Status: ${result.status}`);
log(`  Wall time: ${elapsed}s`);

// Complete permit
permitGate.completePermit(permitResult.permitId);

// Show what was created
log(`\n=== Files created in /tmp/roboppi-opencode-test ===`);
const ls = Bun.spawn(["find", "/tmp/roboppi-opencode-test", "-type", "f"], { stdout: "pipe" });
const files = (await new Response(ls.stdout).text()).trim();
log(files || "(none)");

for (const filepath of files.split("\n").filter(Boolean)) {
  const name = filepath.replace("/tmp/roboppi-opencode-test/", "");
  if (name.startsWith(".")) continue;
  log(`\n--- ${name} ---`);
  const content = await Bun.file(filepath).text();
  log(content);
}

// Cleanup
permitGate.dispose();
cbRegistry.dispose();

log("\n=== E2E Test Complete ===");
process.exit(0);
