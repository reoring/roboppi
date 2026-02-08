import { CircuitState } from "../types/index.js";

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenMaxAttempts: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 3,
};

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private halfOpenAttempts = 0;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly config: CircuitBreakerConfig = DEFAULT_CONFIG) {}

  recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.CLOSED;
      this.failureCount = 0;
      this.halfOpenAttempts = 0;
    } else if (this.state === CircuitState.CLOSED) {
      this.failureCount = 0;
    }
  }

  recordFailure(): void {
    this.failureCount++;

    if (this.state === CircuitState.HALF_OPEN) {
      this.halfOpenAttempts++;
      if (this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
        this.tripOpen();
      }
    } else if (this.state === CircuitState.CLOSED) {
      if (this.failureCount >= this.config.failureThreshold) {
        this.tripOpen();
      }
    }
  }

  isOpen(): boolean {
    return this.state === CircuitState.OPEN;
  }

  getState(): CircuitState {
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  dispose(): void {
    if (this.resetTimer !== null) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }

  private tripOpen(): void {
    this.state = CircuitState.OPEN;
    this.halfOpenAttempts = 0;

    if (this.resetTimer !== null) {
      clearTimeout(this.resetTimer);
    }
    this.resetTimer = setTimeout(() => {
      this.state = CircuitState.HALF_OPEN;
      this.halfOpenAttempts = 0;
      this.resetTimer = null;
    }, this.config.resetTimeoutMs);
  }
}

export class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly defaultConfig?: CircuitBreakerConfig) {}

  getOrCreate(provider: string, config?: CircuitBreakerConfig): CircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      breaker = new CircuitBreaker(config ?? this.defaultConfig ?? DEFAULT_CONFIG);
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }

  get(provider: string): CircuitBreaker | undefined {
    return this.breakers.get(provider);
  }

  isAnyOpen(): boolean {
    for (const breaker of this.breakers.values()) {
      if (breaker.isOpen()) return true;
    }
    return false;
  }

  getSnapshot(): Record<string, CircuitState> {
    const snapshot: Record<string, CircuitState> = {};
    for (const [provider, breaker] of this.breakers) {
      snapshot[provider] = breaker.getState();
    }
    return snapshot;
  }

  dispose(): void {
    for (const breaker of this.breakers.values()) {
      breaker.dispose();
    }
    this.breakers.clear();
  }
}
