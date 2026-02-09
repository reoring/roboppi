import { appendFileSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Job, ErrorClass, Timestamp } from "../types/index.js";
import { now } from "../types/index.js";
import { Logger } from "../core/observability.js";

export interface DlqEntry {
  job: Job;
  reason: string;
  errorClass?: ErrorClass;
  failedAt: Timestamp;
  attemptCount: number;
}

export interface DlqOptions {
  maxSize?: number;
  logger?: Logger;
  /** Optional directory for file-based persistence. DLQ data stored as `dlq.jsonl`. */
  persistDir?: string;
}

export class DeadLetterQueue {
  private readonly entries: DlqEntry[] = [];
  private readonly maxSize: number;
  private readonly logger: Logger;
  private readonly persistPath: string | null;

  constructor(maxSizeOrOptions?: number | DlqOptions, logger?: Logger) {
    if (typeof maxSizeOrOptions === "object" && maxSizeOrOptions !== null) {
      const opts = maxSizeOrOptions;
      this.maxSize = opts.maxSize ?? 10000;
      this.logger = opts.logger ?? new Logger("dlq");
      if (opts.persistDir) {
        mkdirSync(opts.persistDir, { recursive: true });
        this.persistPath = `${opts.persistDir}/dlq.jsonl`;
        this.loadFromFile();
      } else {
        this.persistPath = null;
      }
    } else {
      this.maxSize = maxSizeOrOptions ?? 10000;
      this.logger = logger ?? new Logger("dlq");
      this.persistPath = null;
    }
  }

  push(job: Job, reason: string, errorClass?: ErrorClass, attemptCount: number = 0): void {
    if (this.entries.length >= this.maxSize) {
      const dropped = this.entries.shift();
      this.logger.warn(
        "DLQ overflow: dropping oldest entry",
        { droppedJobId: dropped?.job.jobId, maxSize: this.maxSize },
      );
    }
    const entry: DlqEntry = {
      job,
      reason,
      errorClass,
      failedAt: now(),
      attemptCount,
    };
    this.entries.push(entry);

    if (this.persistPath) {
      this.appendEntry(entry);
    }
  }

  peek(): DlqEntry | undefined {
    return this.entries[0];
  }

  pop(): DlqEntry | undefined {
    const entry = this.entries.shift();
    if (entry && this.persistPath) {
      this.rewriteFile();
    }
    return entry;
  }

  list(): DlqEntry[] {
    return [...this.entries];
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
    if (this.persistPath) {
      this.rewriteFile();
    }
  }

  // ---------------------------------------------------------------------------
  // File persistence helpers
  // ---------------------------------------------------------------------------

  private loadFromFile(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const content = readFileSync(this.persistPath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as DlqEntry;
          this.entries.push(entry);
        } catch {
          this.logger.warn("DLQ persistence: skipping corrupted line", { line: line.slice(0, 100) });
        }
      }
    } catch {
      // File doesn't exist or is unreadable — start fresh
    }
  }

  private appendEntry(entry: DlqEntry): void {
    if (!this.persistPath) return;
    try {
      const dir = dirname(this.persistPath);
      mkdirSync(dir, { recursive: true });
      appendFileSync(this.persistPath, JSON.stringify(entry) + "\n");
    } catch (err) {
      this.logger.warn("DLQ persistence: failed to append entry", { error: String(err) });
    }
  }

  private rewriteFile(): void {
    if (!this.persistPath) return;
    try {
      const content = this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length > 0 ? "\n" : "");
      writeFileSync(this.persistPath, content);
    } catch (err) {
      this.logger.warn("DLQ persistence: failed to rewrite file", { error: String(err) });
    }
  }
}
