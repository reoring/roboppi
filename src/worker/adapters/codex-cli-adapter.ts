import { WorkerKind, WorkerCapability } from "../../types/index.js";
import type { WorkerTask } from "../../types/index.js";
import type { Artifact, Observation } from "../../types/index.js";
import type { McpServerConfig } from "../../types/mcp-server.js";
import type { WorkerEvent, WorkerHandle } from "../worker-adapter.js";
import type { ProcessManager } from "../process-manager.js";
import { BaseProcessAdapter } from "./base-process-adapter.js";

export interface CodexCliAdapterConfig {
  codexCommand?: string;
  defaultArgs?: string[];
  mcpServers?: McpServerConfig[];
  gracePeriodMs?: number;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map((value) => tomlString(value)).join(", ")}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ")} }`;
}

function buildCodexMcpOverrides(servers: McpServerConfig[]): string[] {
  const args: string[] = [];
  for (const server of servers) {
    const base = `mcp_servers.${server.name}`;
    if (server.enabled !== undefined) {
      args.push("-c", `${base}.enabled=${server.enabled ? "true" : "false"}`);
    }
    if (server.url) {
      args.push("-c", `${base}.url=${tomlString(server.url)}`);
      if (server.bearer_token_env_var) {
        args.push(
          "-c",
          `${base}.bearer_token_env_var=${tomlString(server.bearer_token_env_var)}`,
        );
      }
      continue;
    }
    if (!server.command) continue;
    args.push("-c", `${base}.command=${tomlString(server.command)}`);
    if (Array.isArray(server.args) && server.args.length > 0) {
      args.push("-c", `${base}.args=${tomlStringArray(server.args)}`);
    }
    if (server.env && Object.keys(server.env).length > 0) {
      args.push("-c", `${base}.env=${tomlInlineTable(server.env)}`);
    }
  }
  return args;
}

function normalizeLegacyCodexArgs(args: string[]): string[] {
  let needsBypass = false;
  const preserved: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dangerously-bypass-approvals-and-sandbox") {
      needsBypass = true;
      continue;
    }
    if (arg === "--ask-for-approval") {
      const value = args[i + 1];
      if (value === "never") {
        needsBypass = true;
        i++;
        continue;
      }
    }
    preserved.push(arg);
  }

  if (!needsBypass) {
    return preserved;
  }

  const normalized: string[] = [];
  for (let i = 0; i < preserved.length; i++) {
    const arg = preserved[i]!;
    if (arg === "--full-auto") {
      continue;
    }
    if (arg === "--sandbox") {
      i++; // drop the sandbox value as well; bypass supersedes sandbox selection
      continue;
    }
    normalized.push(arg);
  }

  normalized.push("--dangerously-bypass-approvals-and-sandbox");
  return normalized;
}

export class CodexCliAdapter extends BaseProcessAdapter {
  readonly kind = WorkerKind.CODEX_CLI;
  private readonly config: Required<CodexCliAdapterConfig>;

  constructor(
    processManager: ProcessManager,
    config: CodexCliAdapterConfig = {},
  ) {
    super(processManager, config.gracePeriodMs ?? 5000);
    this.config = {
      codexCommand: config.codexCommand ?? "codex",
      defaultArgs: config.defaultArgs ?? [],
      mcpServers: config.mcpServers ?? [],
      gracePeriodMs: config.gracePeriodMs ?? 5000,
    };
  }

  buildCommand(task: WorkerTask): string[] {
    // Codex CLI supports non-interactive execution via `codex exec`.
    // We pass instructions as the positional [PROMPT] argument.
    const args: string[] = [this.config.codexCommand, "exec"];
    const defaultArgs = normalizeLegacyCodexArgs([
      ...this.config.defaultArgs,
      ...(task.defaultArgs ?? []),
    ]);

    // Default args, with optional model override.
    if (task.model) {
      // Prefer task-level model over config default args.
      for (let i = 0; i < defaultArgs.length; i++) {
        const a = defaultArgs[i]!;
        if (a === "--model") {
          i++; // skip value
          continue;
        }
        if (a.startsWith("--model=")) continue;
        args.push(a);
      }
      args.push("--model", normalizeCodexModel(task.model));
    } else {
      args.push(...defaultArgs);
    }

    if (this.config.mcpServers.length > 0) {
      args.push(...buildCodexMcpOverrides(this.config.mcpServers));
    }

    // Always use JSONL output for reliable parsing/logging.
    if (!args.includes("--json")) {
      args.push("--json");
    }

    // Ensure Codex uses the workspace as the working root.
    // (We also spawn with cwd=workspaceRef, but this makes Codex explicit.)
    const hasCd = args.includes("--cd") || args.includes("-C");
    if (!hasCd) {
      args.push("--cd", task.workspaceRef);
    }

    // Map capabilities to sandbox / automation.
    const hasWrite = task.capabilities.includes(WorkerCapability.EDIT);
    const hasRunCommands =
      task.capabilities.includes(WorkerCapability.RUN_COMMANDS) ||
      task.capabilities.includes(WorkerCapability.RUN_TESTS);
    const hasBypass = args.includes("--dangerously-bypass-approvals-and-sandbox");

    if (hasBypass) {
      // Current Codex CLI bypass mode already implies no sandbox / no approvals.
    } else if (hasWrite && hasRunCommands) {
      // Low-friction sandboxed auto execution.
      if (!args.includes("--full-auto")) {
        args.push("--full-auto");
      }
    } else {
      // Stay sandboxed and align with capability intent.
      const hasSandbox = args.includes("--sandbox") || args.includes("-s");
      if (!hasSandbox) {
        args.push("--sandbox", hasWrite ? "workspace-write" : "read-only");
      }
    }

    // Positional prompt
    args.push(task.instructions);

    return args;
  }

  async *streamEvents(handle: WorkerHandle): AsyncIterable<WorkerEvent> {
    const active = this.activeProcesses.get(handle.handleId);
    if (!active) return;

    active.streamConsumed = true;
    const { managed } = active;

    // Collect events from both streams into a shared queue
    const queue: WorkerEvent[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let pendingStreams = 2;

    const enqueue = (event: WorkerEvent) => {
      queue.push(event);
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    };

    const markStreamDone = () => {
      pendingStreams--;
      if (pendingStreams === 0) {
        done = true;
        if (resolve) {
          const r = resolve;
          resolve = null;
          r();
        }
      }
    };

    const readStream = async (
      stream: ReadableStream<Uint8Array>,
      source: "stdout" | "stderr",
    ) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) {
            // Flush remaining buffer
            if (buffer) {
              if (source === "stdout") {
                active.collectedStdout.push(buffer);
                for (const ev of this.parseStdoutLine(buffer)) {
                  enqueue(ev);
                }
              } else {
                active.collectedStderr.push(buffer);
                enqueue({ type: "stderr", data: buffer });
              }
            }
            break;
          }
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.length > 0 ? (lines.pop() ?? "") : "";
          for (const line of lines) {
            if (source === "stdout") {
              active.collectedStdout.push(line);
              for (const ev of this.parseStdoutLine(line)) {
                enqueue(ev);
              }
            } else if (line) {
              active.collectedStderr.push(line);
              enqueue({ type: "stderr", data: line });
            }
          }
        }
      } catch {
        // Stream error, stop reading
      } finally {
        reader.releaseLock();
        markStreamDone();
      }
    };

    // Start reading both streams concurrently
    readStream(managed.stdout, "stdout");
    readStream(managed.stderr, "stderr");

    // Yield events as they arrive
    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else if (done) {
        break;
      } else {
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    }
  }

  private *parseStdoutLine(line: string): Iterable<WorkerEvent> {
    if (!line) return;

    // Try parsing as JSON (structured codex output)
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        if (parsed.type === "patch" && parsed.filePath && parsed.diff) {
          yield { type: "patch", filePath: parsed.filePath, diff: parsed.diff };
          return;
        }
        if (parsed.type === "progress") {
          yield { type: "progress", message: parsed.message ?? "", percent: parsed.percent };
          return;
        }
      }
    } catch {
      // Not JSON, treat as plain stdout
    }

    yield { type: "stdout", data: line };
  }

  protected parseArtifacts(stdout: string): Artifact[] {
    const artifacts: Artifact[] = [];

    for (const line of stdout.split("\n")) {
      try {
        const parsed = JSON.parse(line);
        if (parsed?.type === "patch" && parsed.filePath) {
          artifacts.push({
            type: "patch",
            ref: parsed.filePath,
            content: parsed.diff,
          });
        }
      } catch {
        // Not JSON
      }
    }

    // Also detect unified diff blocks in plain text
    const diffPattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
    let match;
    while ((match = diffPattern.exec(stdout)) !== null) {
      artifacts.push({
        type: "diff",
        ref: match[2]!,
      });
    }

    return artifacts;
  }

  protected parseObservations(stdout: string): Observation[] {
    const trimmed = stdout.trim();
    if (!trimmed) return [];

    const max = 1000;
    if (trimmed.length <= max) {
      return [{ summary: trimmed }];
    }

    const head = trimmed.slice(0, max);
    const tail = trimmed.slice(-max);

    return [
      {
        summary: `${head}\n...\n${tail}`,
      },
    ];
  }
}

function normalizeCodexModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return trimmed;
  // Codex CLI may reject provider-prefixed strings like "openai/gpt-5.3-codex".
  if (trimmed.includes("/")) {
    const parts = trimmed.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1]! : trimmed;
  }
  return trimmed;
}
