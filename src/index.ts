import { JsonLinesTransport } from "./ipc/json-lines-transport.js";
import { IpcProtocol } from "./ipc/protocol.js";
import { AgentCore } from "./core/agentcore.js";

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
