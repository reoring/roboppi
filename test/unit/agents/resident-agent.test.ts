import { describe, test, expect } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ResidentAgent, createAdapterForAgentProfile } from "../../../src/agents/resident-agent.js";
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

describe("ResidentAgent task guidance", () => {
  test("includes startup guidance and owned task bodies for developer dispatches", () => {
    const agent = new ResidentAgent({
      contextDir: "/tmp/test-context",
      memberId: "developer",
      teamId: "team-1",
      profile: {
        worker: "CODEX_CLI",
        base_instructions: "FULL DEVELOPER RULEBOOK",
      },
      workspaceDir: "/tmp/test-workspace",
      sink: { emit() {} },
      env: {},
    });

    const instructions = (agent as unknown as {
      buildInstructions(
        pendingMessages: [],
        hasTasks: boolean,
        dispatchContext: {
          workflowStatus: {
            summary: string;
            blockers: string[];
            next_actions: string[];
          } | null;
          ownedTasks: Array<{
            task_id: string;
            title: string;
            description: string;
          }>;
        },
      ): string;
    }).buildInstructions([], true, {
      workflowStatus: {
        summary: "Current phase: initializing. Developer must replace startup stubs with canonical state before repo-side work continues.",
        blockers: ["Developer-owned canonical startup sync is still pending."],
        next_actions: [
          "Use developer_sync_bundle or state_promote_attempt to replace startup stubs in current-state.json, todo.md, memory.md, and issues/index.md.",
          "Record the active blocker or first repo-side slice, then republish workflow status from canonical current-state.",
        ],
      },
      ownedTasks: [
        {
          task_id: "task-1",
          title: "Initial startup sync",
          description: "Replace startup stubs in current-state.json and todo.md.",
        },
      ],
    });

    expect(instructions).toContain("## Canonical Workflow Status");
    expect(instructions).toContain("This dispatch is limited to the initial canonical-state sync that replaces startup stubs.");
    expect(instructions).not.toContain("FULL DEVELOPER RULEBOOK");
    expect(instructions).toContain("## Startup Sync First");
    expect(instructions).toContain("defer broad repo scans and repo-wide planning");
    expect(instructions).toContain(".roboppi-loop/apthctl/current-state.json");
    expect(instructions).toContain("developer_sync_bundle");
    expect(instructions).toContain("replace the null startup stub and publish actionable workflow status");
    expect(instructions).toContain("Developer-owned canonical startup sync is still pending.");
    expect(instructions).toContain("task-1: Initial startup sync");
    expect(instructions).toContain("Replace startup stubs in current-state.json and todo.md.");
    expect(instructions).toContain("roboppi agents tasks list --status in_progress");
    expect(instructions).toContain("roboppi agents tasks show --task-id <id>");
    expect(instructions).toContain("claim output includes the full task body");
    expect(instructions).toContain("Do not ask the lead for approval for routine repo-local work");
  });

  test("does not keep startup-only guidance after startup sync completes", () => {
    const agent = new ResidentAgent({
      contextDir: "/tmp/test-context",
      memberId: "developer",
      teamId: "team-1",
      profile: {
        worker: "CODEX_CLI",
        base_instructions: "FULL DEVELOPER RULEBOOK",
      },
      workspaceDir: "/tmp/test-workspace",
      sink: { emit() {} },
      env: {},
    });

    const instructions = (agent as unknown as {
      buildInstructions(
        pendingMessages: [],
        hasTasks: boolean,
        dispatchContext: {
          workflowStatus: {
            summary: string;
            blockers: string[];
            next_actions: string[];
          } | null;
          ownedTasks: Array<{
            task_id: string;
            title: string;
            description: string;
          }>;
        },
      ): string;
    }).buildInstructions([], true, {
      workflowStatus: {
        summary: "Current phase: initializing. Startup sync is complete; define the first repo-side slice and canonical issue before broader work continues.",
        blockers: ["Startup sync is complete; define the first repo-side slice."],
        next_actions: [
          "Read request.md and apthctl-plan.md to define the first concrete repo-side slice.",
          "Read ARCHITECTURE.md and AGENTS.md, then establish the canonical issue and workspace fingerprint for that slice.",
        ],
      },
      ownedTasks: [
        {
          task_id: "task-1",
          title: "Define first repo-side slice",
          description: "Read request.md and apthctl-plan.md, then define the canonical issue.",
        },
      ],
    });

    expect(instructions).toContain("FULL DEVELOPER RULEBOOK");
    expect(instructions).not.toContain("This dispatch is limited to the initial canonical-state sync that replaces startup stubs.");
    expect(instructions).not.toContain("## Startup Sync First");
    expect(instructions).toContain("Startup sync is complete; define the first repo-side slice.");
    expect(instructions).toContain("task-1: Define first repo-side slice");
  });

  test("writes debug events when ROBOPPI_AGENT_DEBUG_LOG=1", async () => {
    const contextDir = await mkdtemp(path.join(tmpdir(), "resident-agent-debug-"));
    try {
      const agent = new ResidentAgent({
        contextDir,
        memberId: "developer",
        teamId: "team-1",
        profile: {
          worker: "CODEX_CLI",
        },
        workspaceDir: "/tmp/test-workspace",
        sink: { emit() {} },
        env: { ROBOPPI_AGENT_DEBUG_LOG: "1" },
      });

      (agent as unknown as { appendDebugEvent(event: Record<string, unknown>): void }).appendDebugEvent({
        ts: 1,
        type: "probe",
        ok: true,
      });

      await (agent as unknown as { debugWriteChain: Promise<void> }).debugWriteChain;

      const logPath = path.join(contextDir, "_agents", "debug", "developer.jsonl");
      const log = await readFile(logPath, "utf8");
      expect(log).toContain('"type":"probe"');
      expect(log).toContain('"ok":true');
    } finally {
      await rm(contextDir, { recursive: true, force: true });
    }
  });

});
