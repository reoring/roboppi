import { JsonLinesTransport, IpcProtocol } from "../ipc/index.js";
import type { IpcProtocolOptions } from "../ipc/index.js";
import { HealthChecker } from "./health-check.js";
import type { HealthCheckerConfig } from "./health-check.js";
import { Logger } from "../core/observability.js";
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Readable, Writable } from "node:stream";

export interface SupervisorConfig {
  /**
   * Core entrypoint.
   *
   * - If this ends with .ts/.js, Supervisor spawns: `bun <coreEntryPoint>`
   * - Otherwise, Supervisor spawns: `<coreEntryPoint>` (as an executable on PATH or a file path)
   */
  coreEntryPoint: string;
  healthCheck?: Partial<HealthCheckerConfig>;
  ipc?: IpcProtocolOptions;
  ipcTransport?: "stdio" | "socket" | "tcp";
  gracefulShutdownMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  /** When set, Core stderr lines are forwarded as callbacks instead of piped to process.stderr. */
  onCoreStderrLine?: (line: string) => void;
}

const DEFAULT_CONFIG: SupervisorConfig = {
  coreEntryPoint: "src/index.ts",
  gracefulShutdownMs: 5000,
};

export class Supervisor {
  private readonly config: SupervisorConfig;
  private readonly logger: Logger;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private procExitPromise: Promise<number | null> | null = null;
  private ipc: IpcProtocol | null = null;
  private healthChecker: HealthChecker | null = null;
  private crashCallback: ((exitCode: number | null) => void) | null = null;
  private hangCallback: (() => void) | null = null;
  private restartLimitCallback: (() => void) | null = null;
  private restarting = false;
  private restartTimestamps: number[] = [];

  private ipcServer: Server | null = null;
  private ipcSocketDir: string | null = null;
  private ipcSocketPath: string | null = null;

  constructor(config?: Partial<SupervisorConfig>, logger?: Logger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger ?? new Logger("supervisor");
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
    const childEnv = collectChildEnv();

    const transport = resolveSupervisedIpcTransport(this.config);
    if (transport === "socket") {
      return this.spawnCoreSocket(childEnv);
    }
    if (transport === "tcp") {
      return this.spawnCoreTcp(childEnv);
    }
    return this.spawnCoreStdio(childEnv);
  }

  private resolveCoreCommand(): { command: string; args: string[] } {
    const entry = this.config.coreEntryPoint;
    const lower = entry.toLowerCase();
    // Treat TS/JS entrypoints as Bun scripts.
    if (lower.endsWith(".ts") || lower.endsWith(".js") || lower.endsWith(".tsx") || lower.endsWith(".jsx")) {
      return { command: "bun", args: [entry] };
    }
    // Otherwise spawn as an executable.
    return { command: entry, args: [] };
  }

  private async spawnCoreStdio(childEnv: Record<string, string>): Promise<IpcProtocol> {
    // Use node:child_process.spawn rather than Bun.spawn for Core IPC.
    // Some environments exhibit dropped/undelivered stdin data with Bun.spawn.
    const core = this.resolveCoreCommand();
    const proc = nodeSpawn(core.command, core.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    }) as unknown as ChildProcessWithoutNullStreams;

    if (!proc.pid || !proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error("Failed to spawn Core process: missing stdio handles");
    }

    if (process.env.ROBOPPI_IPC_TRACE === "1") {
      try {
        process.stderr.write(
          `[IPC][spawn] impl=node_child_process transport=stdio core pid=${proc.pid} cmd=${core.command} args=${core.args.join(" ") || "(none)"} entry=${this.config.coreEntryPoint}\n`,
        );
      } catch {
        // ignore
      }
    }

    proc.stdin.on("error", (err) => {
      try {
        process.stderr.write(
          `[IPC][core-stdin-error] pid=${proc.pid} err=${err instanceof Error ? err.message : String(err)}\n`,
        );
      } catch {
        // ignore
      }
    });

    this.proc = proc;
    this.procExitPromise = new Promise<number | null>((resolve) => {
      proc.once("exit", (code) => resolve(code));
      proc.once("error", () => resolve(null));
    });

    // Forward Core stderr to parent stderr for visibility.
    // (stdout is reserved for IPC.)
    this.forwardCoreStderr(proc.stderr);

    let transport: JsonLinesTransport;
    try {
      // JsonLinesTransport expects Web streams.
      const input = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;

      const output = new WritableStream<Uint8Array>({
        async write(chunk) {
          const data = Buffer.from(chunk);

          // Always provide a callback and await it.
          // In some runtimes, writes without a callback may not flush reliably.
          await new Promise<void>((resolve, reject) => {
            try {
              proc.stdin.write(data, (err) => {
                if (err) reject(err);
                else resolve();
              });
            } catch (err) {
              reject(err);
            }
          });

          // Best-effort flush for runtimes that buffer aggressively.
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (proc.stdin as any).flush?.();
          } catch {
            // ignore
          }
        },
        close() {
          try {
            proc.stdin.end();
          } catch {
            // ignore
          }
        },
        abort() {
          try {
            proc.stdin.end();
          } catch {
            // ignore
          }
        },
      });

      transport = new JsonLinesTransport(input, output);
    } catch (err) {
      // If transport construction fails, kill the process to avoid orphans
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      await this.procExitPromise;
      this.proc = null;
      this.procExitPromise = null;
      throw new Error(`Failed to create IPC transport: ${err instanceof Error ? err.message : String(err)}`);
    }

    const ipc = this.finishSpawn(transport);
    return ipc;
  }

  private async spawnCoreSocket(childEnv: Record<string, string>): Promise<IpcProtocol> {
    // Socket transport for supervised mode.
    // This avoids relying on child stdin/stdout pipes, which can be unreliable
    // in some non-interactive runners.

    await this.cleanupSocketArtifacts();

    const socketDir = await mkdtemp(path.join(os.tmpdir(), "roboppi-ipc-"));
    const socketPath = path.join(socketDir, "core.sock");
    this.ipcSocketDir = socketDir;
    this.ipcSocketPath = socketPath;

    const server = createServer();
    this.ipcServer = server;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const onListening = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          server.off("error", onError);
          server.off("listening", onListening);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(socketPath);
      });
    } catch (err) {
      // Some sandboxed environments disallow Unix domain sockets entirely (listen EPERM/EACCES).
      if (isUnixSocketListenUnsupported(err)) {
        if (process.env.ROBOPPI_IPC_TRACE === "1") {
          try {
            const code = getErrCode(err) ?? "unknown";
            process.stderr.write(
              `[IPC][supervisor] unix socket listen failed (code=${code}); falling back to tcp\n`,
            );
          } catch {
            // ignore
          }
        }
        await this.cleanupSocketArtifacts();
        return this.spawnCoreTcp(childEnv);
      }
      throw err;
    }

    // Ensure Core selects the Unix socket path mode.
    delete childEnv.ROBOPPI_IPC_SOCKET_HOST;
    delete childEnv.ROBOPPI_IPC_SOCKET_PORT;
    delete childEnv.ROBOPPI_IPC_SOCKET_HOST;
    delete childEnv.ROBOPPI_IPC_SOCKET_PORT;
    childEnv.ROBOPPI_IPC_SOCKET_PATH = socketPath;
    childEnv.ROBOPPI_IPC_SOCKET_PATH = socketPath;

    const core = this.resolveCoreCommand();
    const proc = nodeSpawn(core.command, core.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    }) as unknown as ChildProcessWithoutNullStreams;

    if (!proc.pid || !proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error("Failed to spawn Core process: missing stdio handles");
    }

    if (process.env.ROBOPPI_IPC_TRACE === "1") {
      try {
        process.stderr.write(
          `[IPC][spawn] impl=node_child_process transport=socket core pid=${proc.pid} cmd=${core.command} args=${core.args.join(" ") || "(none)"} entry=${this.config.coreEntryPoint} socket=${socketPath}\n`,
        );
      } catch {
        // ignore
      }
    }

    this.proc = proc;
    this.procExitPromise = new Promise<number | null>((resolve) => {
      proc.once("exit", (code) => resolve(code));
      proc.once("error", () => resolve(null));
    });

    // Forward Core stderr to parent stderr for visibility.
    this.forwardCoreStderr(proc.stderr);

    // Wait for Core to connect.
    const connectTimeoutMs = Math.min(15000, this.config.ipc?.requestTimeoutMs ?? 15000);
    let socket: Socket;
    try {
      socket = await withTimeout(
        new Promise<Socket>((resolve, reject) => {
          const onError = (err: Error) => {
            cleanup();
            reject(err);
          };
          const onConn = (s: Socket) => {
            cleanup();
            resolve(s);
          };
          const cleanup = () => {
            server.off("error", onError);
            server.off("connection", onConn);
          };
          server.once("error", onError);
          server.once("connection", onConn);
        }),
        connectTimeoutMs,
        new Error(`Timed out waiting for Core IPC socket connection after ${connectTimeoutMs}ms`),
      );
    } catch (err) {
      // Avoid leaving an orphaned Core process or a dangling server.
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      await this.procExitPromise;
      this.proc = null;
      this.procExitPromise = null;
      await this.cleanupSocketArtifacts();
      throw err;
    }

    try {
      socket.setNoDelay(true);
    } catch {
      // ignore
    }

    // Stop accepting new connections (do NOT await full close; it can block until
    // the active IPC socket disconnects).
    try {
      server.close();
    } catch {
      // ignore
    }

    const input = Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>;
    const output = Writable.toWeb(socket) as unknown as WritableStream<Uint8Array>;
    const transport = new JsonLinesTransport(input, output);

    const ipc = this.finishSpawn(transport);
    return ipc;
  }

  private async spawnCoreTcp(childEnv: Record<string, string>): Promise<IpcProtocol> {
    // TCP loopback transport for supervised mode.
    // Intended as a fallback for environments where Unix domain sockets are blocked.

    await this.cleanupSocketArtifacts();

    const server = createServer();
    this.ipcServer = server;

    const host = "127.0.0.1";

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        server.off("error", onError);
        server.off("listening", onListening);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host, port: 0 });
    });

    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error(`Failed to resolve TCP IPC listen address: ${String(addr)}`);
    }

    // Ensure Core selects the TCP mode.
    delete childEnv.ROBOPPI_IPC_SOCKET_PATH;
    delete childEnv.ROBOPPI_IPC_SOCKET_PATH;
    childEnv.ROBOPPI_IPC_SOCKET_HOST = addr.address || host;
    childEnv.ROBOPPI_IPC_SOCKET_PORT = String(addr.port);
    childEnv.ROBOPPI_IPC_SOCKET_HOST = addr.address || host;
    childEnv.ROBOPPI_IPC_SOCKET_PORT = String(addr.port);

    const core = this.resolveCoreCommand();
    const proc = nodeSpawn(core.command, core.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    }) as unknown as ChildProcessWithoutNullStreams;

    if (!proc.pid || !proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error("Failed to spawn Core process: missing stdio handles");
    }

    if (process.env.ROBOPPI_IPC_TRACE === "1") {
      try {
        process.stderr.write(
          `[IPC][spawn] impl=node_child_process transport=tcp core pid=${proc.pid} cmd=${core.command} args=${core.args.join(" ") || "(none)"} entry=${this.config.coreEntryPoint} addr=${addr.address}:${addr.port}\n`,
        );
      } catch {
        // ignore
      }
    }

    this.proc = proc;
    this.procExitPromise = new Promise<number | null>((resolve) => {
      proc.once("exit", (code) => resolve(code));
      proc.once("error", () => resolve(null));
    });

    // Forward Core stderr to parent stderr for visibility.
    this.forwardCoreStderr(proc.stderr);

    const connectTimeoutMs = Math.min(15000, this.config.ipc?.requestTimeoutMs ?? 15000);
    let socket: Socket;
    try {
      socket = await withTimeout(
        new Promise<Socket>((resolve, reject) => {
          const onError = (err: Error) => {
            cleanup();
            reject(err);
          };
          const onConn = (s: Socket) => {
            cleanup();
            resolve(s);
          };
          const cleanup = () => {
            server.off("error", onError);
            server.off("connection", onConn);
          };
          server.once("error", onError);
          server.once("connection", onConn);
        }),
        connectTimeoutMs,
        new Error(`Timed out waiting for Core IPC TCP connection after ${connectTimeoutMs}ms`),
      );
    } catch (err) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      await this.procExitPromise;
      this.proc = null;
      this.procExitPromise = null;
      await this.cleanupSocketArtifacts();
      throw err;
    }

    try {
      socket.setNoDelay(true);
    } catch {
      // ignore
    }

    // Stop accepting new connections (do NOT await full close; it can block until
    // the active IPC socket disconnects).
    try {
      server.close();
    } catch {
      // ignore
    }

    const input = Readable.toWeb(socket) as unknown as ReadableStream<Uint8Array>;
    const output = Writable.toWeb(socket) as unknown as WritableStream<Uint8Array>;
    const transport = new JsonLinesTransport(input, output);

    const ipc = this.finishSpawn(transport);
    return ipc;
  }

  private finishSpawn(transport: JsonLinesTransport): IpcProtocol {
    const ipc = new IpcProtocol(transport, this.config.ipc);
    this.ipc = ipc;

    // Set up health checking
    const healthChecker = new HealthChecker(ipc, this.config.healthCheck);
    this.healthChecker = healthChecker;

    healthChecker.onUnhealthy(() => {
      this.hangCallback?.();
    });

    // Monitor process exit
    this.procExitPromise!.then((exitCode) => {
      if (exitCode !== 0) {
        this.crashCallback?.(exitCode);
      }
    }).catch(() => {
      // best-effort
      this.crashCallback?.(null);
    });

    ipc.start();
    healthChecker.start();

    return ipc;
  }

  private async cleanupSocketArtifacts(): Promise<void> {
    if (this.ipcServer) {
      try {
        await new Promise<void>((resolve) => this.ipcServer!.close(() => resolve()));
      } catch {
        // ignore
      }
      this.ipcServer = null;
    }

    const socketPath = this.ipcSocketPath;
    const socketDir = this.ipcSocketDir;
    this.ipcSocketPath = null;
    this.ipcSocketDir = null;

    if (socketPath) {
      await rm(socketPath, { force: true }).catch(() => {});
    }
    if (socketDir) {
      await rm(socketDir, { recursive: true, force: true }).catch(() => {});
    }
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
      this.logger.error(
        "Restart limit reached, not restarting",
        { maxRestarts, windowMs },
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
      const procExitPromise = this.procExitPromise;
      const graceMs = this.config.gracefulShutdownMs ?? 5000;

      // SIGTERM first for graceful shutdown
      proc.kill("SIGTERM");

      // Race: wait for exit or force-kill after grace period
      const exited = await Promise.race([
        (procExitPromise ?? Promise.resolve(null)).then(() => true as const),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), graceMs)),
      ]);

      if (!exited) {
        // Grace period elapsed — force kill
        proc.kill("SIGKILL");
        await (procExitPromise ?? Promise.resolve(null));
      }

      this.proc = null;
      this.procExitPromise = null;
    }

    await this.cleanupSocketArtifacts();
  }

  private forwardCoreStderr(stream: unknown): void {
    const onLine = this.config.onCoreStderrLine;

    if (onLine) {
      this.forwardCoreStderrAsLines(stream, onLine);
      return;
    }

    // Best-effort: forward Core stderr to this process's stderr.
    // Supports both Web ReadableStream<Uint8Array> and NodeJS.ReadableStream.
    const s = stream as any;

    if (s && typeof s.getReader === "function") {
      const reader = (s as ReadableStream<Uint8Array>).getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (process.stderr as any).write(value);
            }
          }
        } catch {
          // ignore
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // ignore
          }
        }
      })().catch(() => {});
      return;
    }

    if (s && typeof s.on === "function") {
      try {
        s.on("data", (chunk: unknown) => {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (process.stderr as any).write(chunk as any);
          } catch {
            // ignore
          }
        });
        s.on("error", () => {});
      } catch {
        // ignore
      }
    }
  }

  private forwardCoreStderrAsLines(stream: unknown, onLine: (line: string) => void): void {
    const s = stream as any;
    let buffer = "";

    const processChunk = (chunk: Uint8Array | Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      buffer += text;

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        onLine(line);
      }
    };

    // Handle Web ReadableStream
    if (s && typeof s.getReader === "function") {
      const reader = (s as ReadableStream<Uint8Array>).getReader();
      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) processChunk(value);
          }
        } catch { /* ignore */ }
        finally {
          // Flush remaining buffer
          if (buffer) onLine(buffer);
          try { reader.releaseLock(); } catch { /* ignore */ }
        }
      })().catch(() => {});
      return;
    }

    // Handle Node.js ReadableStream
    if (s && typeof s.on === "function") {
      try {
        s.on("data", (chunk: unknown) => {
          try { processChunk(chunk as any); } catch { /* ignore */ }
        });
        s.on("end", () => {
          if (buffer) onLine(buffer);
        });
        s.on("error", () => {});
      } catch { /* ignore */ }
    }
  }

  isRunning(): boolean {
    return this.proc !== null;
  }
}

function collectChildEnv(): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) childEnv[k] = v;
  }
  return childEnv;
}

function resolveSupervisedIpcTransport(config: SupervisorConfig): "stdio" | "socket" | "tcp" {
  const raw = (
    config.ipcTransport ??
    process.env.ROBOPPI_SUPERVISED_IPC_TRANSPORT ??
    "stdio"
  ).toLowerCase();

  if (raw === "socket") return "socket";
  if (raw === "tcp") return "tcp";
  return "stdio";
}

function getErrCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const code = (err as any).code;
  return typeof code === "string" ? code : undefined;
}

function isUnixSocketListenUnsupported(err: unknown): boolean {
  const code = getErrCode(err);
  return (
    code === "EPERM" ||
    code === "EACCES" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "EAFNOSUPPORT" ||
    code === "EPROTONOSUPPORT" ||
    code === "ENOSYS" ||
    code === "EINVAL" ||
    code === "ENAMETOOLONG"
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: Error): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
