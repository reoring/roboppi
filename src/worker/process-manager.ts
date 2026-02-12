export interface SpawnOptions {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
  timeoutMs?: number;

  /**
   * Best-effort process-tree isolation.
   *
   * When true, the subprocess is started in its own process group so that a
   * cancel/timeout can terminate the whole group (helpful when the worker CLI
   * spawns child processes).
   *
   * Implementation:
   * - Unix: wraps the command with `setsid` (if available)
   * - Windows / missing `setsid`: falls back to a normal spawn
   */
  processGroup?: boolean;
}

export interface ManagedProcess {
  pid: number;
  subprocess: ReturnType<typeof Bun.spawn>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exitPromise: Promise<number>;

  /** True when the subprocess is the leader of its own process group. */
  processGroup: boolean;
}

export class ProcessManager {
  private processes = new Set<ManagedProcess>();

  private readonly setsidPath: string | null;

  constructor() {
    this.setsidPath = (() => {
      if (process.platform === "win32") return null;
      try {
        return Bun.which("setsid");
      } catch {
        return null;
      }
    })();
  }

  spawn(options: SpawnOptions): ManagedProcess {
    const useProcessGroup = options.processGroup === true && this.setsidPath !== null;
    const spawnCommand = useProcessGroup ? [this.setsidPath!, ...options.command] : options.command;

    const subprocess = Bun.spawn(spawnCommand, {
      cwd: options.cwd,
      env: options.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitPromise = subprocess.exited.then((code) => {
      this.processes.forEach((p) => {
        if (p.pid === subprocess.pid) {
          this.processes.delete(p);
        }
      });
      return code;
    });

    const managed: ManagedProcess = {
      pid: subprocess.pid,
      subprocess,
      stdout: subprocess.stdout,
      stderr: subprocess.stderr,
      exitPromise,
      processGroup: useProcessGroup,
    };

    this.processes.add(managed);

    if (options.abortSignal) {
      const onAbort = () => {
        this.kill(managed.pid);
      };
      if (options.abortSignal.aborted) {
        this.kill(managed.pid);
      } else {
        options.abortSignal.addEventListener("abort", onAbort, { once: true });
        // Clean up listener when process exits
        exitPromise.then(() => {
          options.abortSignal!.removeEventListener("abort", onAbort);
        });
      }
    }

    if (options.timeoutMs !== undefined) {
      const timeout = setTimeout(() => {
        this.kill(managed.pid);
      }, options.timeoutMs);
      exitPromise.then(() => clearTimeout(timeout));
    }

    return managed;
  }

  private killManaged(
    managed: ManagedProcess,
    signal: number | NodeJS.Signals = "SIGTERM",
  ): void {
    // If we started the worker as a process-group leader, kill the whole group.
    // This is the best-effort way to avoid leaving orphaned grandchildren.
    if (managed.processGroup) {
      try {
        process.kill(-managed.pid, signal);
        return;
      } catch {
        // Fall back to killing just the main process.
      }
    }

    try {
      managed.subprocess.kill(signal);
    } catch {
      // Process may have already exited
    }
  }

  kill(pid: number, signal: number | NodeJS.Signals = "SIGTERM"): void {
    for (const proc of this.processes) {
      if (proc.pid === pid) {
        this.killManaged(proc, signal);
        return;
      }
    }
  }

  async gracefulShutdown(pid: number, graceMs: number = 5000): Promise<void> {
    let managed: ManagedProcess | undefined;
    for (const proc of this.processes) {
      if (proc.pid === pid) {
        managed = proc;
        break;
      }
    }
    if (!managed) return;

    this.killManaged(managed, "SIGTERM");

    const raceResult = await Promise.race([
      managed.exitPromise.then(() => "exited" as const),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), graceMs)
      ),
    ]);

    if (raceResult === "timeout") {
      this.killManaged(managed, "SIGKILL");

      // Verify process actually stopped after SIGKILL
      const killResult = await Promise.race([
        managed.exitPromise.then(() => "exited" as const),
        new Promise<"stuck">((resolve) =>
          setTimeout(() => resolve("stuck"), 5000)
        ),
      ]);

      if (killResult === "stuck") {
        // Force remove from tracking — process is truly stuck
        this.processes.delete(managed);
      }
    }
  }

  async killAll(): Promise<void> {
    const exitPromises: Promise<number>[] = [];
    for (const proc of this.processes) {
      this.killManaged(proc, "SIGKILL");
      exitPromises.push(proc.exitPromise);
    }
    await Promise.allSettled(exitPromises);
    this.processes.clear();
  }

  getActiveCount(): number {
    return this.processes.size;
  }
}
