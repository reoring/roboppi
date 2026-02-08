import { now } from "../types/index.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

export interface LogEntry {
  traceId?: string;
  timestamp: number;
  level: LogLevel;
  component: string;
  message: string;
  data?: unknown;
}

export class Logger {
  private _traceId?: string;

  constructor(
    private readonly component: string,
    private readonly minLevel: LogLevel = "debug",
  ) {}

  setTraceId(traceId: string): void {
    this._traceId = traceId;
  }

  debug(message: string, data?: unknown): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    this.log("error", message, data);
  }

  fatal(message: string, data?: unknown): void {
    this.log("fatal", message, data);
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minLevel]) {
      return;
    }
    const entry: LogEntry = {
      timestamp: now(),
      level,
      component: this.component,
      message,
    };
    if (this._traceId) {
      entry.traceId = this._traceId;
    }
    if (data !== undefined) {
      entry.data = data;
    }
    // Output to stderr (stdout is reserved for IPC)
    process.stderr.write(JSON.stringify(entry) + "\n");
  }
}

export interface MetricEntry {
  name: string;
  type: "counter" | "gauge" | "histogram";
  value: number;
  labels?: Record<string, string>;
  timestamp: number;
}

export class MetricsCollector {
  private readonly counters = new Map<string, MetricEntry>();
  private readonly gauges = new Map<string, MetricEntry>();
  private readonly histograms = new Map<string, MetricEntry[]>();

  private labelKey(name: string, labels?: Record<string, string>): string {
    if (!labels || Object.keys(labels).length === 0) return name;
    const sorted = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return `${name}{${sorted}}`;
  }

  counter(name: string, value: number = 1, labels?: Record<string, string>): void {
    const key = this.labelKey(name, labels);
    const existing = this.counters.get(key);
    if (existing) {
      existing.value += value;
      existing.timestamp = now();
    } else {
      this.counters.set(key, { name, type: "counter", value, labels, timestamp: now() });
    }
  }

  gauge(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.labelKey(name, labels);
    this.gauges.set(key, { name, type: "gauge", value, labels, timestamp: now() });
  }

  private static readonly MAX_HISTOGRAM_ENTRIES = 10000;

  histogram(name: string, value: number, labels?: Record<string, string>): void {
    const key = this.labelKey(name, labels);
    const existing = this.histograms.get(key);
    const entry: MetricEntry = { name, type: "histogram", value, labels, timestamp: now() };
    if (existing) {
      existing.push(entry);
      // Prevent unbounded growth: keep recent half when limit exceeded
      if (existing.length >= MetricsCollector.MAX_HISTOGRAM_ENTRIES) {
        existing.splice(0, existing.length - MetricsCollector.MAX_HISTOGRAM_ENTRIES / 2);
      }
    } else {
      this.histograms.set(key, [entry]);
    }
  }

  getMetrics(): MetricEntry[] {
    const result: MetricEntry[] = [];
    for (const entry of Array.from(this.counters.values())) {
      result.push({ ...entry });
    }
    for (const entry of Array.from(this.gauges.values())) {
      result.push({ ...entry });
    }
    for (const entries of Array.from(this.histograms.values())) {
      for (const entry of entries) {
        result.push({ ...entry });
      }
    }
    return result;
  }
}

export class ObservabilityProvider {
  private readonly metrics = new MetricsCollector();
  private readonly minLevel: LogLevel;

  constructor(minLevel: LogLevel = "debug") {
    this.minLevel = minLevel;
  }

  createLogger(component: string): Logger {
    return new Logger(component, this.minLevel);
  }

  getMetrics(): MetricsCollector {
    return this.metrics;
  }
}
