import { describe, test, expect } from "bun:test";
import { JobQueue } from "../../../src/scheduler/job-queue.js";
import { PriorityClass, JobType, generateId } from "../../../src/types/index.js";
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

describe("JobQueue", () => {
  test("enqueue and dequeue single job", () => {
    const queue = new JobQueue();
    const job = makeJob();
    queue.enqueue(job);
    expect(queue.size()).toBe(1);
    expect(queue.dequeue()).toBe(job);
    expect(queue.size()).toBe(0);
  });

  test("dequeue returns undefined on empty queue", () => {
    const queue = new JobQueue();
    expect(queue.dequeue()).toBeUndefined();
  });

  test("peek returns first job without removing", () => {
    const queue = new JobQueue();
    const job = makeJob();
    queue.enqueue(job);
    expect(queue.peek()).toBe(job);
    expect(queue.size()).toBe(1);
  });

  test("peek returns undefined on empty queue", () => {
    const queue = new JobQueue();
    expect(queue.peek()).toBeUndefined();
  });

  test("isEmpty returns correct state", () => {
    const queue = new JobQueue();
    expect(queue.isEmpty()).toBe(true);
    queue.enqueue(makeJob());
    expect(queue.isEmpty()).toBe(false);
    queue.dequeue();
    expect(queue.isEmpty()).toBe(true);
  });

  test("INTERACTIVE jobs dequeue before BATCH jobs", () => {
    const queue = new JobQueue();

    const batchJob = makeJob({
      priority: { value: 10, class: PriorityClass.BATCH },
    });
    const interactiveJob = makeJob({
      priority: { value: 1, class: PriorityClass.INTERACTIVE },
    });

    // Enqueue batch first, then interactive
    queue.enqueue(batchJob);
    queue.enqueue(interactiveJob);

    // Interactive should come out first despite lower value
    expect(queue.dequeue()).toBe(interactiveJob);
    expect(queue.dequeue()).toBe(batchJob);
  });

  test("within same class, higher value dequeues first", () => {
    const queue = new JobQueue();

    const lowPriority = makeJob({
      priority: { value: 1, class: PriorityClass.BATCH },
    });
    const midPriority = makeJob({
      priority: { value: 5, class: PriorityClass.BATCH },
    });
    const highPriority = makeJob({
      priority: { value: 10, class: PriorityClass.BATCH },
    });

    // Enqueue in scrambled order
    queue.enqueue(midPriority);
    queue.enqueue(lowPriority);
    queue.enqueue(highPriority);

    expect(queue.dequeue()).toBe(highPriority);
    expect(queue.dequeue()).toBe(midPriority);
    expect(queue.dequeue()).toBe(lowPriority);
  });

  test("mixed priority classes sort correctly", () => {
    const queue = new JobQueue();

    const batch10 = makeJob({
      priority: { value: 10, class: PriorityClass.BATCH },
    });
    const batch5 = makeJob({
      priority: { value: 5, class: PriorityClass.BATCH },
    });
    const interactive3 = makeJob({
      priority: { value: 3, class: PriorityClass.INTERACTIVE },
    });
    const interactive7 = makeJob({
      priority: { value: 7, class: PriorityClass.INTERACTIVE },
    });

    queue.enqueue(batch10);
    queue.enqueue(interactive3);
    queue.enqueue(batch5);
    queue.enqueue(interactive7);

    // All interactive first (by value), then all batch (by value)
    expect(queue.dequeue()).toBe(interactive7);
    expect(queue.dequeue()).toBe(interactive3);
    expect(queue.dequeue()).toBe(batch10);
    expect(queue.dequeue()).toBe(batch5);
  });

  test("same priority value jobs maintain insertion order (stable)", () => {
    const queue = new JobQueue();

    const first = makeJob({
      priority: { value: 5, class: PriorityClass.BATCH },
    });
    const second = makeJob({
      priority: { value: 5, class: PriorityClass.BATCH },
    });
    const third = makeJob({
      priority: { value: 5, class: PriorityClass.BATCH },
    });

    queue.enqueue(first);
    queue.enqueue(second);
    queue.enqueue(third);

    expect(queue.dequeue()).toBe(first);
    expect(queue.dequeue()).toBe(second);
    expect(queue.dequeue()).toBe(third);
  });

  test("size tracks correctly through multiple operations", () => {
    const queue = new JobQueue();

    expect(queue.size()).toBe(0);
    queue.enqueue(makeJob());
    queue.enqueue(makeJob());
    queue.enqueue(makeJob());
    expect(queue.size()).toBe(3);
    queue.dequeue();
    expect(queue.size()).toBe(2);
    queue.dequeue();
    queue.dequeue();
    expect(queue.size()).toBe(0);
  });
});
