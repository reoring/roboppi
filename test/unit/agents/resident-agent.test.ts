import { describe, test, expect } from "bun:test";

import { createAdapterForAgentProfile } from "../../../src/agents/resident-agent.js";
import { CodexCliAdapter } from "../../../src/worker/adapters/codex-cli-adapter.js";
import { ClaudeCodeAdapter } from "../../../src/worker/adapters/claude-code-adapter.js";
import { OpenCodeAdapter } from "../../../src/worker/adapters/opencode-adapter.js";
import type { ProcessManager } from "../../../src/worker/process-manager.js";
import {
  WorkerKind,
  WorkerCapability,
  OutputMode,
  generateId,
} from "../../../src/types/index.js";
import type { WorkerTask } from "../../../src/types/index.js";

function createTask(overrides: Partial<WorkerTask> = {}): WorkerTask {
  return {
    workerTaskId: generateId(),
    workerKind: WorkerKind.CODEX_CLI,
    workspaceRef: "/tmp/test-workspace",
    instructions: "Run live cluster verification",
    capabilities: [
      WorkerCapability.READ,
      WorkerCapability.EDIT,
      WorkerCapability.RUN_COMMANDS,
    ],
    outputMode: OutputMode.STREAM,
    budget: {
      deadlineAt: Date.now() + 60000,
    },
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe("createAdapterForAgentProfile", () => {
  test("preserves profile defaultArgs for resident CODEX_CLI agents", () => {
    const adapter = createAdapterForAgentProfile(
      {} as ProcessManager,
      {
        worker: "CODEX_CLI",
        defaultArgs: [
          "--dangerously-bypass-approvals-and-sandbox",
        ],
      },
    );

    expect(adapter).toBeInstanceOf(CodexCliAdapter);

    const command = (adapter as CodexCliAdapter).buildCommand(
      createTask({ model: "openai/gpt-5.4" }),
    );

    expect(command).toEqual([
      "codex",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.4",
      "--json",
      "--cd",
      "/tmp/test-workspace",
      "Run live cluster verification",
    ]);
  });

  test("adds Claude MCP config flags for resident CLAUDE_CODE agents", () => {
    const adapter = createAdapterForAgentProfile(
      {} as ProcessManager,
      {
        worker: "CLAUDE_CODE",
        defaultArgs: ["--effort", "medium"],
        mcp_configs: ["tools/apthctl-loop-mcp.claude.json"],
        strict_mcp_config: true,
      },
    );

    expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);

    const command = (adapter as ClaudeCodeAdapter).buildCommand(
      createTask({
        workerKind: WorkerKind.CLAUDE_CODE,
        model: "claude-sonnet-4-6",
      }),
    );

    expect(command).toEqual([
      "claude",
      "--effort",
      "medium",
      "--mcp-config",
      "tools/apthctl-loop-mcp.claude.json",
      "--strict-mcp-config",
      "--model",
      "claude-sonnet-4-6",
      "--print",
      "Run live cluster verification",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--allowedTools",
      "View,Read,Glob,Grep,Edit,Write,NotebookEdit,Bash",
    ]);
  });

  test("adds Codex MCP config overrides for resident CODEX_CLI agents", () => {
    const adapter = createAdapterForAgentProfile(
      {} as ProcessManager,
      {
        worker: "CODEX_CLI",
        defaultArgs: ["--dangerously-bypass-approvals-and-sandbox"],
        mcp_servers: [
          {
            name: "apthctl_loop",
            command: "bun",
            args: ["run", "tools/apthctl-loop-mcp.ts"],
            env: { LOOP_MODE: "test" },
          },
        ],
      },
    );

    expect(adapter).toBeInstanceOf(CodexCliAdapter);

    const command = (adapter as CodexCliAdapter).buildCommand(
      createTask({ model: "openai/gpt-5.4" }),
    );

    expect(command).toEqual([
      "codex",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      "gpt-5.4",
      "-c",
      'mcp_servers.apthctl_loop.command="bun"',
      "-c",
      'mcp_servers.apthctl_loop.args=["run", "tools/apthctl-loop-mcp.ts"]',
      "-c",
      'mcp_servers.apthctl_loop.env={ LOOP_MODE = "test" }',
      "--json",
      "--cd",
      "/tmp/test-workspace",
      "Run live cluster verification",
    ]);
  });

  test("passes generic MCP servers into resident OPENCODE agents", () => {
    const adapter = createAdapterForAgentProfile(
      {} as ProcessManager,
      {
        worker: "OPENCODE",
        defaultArgs: ["--print-logs"],
        mcp_servers: [
          {
            name: "apthctl_loop",
            command: "bun",
            args: ["run", "tools/apthctl-loop-mcp.ts"],
          },
        ],
      },
    );

    expect(adapter).toBeInstanceOf(OpenCodeAdapter);

    const command = (adapter as OpenCodeAdapter).buildCommand(
      createTask({
        workerKind: WorkerKind.OPENCODE,
        model: "openai/gpt-5.4",
      }),
    );

    expect(command).toEqual([
      "opencode",
      "run",
      "--format",
      "json",
      "--print-logs",
      "--model",
      "openai/gpt-5.4",
      "Run live cluster verification",
    ]);
  });
});
