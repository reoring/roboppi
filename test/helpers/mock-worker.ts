/**
 * Mock Worker Process
 *
 * A standalone Bun script that simulates a worker process for integration testing.
 * Reads JSON Lines commands from stdin, produces JSON Lines events on stdout.
 *
 * Usage: bun run test/helpers/mock-worker.ts
 *
 * Commands (JSON Lines on stdin):
 *   { "type": "execute", "delay"?: number, "shouldFail"?: boolean }
 *
 * Events (JSON Lines on stdout):
 *   { "type": "started" }
 *   { "type": "progress", "message": string, "percent": number }
 *   { "type": "result", "status": "SUCCEEDED" | "FAILED" | "CANCELLED", "wallTimeMs": number }
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let shuttingDown = false;
let currentAbortController: AbortController | null = null;

function writeLine(obj: object): void {
  const line = JSON.stringify(obj) + "\n";
  Bun.write(Bun.stdout, encoder.encode(line));
}

function writeStderr(msg: string): void {
  const line = JSON.stringify({ type: "stderr", data: msg }) + "\n";
  Bun.write(Bun.stderr, encoder.encode(line));
}

async function handleExecute(
  delay: number,
  shouldFail: boolean,
  signal: AbortSignal,
): Promise<void> {
  const startTime = Date.now();

  writeLine({ type: "started" });
  writeLine({ type: "progress", message: "Starting execution", percent: 0 });

  // Simulate work in increments
  const steps = 5;
  const stepDelay = delay / steps;

  for (let i = 1; i <= steps; i++) {
    if (signal.aborted || shuttingDown) {
      writeLine({
        type: "result",
        status: "CANCELLED",
        wallTimeMs: Date.now() - startTime,
      });
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, stepDelay));

    writeLine({
      type: "progress",
      message: `Step ${i}/${steps}`,
      percent: Math.round((i / steps) * 100),
    });
  }

  if (signal.aborted || shuttingDown) {
    writeLine({
      type: "result",
      status: "CANCELLED",
      wallTimeMs: Date.now() - startTime,
    });
    return;
  }

  writeLine({
    type: "result",
    status: shouldFail ? "FAILED" : "SUCCEEDED",
    wallTimeMs: Date.now() - startTime,
  });
}

// Handle SIGTERM for graceful shutdown
process.on("SIGTERM", () => {
  shuttingDown = true;
  if (currentAbortController) {
    currentAbortController.abort("SIGTERM received");
  }
  writeStderr("Received SIGTERM, shutting down gracefully");
});

// Handle SIGINT similarly
process.on("SIGINT", () => {
  shuttingDown = true;
  if (currentAbortController) {
    currentAbortController.abort("SIGINT received");
  }
});

// Read from stdin as JSON Lines
async function main(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  let buffer = "";

  writeLine({ type: "ready" });

  try {
    while (!shuttingDown) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (line === "") continue;

        try {
          const command = JSON.parse(line) as {
            type: string;
            delay?: number;
            shouldFail?: boolean;
          };

          if (command.type === "execute") {
            currentAbortController = new AbortController();
            await handleExecute(
              command.delay ?? 100,
              command.shouldFail ?? false,
              currentAbortController.signal,
            );
            currentAbortController = null;
          } else if (command.type === "shutdown") {
            shuttingDown = true;
            writeLine({ type: "shutdown_ack" });
            break;
          } else {
            writeLine({ type: "error", message: `Unknown command: ${command.type}` });
          }
        } catch (err) {
          writeLine({
            type: "error",
            message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
  } catch (err) {
    if (!shuttingDown) {
      writeStderr(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  process.exit(0);
}

main();
