import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type { DaemonEvent, FSWatchEventDef } from "../types.js";
import type { EventSource } from "./event-source.js";

/**
 * Simple glob matching supporting *, **, and ? patterns.
 */
export function globMatch(pattern: string, filepath: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(filepath);
}

function globToRegex(pattern: string): RegExp {
  let i = 0;
  let regexStr = "^";
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches anything including /
        if (pattern[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        // * matches anything except /
        regexStr += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
      i++;
    } else if (ch === ".") {
      regexStr += "\\.";
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

interface PendingChange {
  path: string;
  event: "create" | "modify" | "delete";
}

export class FSWatchSource implements EventSource {
  readonly id: string;
  private readonly config: FSWatchEventDef;
  private readonly abortController = new AbortController();
  private readonly watchers: FSWatcher[] = [];
  private readonly batchMs: number;

  private pendingChanges: PendingChange[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private emitResolve: ((event: DaemonEvent) => void) | null = null;
  private eventBuffer: DaemonEvent[] = [];

  constructor(id: string, config: FSWatchEventDef, batchMs = 200) {
    this.id = id;
    this.config = config;
    this.batchMs = batchMs;
  }

  async *events(): AsyncGenerator<DaemonEvent> {
    const signal = this.abortController.signal;

    // Resolve paths relative to cwd
    const resolvedPaths = this.config.paths.map((p) =>
      path.isAbsolute(p) ? p : path.resolve(process.cwd(), p),
    );

    // Start watchers
    for (const watchPath of resolvedPaths) {
      try {
        const watcher = watch(
          watchPath,
          { recursive: true, signal },
          (eventType, filename) => {
            if (signal.aborted || filename === null) return;
            this.handleFSEvent(eventType, filename, watchPath);
          },
        );
        this.watchers.push(watcher);
      } catch (_) {
        // Path may not exist yet, skip
      }
    }

    // Yield events as they arrive
    while (!signal.aborted) {
      if (this.eventBuffer.length > 0) {
        yield this.eventBuffer.shift()!;
        continue;
      }

      const event = await new Promise<DaemonEvent | null>((resolve) => {
        if (signal.aborted) {
          resolve(null);
          return;
        }
        this.emitResolve = resolve;
        const onAbort = () => {
          this.emitResolve = null;
          resolve(null);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });

      if (event === null) break;
      yield event;
    }
  }

  async stop(): Promise<void> {
    // Flush pending batch immediately
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
      if (this.pendingChanges.length > 0) {
        this.flushBatch();
      }
    }

    this.abortController.abort();
    for (const w of this.watchers) {
      w.close();
    }
    this.watchers.length = 0;
  }

  private handleFSEvent(
    eventType: string,
    filename: string,
    _basePath: string,
  ): void {
    const filepath = filename;

    // Check if any path pattern matches
    const matchesPaths = this.config.paths.some((pattern) => {
      // If pattern is a directory (no glob chars), accept anything under it
      if (!/[*?]/.test(pattern)) return true;
      return globMatch(pattern, filepath);
    });
    if (!matchesPaths) return;

    // Check ignore patterns
    if (this.config.ignore) {
      const ignored = this.config.ignore.some((pattern) =>
        globMatch(pattern, filepath),
      );
      if (ignored) return;
    }

    // Map fs event type to our event type
    const changeType = eventType === "rename" ? "create" : "modify";

    // Filter by event types
    if (this.config.events && !this.config.events.includes(changeType)) {
      return;
    }

    // Deduplicate within the current batch
    const existing = this.pendingChanges.find(
      (c) => c.path === filepath && c.event === changeType,
    );
    if (existing) return;

    this.pendingChanges.push({ path: filepath, event: changeType });

    // Start or reset the batch timer
    if (this.batchTimer !== null) {
      clearTimeout(this.batchTimer);
    }
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.flushBatch();
    }, this.batchMs);
  }

  private flushBatch(): void {
    if (this.pendingChanges.length === 0) return;

    const changes = [...this.pendingChanges];
    this.pendingChanges = [];

    const event: DaemonEvent = {
      sourceId: this.id,
      timestamp: Date.now(),
      payload: {
        type: "fswatch",
        changes,
      },
    };

    if (this.emitResolve) {
      const resolve = this.emitResolve;
      this.emitResolve = null;
      resolve(event);
    } else {
      this.eventBuffer.push(event);
    }
  }
}
