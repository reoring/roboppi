import { describe, test, expect, afterEach } from "bun:test";
import { CircuitBreaker, CircuitBreakerRegistry } from "../../../src/core/circuit-breaker.js";
import { CircuitState } from "../../../src/types/index.js";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  afterEach(() => {
    breaker?.dispose();
  });

  test("starts in CLOSED state", () => {
    breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000, halfOpenMaxAttempts: 2 });
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.isOpen()).toBe(false);
  });

  test("stays CLOSED when failures are below threshold", () => {
    breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000, halfOpenMaxAttempts: 2 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.isOpen()).toBe(false);
  });

  test("trips to OPEN when failure threshold reached", () => {
    breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000, halfOpenMaxAttempts: 2 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(breaker.isOpen()).toBe(true);
  });

  test("recordSuccess resets failure count in CLOSED state", () => {
    breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000, halfOpenMaxAttempts: 2 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.getFailureCount()).toBe(0);
    // Now 3 more failures needed to trip
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  test("transitions from OPEN to HALF_OPEN after resetTimeoutMs", async () => {
    breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50, halfOpenMaxAttempts: 2 });
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
  });

  test("HALF_OPEN transitions to CLOSED on success", async () => {
    breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50, halfOpenMaxAttempts: 2 });
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    breaker.recordSuccess();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  test("HALF_OPEN trips back to OPEN after too many failures", async () => {
    breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50, halfOpenMaxAttempts: 2 });
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);
  });
});

describe("CircuitBreaker concurrent scenarios", () => {
  let breaker: CircuitBreaker;

  afterEach(() => {
    breaker?.dispose();
  });

  test("multiple rapid failures transition to OPEN", () => {
    breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60000, halfOpenMaxAttempts: 2 });

    // Rapid-fire failures
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(breaker.isOpen()).toBe(true);
  });

  test("success during HALF_OPEN transitions to CLOSED", async () => {
    breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50, halfOpenMaxAttempts: 3 });

    // Trip to OPEN
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Wait for HALF_OPEN
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // A success should close the breaker
    breaker.recordSuccess();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.getFailureCount()).toBe(0);
  });

  test("failure during HALF_OPEN transitions back to OPEN", async () => {
    breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50, halfOpenMaxAttempts: 1 });

    // Trip to OPEN
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Wait for HALF_OPEN
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // A failure should trip back to OPEN
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(breaker.isOpen()).toBe(true);
  });

  test("HALF_OPEN allows some failures before tripping back to OPEN", async () => {
    breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50, halfOpenMaxAttempts: 3 });

    // Trip to OPEN
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Wait for HALF_OPEN
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // 2 failures should still be HALF_OPEN (halfOpenMaxAttempts=3)
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // 3rd failure trips back to OPEN
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);
  });

  test("rapid state transitions: CLOSED → OPEN → HALF_OPEN → CLOSED cycle", async () => {
    breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50, halfOpenMaxAttempts: 2 });

    // CLOSED → OPEN
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // OPEN → HALF_OPEN
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // HALF_OPEN → CLOSED
    breaker.recordSuccess();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    // Can trip again from fresh state
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);
  });
});

describe("CircuitBreakerRegistry global safety valve", () => {
  let registry: CircuitBreakerRegistry;

  afterEach(() => {
    registry?.dispose();
  });

  test("one CB open causes isAnyOpen to reject all permits via registry snapshot", () => {
    registry = new CircuitBreakerRegistry({
      failureThreshold: 1,
      resetTimeoutMs: 60000,
      halfOpenMaxAttempts: 1,
    });

    // Create multiple breakers
    registry.getOrCreate("openai");
    registry.getOrCreate("anthropic");

    // Only trip one breaker
    registry.getOrCreate("openai").recordFailure();

    // Registry should report any open
    expect(registry.isAnyOpen()).toBe(true);

    // Snapshot should show OpenAI OPEN and Anthropic CLOSED
    const snapshot = registry.getSnapshot();
    expect(snapshot["openai"]).toBe(CircuitState.OPEN);
    expect(snapshot["anthropic"]).toBe(CircuitState.CLOSED);
  });

  test("multiple breakers open all show in snapshot", () => {
    registry = new CircuitBreakerRegistry({
      failureThreshold: 1,
      resetTimeoutMs: 60000,
      halfOpenMaxAttempts: 1,
    });

    registry.getOrCreate("openai").recordFailure();
    registry.getOrCreate("anthropic").recordFailure();

    const snapshot = registry.getSnapshot();
    expect(snapshot["openai"]).toBe(CircuitState.OPEN);
    expect(snapshot["anthropic"]).toBe(CircuitState.OPEN);
    expect(registry.isAnyOpen()).toBe(true);
  });

  test("closing one breaker while another stays open still reports isAnyOpen", async () => {
    registry = new CircuitBreakerRegistry({
      failureThreshold: 1,
      resetTimeoutMs: 50,
      halfOpenMaxAttempts: 1,
    });

    registry.getOrCreate("openai").recordFailure();
    registry.getOrCreate("anthropic").recordFailure();
    expect(registry.isAnyOpen()).toBe(true);

    // Wait for both to go to HALF_OPEN
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Close only openai
    registry.getOrCreate("openai").recordSuccess();
    expect(registry.getOrCreate("openai").getState()).toBe(CircuitState.CLOSED);

    // anthropic still HALF_OPEN, not OPEN — so isAnyOpen depends on state
    expect(registry.getOrCreate("anthropic").getState()).toBe(CircuitState.HALF_OPEN);
    // HALF_OPEN is not OPEN, so isAnyOpen should be false
    expect(registry.isAnyOpen()).toBe(false);
  });
});

describe("CircuitBreakerRegistry", () => {
  let registry: CircuitBreakerRegistry;

  afterEach(() => {
    registry?.dispose();
  });

  test("getOrCreate creates a new breaker for unknown provider", () => {
    registry = new CircuitBreakerRegistry();
    const breaker = registry.getOrCreate("openai");
    expect(breaker).toBeInstanceOf(CircuitBreaker);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  test("getOrCreate returns same instance for same provider", () => {
    registry = new CircuitBreakerRegistry();
    const a = registry.getOrCreate("openai");
    const b = registry.getOrCreate("openai");
    expect(a).toBe(b);
  });

  test("get returns undefined for unknown provider", () => {
    registry = new CircuitBreakerRegistry();
    expect(registry.get("unknown")).toBeUndefined();
  });

  test("get returns existing breaker", () => {
    registry = new CircuitBreakerRegistry();
    const created = registry.getOrCreate("openai");
    expect(registry.get("openai")).toBe(created);
  });

  test("isAnyOpen returns false when all are closed", () => {
    registry = new CircuitBreakerRegistry();
    registry.getOrCreate("openai");
    registry.getOrCreate("anthropic");
    expect(registry.isAnyOpen()).toBe(false);
  });

  test("isAnyOpen returns true when one is open", () => {
    registry = new CircuitBreakerRegistry({
      failureThreshold: 1,
      resetTimeoutMs: 60000,
      halfOpenMaxAttempts: 1,
    });
    registry.getOrCreate("openai").recordFailure();
    registry.getOrCreate("anthropic");
    expect(registry.isAnyOpen()).toBe(true);
  });

  test("getSnapshot returns state for all providers", () => {
    registry = new CircuitBreakerRegistry({
      failureThreshold: 1,
      resetTimeoutMs: 60000,
      halfOpenMaxAttempts: 1,
    });
    registry.getOrCreate("openai");
    registry.getOrCreate("anthropic").recordFailure();

    const snapshot = registry.getSnapshot();
    expect(snapshot["openai"]).toBe(CircuitState.CLOSED);
    expect(snapshot["anthropic"]).toBe(CircuitState.OPEN);
  });
});
