import { JsonLinesTransport } from "../ipc/json-lines-transport.js";
import { IpcProtocol } from "../ipc/protocol.js";
import { AgentCore, type AgentCoreConfig } from "./agentcore.js";
import { applyEnvPrefixAliases } from "./env-aliases.js";
import { Logger } from "./observability.js";

import { ProcessManager } from "../worker/process-manager.js";
import { OpenCodeAdapter } from "../worker/adapters/opencode-adapter.js";
import { ClaudeCodeAdapter } from "../worker/adapters/claude-code-adapter.js";
import { CodexCliAdapter } from "../worker/adapters/codex-cli-adapter.js";
import { CustomShellAdapter } from "../worker/adapters/custom-shell-adapter.js";
import { WorkerKind } from "../types/index.js";

import { createConnection, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";

export interface CoreRuntimeOptions {
  config?: AgentCoreConfig;
  loggerComponent?: string;
}

function isNonInteractive(): boolean {
  // Treat either stream being a TTY as interactive.
  return !(process.stdout.isTTY || process.stderr.isTTY);
}

function parseEnvBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

function parseDurationMs(input: string): number {
  const trimmed = input.trim();
  if (trimmed === "") throw new Error(`Invalid duration string: "${input}"`);

  const tokenRe = /(\d+)(ms|s|m|h)/g;
  let totalMs = 0;
  let matchedLen = 0;
  for (const match of trimmed.matchAll(tokenRe)) {
    const value = parseInt(match[1]!, 10);
    const unit = match[2]!;
    matchedLen += match[0]!.length;
    switch (unit) {
      case "h":
        totalMs += value * 3600_000;
        break;
      case "m":
        totalMs += value * 60_000;
        break;
      case "s":
        totalMs += value * 1000;
        break;
      case "ms":
        totalMs += value;
        break;
    }
  }
  if (matchedLen !== trimmed.length || totalMs <= 0) {
    throw new Error(`Invalid duration string: "${input}"`);
  }
  return totalMs;
}

export function startCoreRuntime(options: CoreRuntimeOptions = {}): void {
  const config = options.config;
  const logger = new Logger(options.loggerComponent ?? "main", config?.logLevel ?? "info");

  // Mark this process as the Core runtime for logging/diagnostics.
  applyEnvPrefixAliases();
  if (!process.env.ROBOPPI_COMPONENT) process.env.ROBOPPI_COMPONENT = "core";
  if (!process.env.AGENTCORE_COMPONENT) process.env.AGENTCORE_COMPONENT = "core";
  applyEnvPrefixAliases();

  // IPC transport: JSONL over either stdio or a supervised IPC socket.
  const ipcSocketPath = (process.env.AGENTCORE_IPC_SOCKET_PATH ?? process.env.ROBOPPI_IPC_SOCKET_PATH)?.trim();
  const ipcSocketHost = (process.env.AGENTCORE_IPC_SOCKET_HOST ?? process.env.ROBOPPI_IPC_SOCKET_HOST)?.trim();
  const ipcSocketPortRaw = (process.env.AGENTCORE_IPC_SOCKET_PORT ?? process.env.ROBOPPI_IPC_SOCKET_PORT)?.trim();

  let ipcSocket: Socket | null = null;
  let ipcSocketKind: "unix" | "tcp" | null = null;
  let resolvedIpcHost: string | undefined;
  let resolvedIpcPort: number | undefined;

  // Prefer TCP host/port when provided (useful for environments where Unix sockets are blocked).
  if (ipcSocketPortRaw) {
    const port = Number.parseInt(ipcSocketPortRaw, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid AGENTCORE_IPC_SOCKET_PORT: "${ipcSocketPortRaw}"`);
    }
    const host = ipcSocketHost && ipcSocketHost !== "" ? ipcSocketHost : "127.0.0.1";
    ipcSocket = createConnection({ host, port });
    ipcSocketKind = "tcp";
    resolvedIpcHost = host;
    resolvedIpcPort = port;
  } else if (ipcSocketPath) {
    ipcSocket = createConnection(ipcSocketPath);
    ipcSocketKind = "unix";
  }

  if (ipcSocket) {
    try {
      ipcSocket.setNoDelay(true);
    } catch {
      // ignore
    }

    // Prevent unhandled socket errors from crashing the Core process.
    ipcSocket.on("error", (err) => {
      logger.error("IPC socket error", {
        name: err.name,
        message: err.message,
      });
    });
  }

  const stdin = ipcSocket
    ? (Readable.toWeb(ipcSocket) as unknown as ReadableStream<Uint8Array>)
    : (() => {
        // Prefer Bun's native stdin stream, but fall back to Node's process.stdin stream
        // when Bun stdin stream plumbing differs in some environments.
        const bunStdin = Bun.stdin as { stream?: () => ReadableStream<Uint8Array> } | undefined;
        if (bunStdin?.stream) {
          return bunStdin.stream() as ReadableStream<Uint8Array>;
        }

        return Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
      })();

  const stdout = ipcSocket
    ? (Writable.toWeb(ipcSocket) as unknown as WritableStream<Uint8Array>)
    : (Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>);

  const transport = new JsonLinesTransport(stdin, stdout);
  const protocol = new IpcProtocol(transport);
  const core = new AgentCore(protocol, config);

  // Keepalive output for environments that kill silent subprocesses.
  // Enabled by default when non-interactive; can be overridden via env.
  const keepaliveEnabled = parseEnvBool(process.env.AGENTCORE_KEEPALIVE) ?? isNonInteractive();
  const keepaliveIntervalMs = (() => {
    const raw = process.env.AGENTCORE_KEEPALIVE_INTERVAL ?? "10s";
    try {
      return parseDurationMs(raw);
    } catch {
      return 10_000;
    }
  })();
  const keepaliveStartedAt = Date.now();
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  if (keepaliveEnabled) {
    keepaliveTimer = setInterval(() => {
      const activeWorkers = core.getWorkerGateway().getActiveWorkerCount();
      if (activeWorkers <= 0) return;
      const elapsedS = Math.floor((Date.now() - keepaliveStartedAt) / 1000);
      logger.info("Keepalive", { activeWorkers, elapsedS });
    }, keepaliveIntervalMs);
  }

  // Register built-in worker adapters so WORKER_TASK delegation works.
  {
    const pm = new ProcessManager();
    core.getWorkerGateway().registerAdapter(WorkerKind.OPENCODE, new OpenCodeAdapter(pm));
    core.getWorkerGateway().registerAdapter(WorkerKind.CLAUDE_CODE, new ClaudeCodeAdapter({}, pm));
    core.getWorkerGateway().registerAdapter(WorkerKind.CODEX_CLI, new CodexCliAdapter(pm));
    core.getWorkerGateway().registerAdapter(WorkerKind.CUSTOM, new CustomShellAdapter(pm));
  }

  let shuttingDown = false;

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Shutting down: ${reason}`);
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
    }
    try {
      await core.shutdown();
    } catch (err) {
      logger.error("Error during shutdown", err);
    }
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", { name: err.name, message: err.message, stack: err.stack });
    shutdown("uncaughtException").catch(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection", reason);
    shutdown("unhandledRejection").catch(() => process.exit(1));
  });

  logger.info("AgentCore starting", {
    config: {
      concurrency: config?.budget?.maxConcurrency ?? 10,
      rps: config?.budget?.maxRps ?? 50,
      logLevel: config?.logLevel ?? "info",
    },
  });

  core.start();

  logger.info("AgentCore started, awaiting IPC messages", {
    transport: ipcSocket ? (ipcSocketKind === "tcp" ? "tcp" : "socket") : "stdio",
    socketPath: ipcSocketKind === "unix" ? (ipcSocketPath || undefined) : undefined,
    socketHost: ipcSocketKind === "tcp" ? resolvedIpcHost : undefined,
    socketPort: ipcSocketKind === "tcp" ? resolvedIpcPort : undefined,
  });
}
