import { ErrorClass } from "../types/index.js";

export interface RetryPolicyConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

const DEFAULT_CONFIG: RetryPolicyConfig = {
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  maxAttempts: 3,
};

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
}

export class RetryPolicy {
  private readonly config: RetryPolicyConfig;

  constructor(config?: Partial<RetryPolicyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  shouldRetry(errorClass: ErrorClass, attemptIndex: number): RetryDecision {
    if (!this.isRetryable(errorClass)) {
      return { retry: false, delayMs: 0 };
    }

    if (attemptIndex >= this.config.maxAttempts - 1) {
      return { retry: false, delayMs: 0 };
    }

    // Exponential backoff with full jitter:
    // delay = random(0, min(maxDelay, baseDelay * 2^attempt))
    const exponentialDelay = this.config.baseDelayMs * Math.pow(2, attemptIndex);
    const cappedDelay = Math.min(this.config.maxDelayMs, exponentialDelay);
    const jitteredDelay = Math.random() * cappedDelay;

    return { retry: true, delayMs: jitteredDelay };
  }

  private isRetryable(errorClass: ErrorClass): boolean {
    return (
      errorClass === ErrorClass.RETRYABLE_TRANSIENT ||
      errorClass === ErrorClass.RETRYABLE_RATE_LIMIT ||
      errorClass === ErrorClass.RETRYABLE_NETWORK ||
      errorClass === ErrorClass.RETRYABLE_SERVICE
    );
  }
}
