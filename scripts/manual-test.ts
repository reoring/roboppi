/**
 * Manual E2E test: Spawn Roboppi Core directly and communicate via JSON Lines.
 */
import { generateId } from "../src/types/common.js";
import { JobType, PriorityClass } from "../src/types/index.js";

const log = (msg: string) => console.error(`[manual-test] ${msg}`);

log("=== Roboppi Core Manual E2E Test ===\n");

// Spawn Roboppi Core as child process
log("Spawning Roboppi Core child process...");
const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
  cwd: process.cwd(),
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});

log(`Core PID: ${proc.pid}`);

// Helper: send JSON Lines message to Core's stdin
function send(msg: { type: string } & Record<string, unknown>) {
  const line = JSON.stringify(msg) + "\n";
  log(`  -> ${msg.type}: ${line.trim()}`);
  proc.stdin.write(line);
  proc.stdin.flush();
}

// Helper: read responses from Core's stdout
async function readResponses(maxWaitMs: number): Promise<unknown[]> {
  const messages: unknown[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = proc.stdout.getReader();

  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const readPromise = reader.read();
    const timeoutPromise = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), Math.max(100, deadline - Date.now()))
    );

    const { done, value } = await Promise.race([readPromise, timeoutPromise]);

    if (value) {
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          try {
            const msg = JSON.parse(line);
            messages.push(msg);
            log(`  <- ${msg.type}: ${line.trim()}`);
          } catch {
            log(`  <- (non-JSON): ${line}`);
          }
        }
      }
    }

    if (done) break;
  }

  reader.releaseLock();
  return messages;
}

// Wait a moment for AgentCore to initialize
await new Promise((r) => setTimeout(r, 500));

// --- Test 1: Submit an LLM job and request permit ---
log("--- Test 1: Submit LLM Job + Request Permit ---");

const jobId1 = generateId();
const job1 = {
  jobId: jobId1,
  type: JobType.LLM,
  priority: { value: 1, class: PriorityClass.INTERACTIVE },
  payload: { prompt: "Hello, world!" },
  limits: { timeoutMs: 5000, maxAttempts: 3 },
  context: { traceId: generateId(), correlationId: generateId() },
};

send({ type: "submit_job", requestId: "req-1", job: job1 });

await new Promise((r) => setTimeout(r, 200));

send({ type: "request_permit", requestId: "req-2", job: job1, attemptIndex: 0 });

const msgs1 = await readResponses(2000);
log(`\nReceived ${msgs1.length} messages for Test 1\n`);

// --- Test 2: Submit a WORKER_TASK job (will fail since no worker adapter registered) ---
log("--- Test 2: Submit WORKER_TASK Job ---");

const jobId2 = generateId();
const job2 = {
  jobId: jobId2,
  type: JobType.WORKER_TASK,
  priority: { value: 2, class: PriorityClass.INTERACTIVE },
  payload: {
    workerKind: "CLAUDE_CODE",
    workspaceRef: "/tmp/test",
    instructions: "Run tests",
    capabilities: ["RUN_TESTS"],
    outputMode: "BATCH",
    budget: { deadlineAt: Date.now() + 5000 },
  },
  limits: { timeoutMs: 5000, maxAttempts: 3 },
  context: { traceId: generateId(), correlationId: generateId() },
};

send({ type: "submit_job", requestId: "req-3", job: job2 });

await new Promise((r) => setTimeout(r, 200));

send({ type: "request_permit", requestId: "req-4", job: job2, attemptIndex: 0 });

const msgs2 = await readResponses(2000);
log(`\nReceived ${msgs2.length} messages for Test 2\n`);

// --- Test 3: Cancel a job ---
log("--- Test 3: Cancel Job ---");

const jobId3 = generateId();
const job3 = {
  jobId: jobId3,
  type: JobType.LLM,
  priority: { value: 1, class: PriorityClass.BATCH },
  payload: { prompt: "This will be cancelled" },
  limits: { timeoutMs: 5000, maxAttempts: 3 },
  context: { traceId: generateId(), correlationId: generateId() },
};

send({ type: "submit_job", requestId: "req-5", job: job3 });

await new Promise((r) => setTimeout(r, 200));

send({ type: "cancel_job", requestId: "req-6", jobId: jobId3, reason: "User cancelled" });

const msgs3 = await readResponses(2000);
log(`\nReceived ${msgs3.length} messages for Test 3\n`);

// --- Summary ---
const allMsgs = [...msgs1, ...msgs2, ...msgs3];
log("=== Summary ===");
log(`Total messages received: ${allMsgs.length}`);
const byType = new Map<string, number>();
for (const msg of allMsgs) {
  const t = (msg as any).type ?? "unknown";
  byType.set(t, (byType.get(t) ?? 0) + 1);
}
for (const [t, count] of byType) {
  log(`  ${t}: ${count}`);
}

// Shutdown
log("\nShutting down AgentCore...");
proc.kill();
await proc.exited;
log(`AgentCore exited.`);
log("\n=== Manual E2E Test Complete ===");
process.exit(0);
