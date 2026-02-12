import { JsonLinesTransport } from "./ipc/json-lines-transport.js";
import { IpcProtocol } from "./ipc/protocol.js";
import { AgentCore } from "./core/agentcore.js";
import { ProcessManager } from "./worker/process-manager.js";
import { OpenCodeAdapter } from "./worker/adapters/opencode-adapter.js";
import { ClaudeCodeAdapter } from "./worker/adapters/claude-code-adapter.js";
import { CodexCliAdapter } from "./worker/adapters/codex-cli-adapter.js";
import { CustomShellAdapter } from "./worker/adapters/custom-shell-adapter.js";
import { WorkerKind } from "./types/index.js";

// Mark this process as the Core runtime for logging/diagnostics.
if (!process.env.AGENTCORE_COMPONENT) process.env.AGENTCORE_COMPONENT = "core";

const logger = {
  error(msg: string, data?: unknown) {
    process.stderr.write(
      JSON.stringify({ timestamp: Date.now(), level: "error", component: "main", message: msg, data }) + "\n",
    );
  },
  info(msg: string) {
    process.stderr.write(
      JSON.stringify({ timestamp: Date.now(), level: "info", component: "main", message: msg }) + "\n",
    );
  },
};

// Bun exposes process.stdin as a ReadableStream<Uint8Array>
const stdin = Bun.stdin.stream() as ReadableStream<Uint8Array>;
const stdout = new WritableStream<Uint8Array>({
  write(chunk) {
    process.stdout.write(chunk);
  },
});

const transport = new JsonLinesTransport(stdin, stdout);
const protocol = new IpcProtocol(transport);
const core = new AgentCore(protocol);

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

logger.info("AgentCore starting");
core.start();
logger.info("AgentCore started, awaiting IPC messages on stdin");
