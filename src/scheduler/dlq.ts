import type { Job, ErrorClass, Timestamp } from "../types/index.js";
import { now } from "../types/index.js";

export interface DlqEntry {
  job: Job;
  reason: string;
  errorClass?: ErrorClass;
  failedAt: Timestamp;
  attemptCount: number;
}

export class DeadLetterQueue {
  private readonly entries: DlqEntry[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = 10000) {
    this.maxSize = maxSize;
  }

  push(job: Job, reason: string, errorClass?: ErrorClass, attemptCount: number = 0): void {
    if (this.entries.length >= this.maxSize) {
      const dropped = this.entries.shift();
      console.warn(
        `DLQ overflow: dropping oldest entry (jobId=${dropped?.job.jobId}) to stay within maxSize=${this.maxSize}`,
      );
    }
    this.entries.push({
      job,
      reason,
      errorClass,
      failedAt: now(),
      attemptCount,
    });
  }

  peek(): DlqEntry | undefined {
    return this.entries[0];
  }

  pop(): DlqEntry | undefined {
    return this.entries.shift();
  }

  list(): DlqEntry[] {
    return [...this.entries];
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
