import type { Job } from "../types/index.js";
import { PriorityClass } from "../types/index.js";

/**
 * Priority queue for jobs.
 * INTERACTIVE jobs dequeue before BATCH.
 * Within the same class, higher priority.value comes first.
 */
export class JobQueue {
  private readonly items: Job[] = [];

  enqueue(job: Job): void {
    // Insert in sorted position (binary search for efficiency)
    let low = 0;
    let high = this.items.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.higherPriority(job, this.items[mid]!)) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }

    this.items.splice(low, 0, job);
  }

  dequeue(): Job | undefined {
    return this.items.shift();
  }

  peek(): Job | undefined {
    return this.items[0];
  }

  size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  /**
   * Returns true if `a` should be dequeued before `b`.
   * INTERACTIVE > BATCH; within same class, higher value first.
   */
  private higherPriority(a: Job, b: Job): boolean {
    const aClass = a.priority.class;
    const bClass = b.priority.class;

    if (aClass !== bClass) {
      return aClass === PriorityClass.INTERACTIVE;
    }

    return a.priority.value > b.priority.value;
  }
}
