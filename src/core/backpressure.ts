export enum BackpressureResponse {
  ACCEPT = "ACCEPT",
  REJECT = "REJECT",
  DEFER = "DEFER",
  DEGRADE = "DEGRADE",
}

export interface BackpressureThresholds {
  rejectThreshold: number;
  deferThreshold: number;
  degradeThreshold: number;
}

export interface BackpressureMetrics {
  activePermits: number;
  queueDepth: number;
  avgLatencyMs: number;
}

export interface BackpressureConfig {
  maxActivePermits: number;
  maxQueueDepth: number;
  maxLatencyMs: number;
}

const DEFAULT_NORMALIZATION: BackpressureConfig = {
  maxActivePermits: 100,
  maxQueueDepth: 1000,
  maxLatencyMs: 10000,
};

export class BackpressureController {
  private metrics: BackpressureMetrics = {
    activePermits: 0,
    queueDepth: 0,
    avgLatencyMs: 0,
  };
  private readonly normalization: BackpressureConfig;

  constructor(
    private readonly thresholds: BackpressureThresholds,
    normalization?: Partial<BackpressureConfig>,
  ) {
    this.normalization = {
      maxActivePermits: normalization?.maxActivePermits ?? DEFAULT_NORMALIZATION.maxActivePermits,
      maxQueueDepth: normalization?.maxQueueDepth ?? DEFAULT_NORMALIZATION.maxQueueDepth,
      maxLatencyMs: normalization?.maxLatencyMs ?? DEFAULT_NORMALIZATION.maxLatencyMs,
    };
  }

  check(): BackpressureResponse {
    const load = this.computeLoad();

    if (load >= this.thresholds.rejectThreshold) {
      return BackpressureResponse.REJECT;
    }
    if (load >= this.thresholds.deferThreshold) {
      return BackpressureResponse.DEFER;
    }
    if (load >= this.thresholds.degradeThreshold) {
      return BackpressureResponse.DEGRADE;
    }
    return BackpressureResponse.ACCEPT;
  }

  updateMetrics(metrics: BackpressureMetrics): void {
    this.metrics = { ...metrics };
  }

  getMetrics(): BackpressureMetrics {
    return { ...this.metrics };
  }

  private computeLoad(): number {
    const permitLoad = this.metrics.activePermits / this.normalization.maxActivePermits;
    const queueLoad = this.metrics.queueDepth / this.normalization.maxQueueDepth;
    const latencyLoad = this.metrics.avgLatencyMs / this.normalization.maxLatencyMs;
    return Math.max(permitLoad, queueLoad, latencyLoad);
  }
}
