export interface SpawnOptions {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}

export interface ManagedProcess {
  pid: number;
  subprocess: ReturnType<typeof Bun.spawn>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exitPromise: Promise<number>;
}

export class ProcessManager {
  private processes = new Set<ManagedProcess>();

  spawn(options: SpawnOptions): ManagedProcess {
    const subprocess = Bun.spawn(options.command, {
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

  kill(pid: number, signal: string = "SIGTERM"): void {
    for (const proc of this.processes) {
      if (proc.pid === pid) {
        try {
          process.kill(pid, signal);
        } catch {
          // Process may have already exited
        }
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

    this.kill(pid, "SIGTERM");

    const raceResult = await Promise.race([
      managed.exitPromise.then(() => "exited" as const),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), graceMs)
      ),
    ]);

    if (raceResult === "timeout") {
      this.kill(pid, "SIGKILL");

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
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // Process may have already exited
      }
      exitPromises.push(proc.exitPromise);
    }
    await Promise.allSettled(exitPromises);
    this.processes.clear();
  }

  getActiveCount(): number {
    return this.processes.size;
  }
}
