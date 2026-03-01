import { Cause, Effect, Exit, Option } from "effect";

export interface RunEffectPromiseOptions {
  signal?: AbortSignal;
  suppressUnhandledRejection?: boolean;
}

export class EffectInterruptedError extends Error {
  readonly reason: unknown;

  constructor(reason?: unknown) {
    const detail =
      reason !== undefined && reason !== null
        ? `: ${reason instanceof Error ? reason.message : String(reason)}`
        : "";
    super(`Effect execution interrupted${detail}`);
    this.name = "EffectInterruptedError";
    this.reason = reason;
  }
}

export function runEffectPromise<A, E>(
  effect: Effect.Effect<A, E, never>,
  options?: RunEffectPromiseOptions,
): Promise<A> {
  const promise = Effect.runPromiseExit(effect, { signal: options?.signal }).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }

    const failure = Cause.failureOption(exit.cause);
    if (Option.isSome(failure)) {
      throw failure.value;
    }
    if (Cause.isInterrupted(exit.cause)) {
      throw new EffectInterruptedError(options?.signal?.reason);
    }
    throw Cause.squash(exit.cause);
  });

  if (options?.suppressUnhandledRejection === true) {
    promise.catch(() => {});
  }
  return promise;
}

export function waitForAbort(signal: AbortSignal): Effect.Effect<void> {
  return Effect.async<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.succeed(undefined));
      return;
    }

    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resume(Effect.succeed(undefined));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export function sleep(ms: number): Effect.Effect<void> {
  return Effect.sleep(ms);
}

export function withTimeout<A, E, ETimeout>(
  effect: Effect.Effect<A, E, never>,
  timeoutMs: number,
  onTimeout: () => ETimeout,
): Effect.Effect<A, E | ETimeout, never> {
  return effect.pipe(
    Effect.timeoutFail({
      duration: timeoutMs,
      onTimeout,
    }),
  );
}

export function raceAbort<A, E, EAbort>(
  effect: Effect.Effect<A, E, never>,
  signal: AbortSignal,
  onAbort: () => EAbort,
): Effect.Effect<A, E | EAbort, never> {
  return Effect.raceFirst(
    effect,
    waitForAbort(signal).pipe(
      Effect.flatMap(() => Effect.fail(onAbort())),
    ),
  );
}
