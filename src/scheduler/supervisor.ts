import type { Subprocess } from "bun";
import { JsonLinesTransport, IpcProtocol } from "../ipc/index.js";
import type { IpcProtocolOptions } from "../ipc/index.js";
import { HealthChecker } from "./health-check.js";
import type { HealthCheckerConfig } from "./health-check.js";

export interface SupervisorConfig {
  coreEntryPoint: string;
  healthCheck?: Partial<HealthCheckerConfig>;
  ipc?: IpcProtocolOptions;
  gracefulShutdownMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
}

const DEFAULT_CONFIG: SupervisorConfig = {
  coreEntryPoint: "src/index.ts",
  gracefulShutdownMs: 5000,
};

export class Supervisor {
  private readonly config: SupervisorConfig;
  private proc: Subprocess<"pipe", "pipe", "inherit"> | null = null;
  private ipc: IpcProtocol | null = null;
  private healthChecker: HealthChecker | null = null;
  private crashCallback: ((exitCode: number | null) => void) | null = null;
  private hangCallback: (() => void) | null = null;
  private restartLimitCallback: (() => void) | null = null;
  private restarting = false;
  private restartTimestamps: number[] = [];

  constructor(config?: Partial<SupervisorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getIpc(): IpcProtocol | null {
    return this.ipc;
  }

  onCoreCrash(callback: (exitCode: number | null) => void): void {
    this.crashCallback = callback;
  }

  onCoreHang(callback: () => void): void {
    this.hangCallback = callback;
  }

  onRestartLimitReached(callback: () => void): void {
    this.restartLimitCallback = callback;
  }

  async spawnCore(): Promise<IpcProtocol> {
    const proc = Bun.spawn(["bun", "run", this.config.coreEntryPoint], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });

    if (!proc || !proc.stdin || !proc.stdout) {
      throw new Error("Failed to spawn Core process: Bun.spawn returned null or missing stdio");
    }

    this.proc = proc;

    let transport: JsonLinesTransport;
    try {
      transport = new JsonLinesTransport(
        proc.stdout as ReadableStream<Uint8Array>,
        proc.stdin as unknown as WritableStream<Uint8Array>,
      );
    } catch (err) {
      // If transport construction fails, kill the process to avoid orphans
      proc.kill();
      await proc.exited;
      this.proc = null;
      throw new Error(`Failed to create IPC transport: ${err instanceof Error ? err.message : String(err)}`);
    }

    const ipc = new IpcProtocol(transport, this.config.ipc);
    this.ipc = ipc;

    // Set up health checking
    const healthChecker = new HealthChecker(ipc, this.config.healthCheck);
    this.healthChecker = healthChecker;

    healthChecker.onUnhealthy(() => {
      this.hangCallback?.();
    });

    // Monitor process exit
    proc.exited.then((exitCode) => {
      if (exitCode !== 0) {
        this.crashCallback?.(exitCode);
      }
    }).catch((_err) => {
      // Process monitoring failed — treat as crash with unknown exit code
      this.crashCallback?.(null);
    });

    ipc.start();
    healthChecker.start();

    return ipc;
  }

  async restartCore(): Promise<IpcProtocol> {
    if (this.restarting) {
      throw new Error("restartCore already in progress");
    }

    const maxRestarts = this.config.maxRestarts ?? 5;
    const windowMs = this.config.restartWindowMs ?? 60000;
    const nowMs = Date.now();

    // Prune timestamps outside the window
    this.restartTimestamps = this.restartTimestamps.filter(
      (ts) => nowMs - ts < windowMs,
    );

    if (this.restartTimestamps.length >= maxRestarts) {
      console.error(
        `Supervisor: restart limit reached (${maxRestarts} restarts within ${windowMs}ms). Not restarting.`,
      );
      this.restartLimitCallback?.();
      throw new Error(
        `Restart limit exceeded: ${maxRestarts} restarts within ${windowMs}ms`,
      );
    }

    this.restarting = true;
    try {
      await this.killCore();
      const ipc = await this.spawnCore();
      this.restartTimestamps.push(Date.now());
      return ipc;
    } finally {
      this.restarting = false;
    }
  }

  async killCore(): Promise<void> {
    this.healthChecker?.stop();
    this.healthChecker = null;

    if (this.ipc) {
      await this.ipc.stop();
      this.ipc = null;
    }

    if (this.proc) {
      const proc = this.proc;
      const graceMs = this.config.gracefulShutdownMs ?? 5000;

      // SIGTERM first for graceful shutdown
      proc.kill("SIGTERM");

      // Race: wait for exit or force-kill after grace period
      const exited = await Promise.race([
        proc.exited.then(() => true as const),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs)),
      ]);

      if (!exited) {
        // Grace period elapsed — force kill
        proc.kill("SIGKILL");
        await proc.exited;
      }

      this.proc = null;
    }
  }

  isRunning(): boolean {
    return this.proc !== null;
  }
}
