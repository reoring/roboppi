import type { Job } from "../types/index.js";
import { PriorityClass } from "../types/index.js";

interface HeapEntry {
  job: Job;
  seq: number; // insertion sequence for stable ordering
}

/**
 * Priority queue for jobs using a binary min-heap.
 * INTERACTIVE jobs dequeue before BATCH.
 * Within the same class, higher priority.value comes first.
 * Equal-priority jobs maintain insertion order (stable).
 */
export class JobQueue {
  private readonly heap: HeapEntry[] = [];
  private seq = 0;

  enqueue(job: Job): void {
    const entry: HeapEntry = { job, seq: this.seq++ };
    this.heap.push(entry);
    this.siftUp(this.heap.length - 1);
  }

  dequeue(): Job | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top.job;
  }

  peek(): Job | undefined {
    return this.heap.length > 0 ? this.heap[0]!.job : undefined;
  }

  size(): number {
    return this.heap.length;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  /**
   * Returns true if `a` should be dequeued before `b`.
   * INTERACTIVE > BATCH; within same class, higher value first.
   * Ties broken by insertion order (lower seq first).
   */
  private higherPriority(a: HeapEntry, b: HeapEntry): boolean {
    const aClass = a.job.priority.class;
    const bClass = b.job.priority.class;

    if (aClass !== bClass) {
      return aClass === PriorityClass.INTERACTIVE;
    }

    if (a.job.priority.value !== b.job.priority.value) {
      return a.job.priority.value > b.job.priority.value;
    }

    // Stable: earlier insertion wins
    return a.seq < b.seq;
  }

  private siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (this.higherPriority(this.heap[i]!, this.heap[parent]!)) {
        this.swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let best = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;

      if (left < n && this.higherPriority(this.heap[left]!, this.heap[best]!)) {
        best = left;
      }
      if (right < n && this.higherPriority(this.heap[right]!, this.heap[best]!)) {
        best = right;
      }

      if (best !== i) {
        this.swap(i, best);
        i = best;
      } else {
        break;
      }
    }
  }

  private swap(i: number, j: number): void {
    const tmp = this.heap[i]!;
    this.heap[i] = this.heap[j]!;
    this.heap[j] = tmp;
  }
}
