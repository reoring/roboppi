import type { DaemonEvent } from "../types.js";

/**
 * An EventSource produces an async stream of DaemonEvents.
 */
export interface EventSource {
  readonly id: string;
  events(): AsyncIterable<DaemonEvent>;
  stop(): Promise<void>;
}

/**
 * Merge multiple EventSources into a single AsyncIterable<DaemonEvent>.
 * Events are yielded as they arrive from any source.
 * When a source ends, remaining sources continue.
 * The merged iterable ends when all sources have ended.
 */
export function mergeEventSources(
  sources: EventSource[],
  maxBufferSize = 10000,
): AsyncIterable<DaemonEvent> {
  return {
    [Symbol.asyncIterator]() {
      const buffer: DaemonEvent[] = [];
      let resolve: (() => void) | null = null;
      let activeCount = sources.length;
      let done = false;
      let overflowWarned = false;

      function notify(): void {
        if (resolve !== null) {
          const r = resolve;
          resolve = null;
          r();
        }
      }

      if (activeCount === 0) {
        return {
          async next() {
            return { value: undefined, done: true };
          },
        };
      }

      for (const source of sources) {
        void (async () => {
          try {
            for await (const event of source.events()) {
              if (done) break;
              if (buffer.length >= maxBufferSize) {
                buffer.shift();
                if (!overflowWarned) {
                  overflowWarned = true;
                  console.warn(`[event-source] Event buffer overflow: dropping oldest events (maxBufferSize=${maxBufferSize})`);
                }
              }
              buffer.push(event);
              notify();
            }
          } catch (_) {
            // Source errored, treat as ended
          } finally {
            activeCount--;
            notify();
          }
        })();
      }

      return {
        async next(): Promise<IteratorResult<DaemonEvent>> {
          while (true) {
            if (buffer.length > 0) {
              return { value: buffer.shift()!, done: false };
            }
            if (activeCount <= 0) {
              return { value: undefined, done: true };
            }
            await new Promise<void>((r) => {
              resolve = r;
            });
          }
        },
        async return() {
          done = true;
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/**
 * Wait for the given number of milliseconds, or resolve early if the
 * AbortSignal fires. Returns true if aborted, false if the timer expired.
 */
export function waitOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(true);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
