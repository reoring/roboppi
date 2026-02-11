import type { DaemonEvent, CommandEventDef } from "../types.js";
import type { EventSource } from "./event-source.js";
import { waitOrAbort } from "./event-source.js";
import { parseDuration } from "../../workflow/duration.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class CommandSource implements EventSource {
  readonly id: string;
  private readonly command: string;
  private readonly intervalMs: number;
  private readonly triggerOn: "change" | "always";
  private readonly commandTimeoutMs: number;
  private readonly cwd: string;
  private abortController = new AbortController();
  private lastOutput: string | null = null;

  constructor(id: string, config: CommandEventDef, cwd: string = process.cwd()) {
    this.id = id;
    this.command = config.command;
    this.intervalMs = parseDuration(config.interval);
    this.triggerOn = config.trigger_on ?? "change";
    this.cwd = cwd;
    const configAny = config as unknown as Record<string, unknown>;
    this.commandTimeoutMs = typeof configAny["timeout"] === "string"
      ? parseDuration(configAny["timeout"])
      : DEFAULT_COMMAND_TIMEOUT_MS;
  }

  async *events(): AsyncGenerator<DaemonEvent> {
    const signal = this.abortController.signal;

    while (!signal.aborted) {
      // Execute the command
      const result = await this.runCommand(signal);
      if (result === null) break; // aborted during execution

      const { stdout, exitCode } = result;
      const changed = this.lastOutput !== null && this.lastOutput !== stdout;
      const isFirstRun = this.lastOutput === null;
      this.lastOutput = stdout;

      if (this.triggerOn === "always") {
        yield {
          sourceId: this.id,
          timestamp: Date.now(),
          payload: {
            type: "command",
            stdout,
            exitCode,
            changed,
          },
        };
      } else {
        // "change" mode
        if (isFirstRun) {
          // First run: emit baseline with changed=false
          yield {
            sourceId: this.id,
            timestamp: Date.now(),
            payload: {
              type: "command",
              stdout,
              exitCode,
              changed: false,
            },
          };
        } else if (changed) {
          yield {
            sourceId: this.id,
            timestamp: Date.now(),
            payload: {
              type: "command",
              stdout,
              exitCode,
              changed: true,
            },
          };
        }
      }

      // Wait for next interval
      const aborted = await waitOrAbort(this.intervalMs, signal);
      if (aborted) break;
    }
  }

  async stop(): Promise<void> {
    this.abortController.abort();
  }

  private async runCommand(
    signal: AbortSignal,
  ): Promise<{ stdout: string; exitCode: number } | null> {
    if (signal.aborted) return null;

    try {
      const proc = Bun.spawn(["bash", "-c", this.command], {
        cwd: this.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      // Race between command completion, abort, and timeout
      const exitPromise = proc.exited;
      const abortPromise = new Promise<"aborted">((resolve) => {
        if (signal.aborted) {
          resolve("aborted");
          return;
        }
        signal.addEventListener("abort", () => resolve("aborted"), {
          once: true,
        });
      });
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), this.commandTimeoutMs);
      });

      const race = await Promise.race([exitPromise, abortPromise, timeoutPromise]);
      if (race === "aborted") {
        proc.kill();
        return null;
      }
      if (race === "timeout") {
        // Graceful kill: SIGTERM first, then SIGKILL after 5s grace period
        proc.kill("SIGTERM");
        const stillAlive = await Promise.race([
          proc.exited.then(() => false),
          new Promise<true>((resolve) => setTimeout(() => resolve(true), 5000)),
        ]);
        if (stillAlive) {
          proc.kill("SIGKILL");
        }
        return { stdout: "", exitCode: 1 };
      }

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      if (stderr) {
        console.warn(`[command-source:${this.id}] stderr: ${stderr.slice(0, 500)}`);
      }
      const exitCode = race;

      return { stdout, exitCode };
    } catch {
      if (signal.aborted) return null;
      return { stdout: "", exitCode: 1 };
    }
  }
}
