import { describe, test, expect } from "bun:test";
import { Effect } from "effect";
import {
  EffectInterruptedError,
  runEffectPromise,
  raceAbort,
  sleep,
  waitForAbort,
  withTimeout,
} from "../../../src/core/effect-concurrency.js";

class TestAbortSignal {
  aborted = false;
  private listeners = new Set<(event: Event) => void>();

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (type !== "abort" || listener === null) return;
    this.listeners.add(normalizeListener(listener));
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
  ): void {
    if (type !== "abort" || listener === null) return;
    this.listeners.delete(normalizeListener(listener));
  }

  triggerAbort(): void {
    if (this.aborted) return;
    this.aborted = true;
    const event = new Event("abort");
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  listenerCount(): number {
    return this.listeners.size;
  }
}

function normalizeListener(listener: EventListenerOrEventListenerObject): (event: Event) => void {
  if (typeof listener === "function") {
    return listener as (event: Event) => void;
  }
  return (event: Event) => listener.handleEvent(event);
}

describe("effect-concurrency", () => {
  test("withTimeout fails when an effect exceeds the timeout", async () => {
    await expect(
      runEffectPromise(withTimeout(sleep(100), 10, () => new Error("timeout"))),
    ).rejects.toThrow("timeout");
  });

  test("raceAbort fails when the abort signal fires first", async () => {
    const abortController = new AbortController();
    const promise = runEffectPromise(
      raceAbort(
        sleep(1000).pipe(Effect.as("ok")),
        abortController.signal,
        () => new Error("aborted"),
      ),
    );

    abortController.abort("stop");
    await expect(promise).rejects.toThrow("aborted");
  });

  test("waitForAbort removes listeners when completed by abort", async () => {
    const waitSignal = new TestAbortSignal();
    const waitPromise = runEffectPromise(waitForAbort(waitSignal as unknown as AbortSignal));

    expect(waitSignal.listenerCount()).toBe(1);
    waitSignal.triggerAbort();
    await waitPromise;

    expect(waitSignal.listenerCount()).toBe(0);
  });

  test("waitForAbort removes listeners when timed out", async () => {
    const waitSignal = new TestAbortSignal();

    await expect(
      runEffectPromise(
        withTimeout(waitForAbort(waitSignal as unknown as AbortSignal), 10, () => new Error("timeout")),
      ),
    ).rejects.toThrow("timeout");

    expect(waitSignal.listenerCount()).toBe(0);
  });

  test("waitForAbort removes listeners when interrupted", async () => {
    const waitSignal = new TestAbortSignal();
    const runtimeAbort = new AbortController();

    const waitPromise = runEffectPromise(waitForAbort(waitSignal as unknown as AbortSignal), {
      signal: runtimeAbort.signal,
    });

    expect(waitSignal.listenerCount()).toBe(1);
    runtimeAbort.abort("stop");
    await expect(waitPromise).rejects.toBeInstanceOf(EffectInterruptedError);

    expect(waitSignal.listenerCount()).toBe(0);
  });
});
