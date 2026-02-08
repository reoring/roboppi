export interface MetricSource {
  collect(): Record<string, number>;
}

export type DefenseLevel = "normal" | "shed" | "throttle" | "circuit_open" | "escalation";

const DEFENSE_ORDER: Record<DefenseLevel, number> = {
  normal: 0,
  shed: 1,
  throttle: 2,
  circuit_open: 3,
  escalation: 4,
};

export interface WatchdogThreshold {
  warn: number;
  critical: number;
}

export interface WatchdogConfig {
  intervalMs: number;
  thresholds: Record<string, WatchdogThreshold>;
}

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  intervalMs: 1000,
  thresholds: {
    worker_inflight_count: { warn: 10, critical: 20 },
    worker_queue_lag_ms: { warn: 5000, critical: 15000 },
    worker_timeout_rate: { warn: 0.3, critical: 0.6 },
    worker_cancel_latency_ms: { warn: 5000, critical: 15000 },
    workspace_lock_wait_ms: { warn: 3000, critical: 10000 },
  },
};

export interface WatchdogCallbacks {
  onShed?: (metric: string, value: number) => void;
  onThrottle?: (metric: string, value: number) => void;
  onCircuitOpen?: (metric: string, value: number) => void;
  onEscalation?: (metric: string, value: number) => void;
}

export class Watchdog {
  private readonly config: WatchdogConfig;
  private readonly sources = new Map<string, MetricSource>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentLevel: DefenseLevel = "normal";
  private callbacks: WatchdogCallbacks = {};
  /** Track last fired level per metric for deduplication */
  private lastFiredLevel = new Map<string, DefenseLevel>();
  /** Track how many consecutive checks a metric key has been absent, for pruning */
  private unseenCount = new Map<string, number>();

  constructor(config?: Partial<WatchdogConfig>) {
    this.config = {
      intervalMs: config?.intervalMs ?? DEFAULT_WATCHDOG_CONFIG.intervalMs,
      thresholds: { ...DEFAULT_WATCHDOG_CONFIG.thresholds, ...config?.thresholds },
    };
  }

  registerMetricSource(name: string, source: MetricSource): void {
    this.sources.set(name, source);
  }

  set onShed(cb: (metric: string, value: number) => void) {
    this.callbacks.onShed = cb;
  }

  set onThrottle(cb: (metric: string, value: number) => void) {
    this.callbacks.onThrottle = cb;
  }

  set onCircuitOpen(cb: (metric: string, value: number) => void) {
    this.callbacks.onCircuitOpen = cb;
  }

  set onEscalation(cb: (metric: string, value: number) => void) {
    this.callbacks.onEscalation = cb;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Manually trigger a check cycle (useful for testing) */
  tick(): void {
    const allMetrics = this.collectAll();
    let highestLevel: DefenseLevel = "normal";
    const seenKeys = new Set<string>();

    for (const [metricName, value] of Object.entries(allMetrics)) {
      seenKeys.add(metricName);

      const threshold = this.config.thresholds[metricName];
      if (!threshold) continue;

      let metricLevel: DefenseLevel = "normal";

      if (value >= threshold.critical) {
        // Count how many metrics are critical to determine severity
        const criticalCount = this.countCriticalMetrics(allMetrics);
        if (criticalCount >= 3) {
          metricLevel = "escalation";
        } else if (criticalCount >= 2) {
          metricLevel = "circuit_open";
        } else {
          metricLevel = "throttle";
        }
      } else if (value >= threshold.warn) {
        metricLevel = "shed";
      }

      if (DEFENSE_ORDER[metricLevel] > DEFENSE_ORDER[highestLevel]) {
        highestLevel = metricLevel;
      }

      // Fire callbacks only when level changes for this metric (deduplication)
      const lastLevel = this.lastFiredLevel.get(metricName) ?? "normal";
      if (metricLevel !== lastLevel) {
        this.lastFiredLevel.set(metricName, metricLevel);
        this.fireCallback(metricLevel, metricName, value);
      }
    }

    // Prune lastFiredLevel entries not seen in the last 3 checks
    for (const key of this.lastFiredLevel.keys()) {
      if (seenKeys.has(key)) {
        this.unseenCount.delete(key);
      } else {
        const count = (this.unseenCount.get(key) ?? 0) + 1;
        if (count >= 3) {
          this.lastFiredLevel.delete(key);
          this.unseenCount.delete(key);
        } else {
          this.unseenCount.set(key, count);
        }
      }
    }

    this.currentLevel = highestLevel;
  }

  getCurrentLevel(): DefenseLevel {
    return this.currentLevel;
  }

  private collectAll(): Record<string, number> {
    const merged: Record<string, number> = {};
    for (const [_name, source] of Array.from(this.sources.entries())) {
      try {
        const metrics = source.collect();
        Object.assign(merged, metrics);
      } catch {
        // Skip failing metric sources — don't let one source crash the watchdog
      }
    }
    return merged;
  }

  private countCriticalMetrics(allMetrics: Record<string, number>): number {
    let count = 0;
    for (const [metricName, value] of Object.entries(allMetrics)) {
      const threshold = this.config.thresholds[metricName];
      if (threshold && value >= threshold.critical) {
        count++;
      }
    }
    return count;
  }

  private fireCallback(level: DefenseLevel, metric: string, value: number): void {
    switch (level) {
      case "shed":
        this.callbacks.onShed?.(metric, value);
        break;
      case "throttle":
        this.callbacks.onThrottle?.(metric, value);
        break;
      case "circuit_open":
        this.callbacks.onCircuitOpen?.(metric, value);
        break;
      case "escalation":
        this.callbacks.onEscalation?.(metric, value);
        break;
    }
  }
}
