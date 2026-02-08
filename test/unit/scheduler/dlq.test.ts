import { describe, test, expect } from "bun:test";
import { DeadLetterQueue } from "../../../src/scheduler/dlq.js";
import { ErrorClass, JobType, PriorityClass, generateId } from "../../../src/types/index.js";
import type { Job } from "../../../src/types/index.js";

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    jobId: generateId(),
    type: JobType.LLM,
    priority: { value: 0, class: PriorityClass.BATCH },
    payload: {},
    limits: { timeoutMs: 30000, maxAttempts: 3 },
    context: { traceId: generateId(), correlationId: generateId() },
    ...overrides,
  };
}

describe("DeadLetterQueue", () => {
  test("starts empty", () => {
    const dlq = new DeadLetterQueue();
    expect(dlq.size()).toBe(0);
  });

  test("push adds entry", () => {
    const dlq = new DeadLetterQueue();
    const job = makeJob();
    dlq.push(job, "max retries exceeded");
    expect(dlq.size()).toBe(1);
  });

  test("peek returns first entry without removing", () => {
    const dlq = new DeadLetterQueue();
    const job = makeJob();
    dlq.push(job, "timeout");
    const entry = dlq.peek();
    expect(entry).toBeDefined();
    expect(entry!.job).toBe(job);
    expect(entry!.reason).toBe("timeout");
    expect(dlq.size()).toBe(1);
  });

  test("peek returns undefined on empty queue", () => {
    const dlq = new DeadLetterQueue();
    expect(dlq.peek()).toBeUndefined();
  });

  test("pop returns and removes first entry", () => {
    const dlq = new DeadLetterQueue();
    const job1 = makeJob();
    const job2 = makeJob();

    dlq.push(job1, "reason 1");
    dlq.push(job2, "reason 2");

    const entry = dlq.pop();
    expect(entry).toBeDefined();
    expect(entry!.job).toBe(job1);
    expect(dlq.size()).toBe(1);
  });

  test("pop returns undefined on empty queue", () => {
    const dlq = new DeadLetterQueue();
    expect(dlq.pop()).toBeUndefined();
  });

  test("list returns a copy of all entries", () => {
    const dlq = new DeadLetterQueue();
    const job1 = makeJob();
    const job2 = makeJob();

    dlq.push(job1, "reason 1");
    dlq.push(job2, "reason 2");

    const entries = dlq.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.job).toBe(job1);
    expect(entries[1]!.job).toBe(job2);

    // Verify it's a copy (modifying returned array doesn't affect DLQ)
    entries.pop();
    expect(dlq.size()).toBe(2);
  });

  test("clear removes all entries", () => {
    const dlq = new DeadLetterQueue();
    dlq.push(makeJob(), "reason 1");
    dlq.push(makeJob(), "reason 2");
    dlq.push(makeJob(), "reason 3");

    expect(dlq.size()).toBe(3);
    dlq.clear();
    expect(dlq.size()).toBe(0);
    expect(dlq.peek()).toBeUndefined();
  });

  test("DlqEntry has correct structure", () => {
    const dlq = new DeadLetterQueue();
    const job = makeJob();
    dlq.push(job, "circuit open", ErrorClass.RETRYABLE_TRANSIENT, 3);

    const entry = dlq.peek();
    expect(entry).toBeDefined();
    expect(entry!.job).toBe(job);
    expect(entry!.reason).toBe("circuit open");
    expect(entry!.errorClass).toBe(ErrorClass.RETRYABLE_TRANSIENT);
    expect(entry!.attemptCount).toBe(3);
    expect(entry!.failedAt).toBeGreaterThan(0);
    expect(typeof entry!.failedAt).toBe("number");
  });

  test("push without errorClass defaults to undefined", () => {
    const dlq = new DeadLetterQueue();
    dlq.push(makeJob(), "some reason");

    const entry = dlq.peek();
    expect(entry!.errorClass).toBeUndefined();
  });

  test("push without attemptCount defaults to 0", () => {
    const dlq = new DeadLetterQueue();
    dlq.push(makeJob(), "some reason");

    const entry = dlq.peek();
    expect(entry!.attemptCount).toBe(0);
  });

  test("FIFO ordering is preserved", () => {
    const dlq = new DeadLetterQueue();
    const jobs = [makeJob(), makeJob(), makeJob()];

    jobs.forEach((job, i) => dlq.push(job, `reason ${i}`));

    expect(dlq.pop()!.job).toBe(jobs[0]!);
    expect(dlq.pop()!.job).toBe(jobs[1]!);
    expect(dlq.pop()!.job).toBe(jobs[2]!);
  });

  // -------------------------------------------------------------------------
  // Inspection and recovery
  // -------------------------------------------------------------------------

  describe("job inspection", () => {
    test("job in DLQ can be inspected via list without modifying queue", () => {
      const dlq = new DeadLetterQueue();
      const job = makeJob({ payload: { action: "deploy", target: "prod" } });
      dlq.push(job, "circuit breaker open", ErrorClass.RETRYABLE_TRANSIENT, 5);

      const entries = dlq.list();
      expect(entries.length).toBe(1);

      const entry = entries[0]!;
      expect(entry.job.jobId).toBe(job.jobId);
      expect(entry.job.payload).toEqual({ action: "deploy", target: "prod" });
      expect(entry.reason).toBe("circuit breaker open");
      expect(entry.errorClass).toBe(ErrorClass.RETRYABLE_TRANSIENT);
      expect(entry.attemptCount).toBe(5);
      expect(entry.failedAt).toBeGreaterThan(0);

      // Queue not modified
      expect(dlq.size()).toBe(1);
    });

    test("list entries contain correct metadata for multiple jobs", () => {
      const dlq = new DeadLetterQueue();

      const job1 = makeJob({ type: JobType.LLM });
      const job2 = makeJob({ type: JobType.WORKER_TASK });
      const job3 = makeJob({ type: JobType.TOOL });

      dlq.push(job1, "timeout", ErrorClass.RETRYABLE_TRANSIENT, 3);
      dlq.push(job2, "worker crash", ErrorClass.FATAL, 1);
      dlq.push(job3, "rate limited", ErrorClass.RETRYABLE_RATE_LIMIT, 10);

      const entries = dlq.list();
      expect(entries.length).toBe(3);

      expect(entries[0]!.job.type).toBe(JobType.LLM);
      expect(entries[0]!.reason).toBe("timeout");

      expect(entries[1]!.job.type).toBe(JobType.WORKER_TASK);
      expect(entries[1]!.reason).toBe("worker crash");
      expect(entries[1]!.errorClass).toBe(ErrorClass.FATAL);

      expect(entries[2]!.job.type).toBe(JobType.TOOL);
      expect(entries[2]!.attemptCount).toBe(10);
    });
  });

  describe("DLQ size tracking", () => {
    test("size grows correctly with each push", () => {
      const dlq = new DeadLetterQueue();

      expect(dlq.size()).toBe(0);
      dlq.push(makeJob(), "reason 1");
      expect(dlq.size()).toBe(1);
      dlq.push(makeJob(), "reason 2");
      expect(dlq.size()).toBe(2);
      dlq.push(makeJob(), "reason 3");
      expect(dlq.size()).toBe(3);
    });

    test("size decreases with pop", () => {
      const dlq = new DeadLetterQueue();
      dlq.push(makeJob(), "r1");
      dlq.push(makeJob(), "r2");
      dlq.push(makeJob(), "r3");

      expect(dlq.size()).toBe(3);
      dlq.pop();
      expect(dlq.size()).toBe(2);
      dlq.pop();
      expect(dlq.size()).toBe(1);
      dlq.pop();
      expect(dlq.size()).toBe(0);
    });

    test("size remains 0 after popping from empty queue", () => {
      const dlq = new DeadLetterQueue();
      dlq.pop();
      dlq.pop();
      expect(dlq.size()).toBe(0);
    });
  });

  describe("re-submission from DLQ", () => {
    test("popped job can be re-submitted to a new DLQ", () => {
      const dlq = new DeadLetterQueue();
      const retryDlq = new DeadLetterQueue();

      const job = makeJob({ payload: { command: "run-tests" } });
      dlq.push(job, "first failure", ErrorClass.RETRYABLE_TRANSIENT, 1);

      // Pop from original DLQ
      const entry = dlq.pop();
      expect(entry).toBeDefined();
      expect(dlq.size()).toBe(0);

      // Re-submit to retry DLQ with updated attempt count
      retryDlq.push(entry!.job, "second failure", ErrorClass.RETRYABLE_TRANSIENT, entry!.attemptCount + 1);

      const retryEntry = retryDlq.peek();
      expect(retryEntry).toBeDefined();
      expect(retryEntry!.job.jobId).toBe(job.jobId);
      expect(retryEntry!.attemptCount).toBe(2);
      expect(retryEntry!.reason).toBe("second failure");
    });

    test("drain all jobs from DLQ for batch re-processing", () => {
      const dlq = new DeadLetterQueue();

      const jobs = Array.from({ length: 5 }, (_, i) =>
        makeJob({ payload: { index: i } }),
      );
      jobs.forEach((job, i) => dlq.push(job, `failure ${i}`, undefined, i + 1));

      expect(dlq.size()).toBe(5);

      // Drain all
      const drained = [];
      let entry;
      while ((entry = dlq.pop())) {
        drained.push(entry);
      }

      expect(drained.length).toBe(5);
      expect(dlq.size()).toBe(0);

      // Verify order preserved
      for (let i = 0; i < 5; i++) {
        expect((drained[i]!.job.payload as { index: number }).index).toBe(i);
        expect(drained[i]!.attemptCount).toBe(i + 1);
      }
    });
  });

  describe("DLQ with multiple job types", () => {
    test("handles mixed job types correctly", () => {
      const dlq = new DeadLetterQueue();

      const llmJob = makeJob({ type: JobType.LLM, payload: { prompt: "test" } });
      const workerJob = makeJob({ type: JobType.WORKER_TASK, payload: { task: "edit" } });
      const toolJob = makeJob({ type: JobType.TOOL, payload: { tool: "grep" } });
      const pluginJob = makeJob({ type: JobType.PLUGIN_EVENT, payload: { event: "hook" } });
      const maintenanceJob = makeJob({ type: JobType.MAINTENANCE, payload: { action: "cleanup" } });

      dlq.push(llmJob, "llm timeout", ErrorClass.RETRYABLE_TRANSIENT, 3);
      dlq.push(workerJob, "worker crash", ErrorClass.FATAL, 1);
      dlq.push(toolJob, "tool error", ErrorClass.NON_RETRYABLE, 2);
      dlq.push(pluginJob, "plugin timeout", ErrorClass.RETRYABLE_RATE_LIMIT, 5);
      dlq.push(maintenanceJob, "maintenance failed", ErrorClass.RETRYABLE_SERVICE, 1);

      expect(dlq.size()).toBe(5);

      const entries = dlq.list();

      // Filter by job type
      const llmEntries = entries.filter((e) => e.job.type === JobType.LLM);
      const fatalEntries = entries.filter((e) => e.errorClass === ErrorClass.FATAL);
      const retryableEntries = entries.filter(
        (e) => e.errorClass?.startsWith("RETRYABLE"),
      );

      expect(llmEntries.length).toBe(1);
      expect(fatalEntries.length).toBe(1);
      expect(retryableEntries.length).toBe(3);
    });

    test("peek and pop work correctly with mixed types", () => {
      const dlq = new DeadLetterQueue();

      dlq.push(makeJob({ type: JobType.LLM }), "r1");
      dlq.push(makeJob({ type: JobType.WORKER_TASK }), "r2");
      dlq.push(makeJob({ type: JobType.TOOL }), "r3");

      // Peek returns first (LLM)
      expect(dlq.peek()!.job.type).toBe(JobType.LLM);

      // Pop removes first
      const first = dlq.pop();
      expect(first!.job.type).toBe(JobType.LLM);

      // Now peek returns second (WORKER_TASK)
      expect(dlq.peek()!.job.type).toBe(JobType.WORKER_TASK);
    });

    test("clear removes all entries regardless of type", () => {
      const dlq = new DeadLetterQueue();

      dlq.push(makeJob({ type: JobType.LLM }), "r1");
      dlq.push(makeJob({ type: JobType.WORKER_TASK }), "r2");
      dlq.push(makeJob({ type: JobType.MAINTENANCE }), "r3");

      expect(dlq.size()).toBe(3);
      dlq.clear();
      expect(dlq.size()).toBe(0);
      expect(dlq.list()).toEqual([]);
    });
  });

  describe("error class handling", () => {
    test("all error classes are preserved correctly", () => {
      const dlq = new DeadLetterQueue();

      const errorClasses = [
        ErrorClass.RETRYABLE_TRANSIENT,
        ErrorClass.RETRYABLE_RATE_LIMIT,
        ErrorClass.RETRYABLE_NETWORK,
        ErrorClass.RETRYABLE_SERVICE,
        ErrorClass.NON_RETRYABLE,
        ErrorClass.NON_RETRYABLE_LINT,
        ErrorClass.NON_RETRYABLE_TEST,
        ErrorClass.FATAL,
      ];

      for (const ec of errorClasses) {
        dlq.push(makeJob(), `failed with ${ec}`, ec);
      }

      const entries = dlq.list();
      expect(entries.length).toBe(errorClasses.length);

      for (let i = 0; i < errorClasses.length; i++) {
        expect(entries[i]!.errorClass).toBe(errorClasses[i]);
      }
    });
  });
});
