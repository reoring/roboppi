import { describe, test, expect } from "bun:test";
import { RetryPolicy } from "../../../src/scheduler/retry-policy.js";
import { ErrorClass } from "../../../src/types/index.js";

describe("RetryPolicy", () => {
  describe("retryable errors", () => {
    test("RETRYABLE_TRANSIENT is retryable on first attempt", () => {
      const policy = new RetryPolicy();
      const decision = policy.shouldRetry(ErrorClass.RETRYABLE_TRANSIENT, 0);
      expect(decision.retry).toBe(true);
      expect(decision.delayMs).toBeGreaterThanOrEqual(0);
    });

    test("RETRYABLE_RATE_LIMIT is retryable on first attempt", () => {
      const policy = new RetryPolicy();
      const decision = policy.shouldRetry(ErrorClass.RETRYABLE_RATE_LIMIT, 0);
      expect(decision.retry).toBe(true);
      expect(decision.delayMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("non-retryable errors", () => {
    test("NON_RETRYABLE is never retried", () => {
      const policy = new RetryPolicy();
      const decision = policy.shouldRetry(ErrorClass.NON_RETRYABLE, 0);
      expect(decision.retry).toBe(false);
      expect(decision.delayMs).toBe(0);
    });

    test("FATAL is never retried", () => {
      const policy = new RetryPolicy();
      const decision = policy.shouldRetry(ErrorClass.FATAL, 0);
      expect(decision.retry).toBe(false);
      expect(decision.delayMs).toBe(0);
    });
  });

  describe("maxAttempts enforcement", () => {
    test("does not retry when at maxAttempts - 1", () => {
      const policy = new RetryPolicy({ maxAttempts: 3 });
      // attemptIndex 2 is the 3rd attempt (0, 1, 2) => last allowed
      const decision = policy.shouldRetry(ErrorClass.RETRYABLE_TRANSIENT, 2);
      expect(decision.retry).toBe(false);
    });

    test("retries when below maxAttempts - 1", () => {
      const policy = new RetryPolicy({ maxAttempts: 3 });
      const decision = policy.shouldRetry(ErrorClass.RETRYABLE_TRANSIENT, 1);
      expect(decision.retry).toBe(true);
    });

    test("maxAttempts of 1 means no retries at all", () => {
      const policy = new RetryPolicy({ maxAttempts: 1 });
      const decision = policy.shouldRetry(ErrorClass.RETRYABLE_TRANSIENT, 0);
      expect(decision.retry).toBe(false);
    });
  });

  describe("backoff calculation", () => {
    test("delay is bounded by baseDelay * 2^attempt", () => {
      const policy = new RetryPolicy({
        baseDelayMs: 1000,
        maxDelayMs: 100000,
        maxAttempts: 10,
      });

      // Run multiple times to check jitter stays in range
      for (let i = 0; i < 50; i++) {
        const decision = policy.shouldRetry(ErrorClass.RETRYABLE_TRANSIENT, 0);
        if (decision.retry) {
          // For attempt 0: max = min(100000, 1000 * 2^0) = 1000
          expect(decision.delayMs).toBeGreaterThanOrEqual(0);
          expect(decision.delayMs).toBeLessThanOrEqual(1000);
        }
      }
    });

    test("delay is capped by maxDelayMs", () => {
      const policy = new RetryPolicy({
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        maxAttempts: 10,
      });

      // For attempt 5: exponentialDelay = 1000 * 2^5 = 32000, capped at 5000
      for (let i = 0; i < 50; i++) {
        const decision = policy.shouldRetry(ErrorClass.RETRYABLE_TRANSIENT, 5);
        if (decision.retry) {
          expect(decision.delayMs).toBeGreaterThanOrEqual(0);
          expect(decision.delayMs).toBeLessThanOrEqual(5000);
        }
      }
    });

    test("delay increases with attempt index (exponential trend)", () => {
      const policy = new RetryPolicy({
        baseDelayMs: 1000,
        maxDelayMs: 100000,
        maxAttempts: 10,
      });

      // Compare caps: attempt 0 cap = 1000, attempt 3 cap = 8000
      // Over many samples, avg(attempt 3) should be greater than avg(attempt 0)
      let sumAttempt0 = 0;
      let sumAttempt3 = 0;
      const runs = 200;

      for (let i = 0; i < runs; i++) {
        const d0 = policy.shouldRetry(ErrorClass.RETRYABLE_TRANSIENT, 0);
        const d3 = policy.shouldRetry(ErrorClass.RETRYABLE_TRANSIENT, 3);
        if (d0.retry) sumAttempt0 += d0.delayMs;
        if (d3.retry) sumAttempt3 += d3.delayMs;
      }

      expect(sumAttempt3 / runs).toBeGreaterThan(sumAttempt0 / runs);
    });

    test("jitter produces non-deterministic values", () => {
      const policy = new RetryPolicy({
        baseDelayMs: 1000,
        maxDelayMs: 30000,
        maxAttempts: 5,
      });

      const delays = new Set<number>();
      for (let i = 0; i < 20; i++) {
        const decision = policy.shouldRetry(ErrorClass.RETRYABLE_TRANSIENT, 1);
        if (decision.retry) {
          delays.add(decision.delayMs);
        }
      }

      // With jitter, we should get multiple distinct values
      expect(delays.size).toBeGreaterThan(1);
    });
  });

  describe("custom config", () => {
    test("uses default config when none provided", () => {
      const policy = new RetryPolicy();
      // Default: maxAttempts=3, so attempt 0 and 1 should retry
      const d0 = policy.shouldRetry(ErrorClass.RETRYABLE_TRANSIENT, 0);
      expect(d0.retry).toBe(true);
      const d1 = policy.shouldRetry(ErrorClass.RETRYABLE_TRANSIENT, 1);
      expect(d1.retry).toBe(true);
      // attempt 2 is the last (3rd attempt), no retry
      const d2 = policy.shouldRetry(ErrorClass.RETRYABLE_TRANSIENT, 2);
      expect(d2.retry).toBe(false);
    });

    test("partial config overrides only specified fields", () => {
      const policy = new RetryPolicy({ maxAttempts: 5 });
      // Should be retryable at attempt 3 (would fail with default maxAttempts=3)
      const decision = policy.shouldRetry(ErrorClass.RETRYABLE_TRANSIENT, 3);
      expect(decision.retry).toBe(true);
    });
  });
});
