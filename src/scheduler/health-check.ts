import { now } from "../types/index.js";
import type { IpcProtocol } from "../ipc/index.js";

export interface HealthCheckerConfig {
  intervalMs: number;
  unhealthyThresholdMs: number;
}

const DEFAULT_CONFIG: HealthCheckerConfig = {
  intervalMs: 5000,
  unhealthyThresholdMs: 15000,
};

export class HealthChecker {
  private readonly config: HealthCheckerConfig;
  private readonly ipc: IpcProtocol;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastResponseAt: number = 0;
  private unhealthyCallback: (() => void) | null = null;

  constructor(ipc: IpcProtocol, config?: Partial<HealthCheckerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ipc = ipc;
  }

  onUnhealthy(callback: () => void): void {
    this.unhealthyCallback = callback;
  }

  recordHeartbeatResponse(): void {
    this.lastResponseAt = now();
  }

  start(): void {
    if (this.timer) return;
    this.lastResponseAt = now();
    this.timer = setInterval(() => this.check(), this.config.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private checking = false;

  private check(): void {
    if (this.checking) return;
    this.checking = true;
    try {
      const elapsed = now() - this.lastResponseAt;
      if (elapsed > this.config.unhealthyThresholdMs) {
        try {
          this.unhealthyCallback?.();
        } catch {
          // Prevent callback errors from crashing the health check loop
        }
      }
      // Send a heartbeat to Core
      this.ipc.sendHeartbeat(now()).catch(() => {
        // If we can't even send, that's an unhealthy signal
        try {
          this.unhealthyCallback?.();
        } catch {
          // Prevent callback errors from crashing the health check loop
        }
      });
    } finally {
      this.checking = false;
    }
  }
}
