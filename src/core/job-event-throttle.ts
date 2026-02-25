import type { WorkerEvent } from "../worker/worker-adapter.js";

const MAX_STDOUT_STDERR_BYTES = 16 * 1024; // 16 KB
const MAX_PATCH_DIFF_BYTES = 256 * 1024; // 256 KB
const MAX_EVENTS_PER_JOB = 500;
const PROGRESS_THROTTLE_MS = 100;
const TRUNCATION_SUFFIX = "...(truncated)";

export interface JobEventThrottleOptions {
  /**
    * When true, forward stdout/stderr events.
    * Default: false (only progress and patch are forwarded).
    *
    * stdout/stderr may contain secrets (tokens, keys, customer data).
    * This option is typically controlled by AgentCore.
    */
  forwardStdio?: boolean;
}

/**
 * Wraps an onEvent callback with backpressure controls:
 * 1. stdout/stderr filtering (off by default — opt-in via forwardStdio)
 * 2. Event data truncation (Buffer.byteLength-based; stdout/stderr/progress at 16 KB, patch diff at 256 KB)
 * 3. Per-job queue limit (max 500 non-progress events; progress always passes through on a separate path)
 * 4. Progress throttling (forward latest progress event at most every 100 ms)
 */
export class JobEventThrottle {
  private eventCount = 0;
  private truncationNoticeSent = false;

  private pendingProgress: WorkerEvent | null = null;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  private lastProgressForwardedAt = 0;

  private readonly forward: (ev: WorkerEvent) => void;
  private readonly forwardStdio: boolean;

  constructor(forward: (ev: WorkerEvent) => void, options?: JobEventThrottleOptions) {
    this.forward = forward;
    this.forwardStdio = options?.forwardStdio ?? false;
  }

  /** Process an incoming event through the throttle pipeline. */
  emit(ev: WorkerEvent): void {
    // Filter stdout/stderr unless explicitly opted in
    if (!this.forwardStdio && (ev.type === "stdout" || ev.type === "stderr")) {
      return;
    }

    const truncated = truncateEvent(ev);

    // Progress events bypass the queue limit and get throttled separately.
    // This ensures long-running jobs always report progress to TUI even when
    // the non-progress event budget is exhausted.
    if (truncated.type === "progress") {
      this.handleProgress(truncated);
      return;
    }

    this.forwardWithLimit(truncated);
  }

  /** Flush any buffered progress event and clean up timers. */
  dispose(): void {
    if (this.progressTimer !== null) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    // Flush any pending progress event
    if (this.pendingProgress !== null) {
      this.forwardDirect(this.pendingProgress);
      this.pendingProgress = null;
    }
  }

  private handleProgress(ev: WorkerEvent): void {
    const elapsed = Date.now() - this.lastProgressForwardedAt;

    if (elapsed >= PROGRESS_THROTTLE_MS) {
      // Enough time has passed — forward immediately
      this.lastProgressForwardedAt = Date.now();
      this.pendingProgress = null;
      if (this.progressTimer !== null) {
        clearTimeout(this.progressTimer);
        this.progressTimer = null;
      }
      this.forwardDirect(ev);
    } else {
      // Buffer the latest progress event and schedule a flush
      this.pendingProgress = ev;
      if (this.progressTimer === null) {
        const delay = PROGRESS_THROTTLE_MS - elapsed;
        this.progressTimer = setTimeout(() => {
          this.progressTimer = null;
          if (this.pendingProgress !== null) {
            this.lastProgressForwardedAt = Date.now();
            const pending = this.pendingProgress;
            this.pendingProgress = null;
            this.forwardDirect(pending);
          }
        }, delay);
      }
    }
  }

  /** Forward without limit check (used for progress, which bypasses queue limit). */
  private forwardDirect(ev: WorkerEvent): void {
    this.forward(ev);
  }

  /** Forward non-progress events with the per-job queue limit. */
  private forwardWithLimit(ev: WorkerEvent): void {
    if (this.eventCount < MAX_EVENTS_PER_JOB) {
      this.eventCount++;
      this.forward(ev);
      return;
    }

    // Limit exceeded — send one truncation notice, then drop silently
    if (!this.truncationNoticeSent) {
      this.truncationNoticeSent = true;
      this.forward({ type: "progress", message: "(logs truncated)" });
    }
  }
}

/**
 * Truncate a string to fit within maxBytes (measured by Buffer.byteLength, UTF-8).
 * Falls back to character-length estimation when Buffer is not available.
 */
function truncateString(s: string, maxBytes: number): string {
  if (typeof Buffer !== "undefined") {
    if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
    // Binary-search for the character index that fits within maxBytes
    const buf = Buffer.from(s, "utf8");
    const truncated = buf.subarray(0, maxBytes).toString("utf8");
    // The last character may be corrupted by slicing mid-codepoint;
    // drop any trailing replacement character.
    const cleaned = truncated.endsWith("\uFFFD")
      ? truncated.slice(0, -1)
      : truncated;
    return cleaned + TRUNCATION_SUFFIX;
  }
  // Fallback: character-based (over-estimates for ASCII, but safe)
  if (s.length <= maxBytes) return s;
  return s.slice(0, maxBytes) + TRUNCATION_SUFFIX;
}

function truncateEvent(ev: WorkerEvent): WorkerEvent {
  switch (ev.type) {
    case "stdout":
      return { type: "stdout", data: truncateString(ev.data, MAX_STDOUT_STDERR_BYTES) };
    case "stderr":
      return { type: "stderr", data: truncateString(ev.data, MAX_STDOUT_STDERR_BYTES) };
    case "progress":
      return {
        type: "progress",
        message: truncateString(ev.message, MAX_STDOUT_STDERR_BYTES),
        ...(ev.percent !== undefined ? { percent: ev.percent } : {}),
      };
    case "patch":
      return {
        type: "patch",
        filePath: ev.filePath,
        diff: truncateString(ev.diff, MAX_PATCH_DIFF_BYTES),
      };
    default:
      return ev;
  }
}
