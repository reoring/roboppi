import { describe, it, expect } from "bun:test";
import { renderLogsTab } from "../../../src/tui/components/tabs/logs-tab.js";
import { RingBuffer } from "../../../src/tui/ring-buffer.js";
import type { StepUiState } from "../../../src/tui/state-store.js";

function makeStep(): StepUiState {
  const logOpts = { maxLines: 100, maxBytes: 10000 };
  return {
    stepId: "_agent:lead",
    status: "RUNNING",
    iteration: 0,
    maxIterations: 1,
    logs: {
      stdout: new RingBuffer<string>(logOpts),
      stderr: new RingBuffer<string>(logOpts),
      progress: new RingBuffer<string>(logOpts),
    },
    patches: {
      byId: new Map(),
      order: [],
      byFilePath: new Map(),
    },
  };
}

describe("renderLogsTab", () => {
  it("renders plain logs unchanged", () => {
    const step = makeStep();
    step.logs.stdout.push("hello world");

    const output = renderLogsTab(step, 80, 10);
    expect(output).toContain("hello world");
    expect(output).toContain("[worker stdout]");
  });

  it("summarizes claude structured JSON into thinking, tool, and usage lines", () => {
    const step = makeStep();
    step.logs.progress.push(JSON.stringify({
      type: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to inspect the current repository state before making changes." },
        {
          type: "tool_use",
          name: "Bash",
          input: {
            command: "git status --short",
            description: "Check worktree status",
          },
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 8,
        cache_read_input_tokens: 25498,
        cache_creation_input_tokens: 7058,
      },
    }));

    const output = renderLogsTab(step, 180, 20);
    expect(output).toContain("[thinking]");
    expect(output).toContain("Need to inspect the current repository state");
    expect(output).toContain("[tool call]");
    expect(output).toContain("Bash: Check worktree status | git status --short");
    expect(output).toContain("[usage]");
    expect(output).toContain("tokens in=1 out=8 cache_read=25k cache_write=7.1k");
    expect(output).not.toContain("\"input_tokens\"");
    expect(output).not.toContain("\"tool_use\"");
  });

  it("summarizes result payloads instead of showing raw JSON blobs", () => {
    const step = makeStep();
    step.logs.stdout.push(JSON.stringify({
      type: "result",
      result: "Completed initial scan",
      usage: {
        input_tokens: 120,
        output_tokens: 40,
      },
    }));

    const output = renderLogsTab(step, 100, 10);
    expect(output).toContain("[result]");
    expect(output).toContain("Completed initial scan");
    expect(output).toContain("[usage]");
    expect(output).toContain("tokens in=120 out=40");
  });

  it("summarizes nested opencode/openai tool events into readable lines", () => {
    const step = makeStep();
    step.logs.stdout.push(JSON.stringify({
      type: "tool_use",
      timestamp: 1773009623735,
      part: {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: {
            command: "go run ./cmd/apthctl cluster create --clusterclass hcp-aws --dry-run",
            description: "Probe hcp-aws charts-dir support",
          },
          output: "error: --charts-dir is not supported\nhint: supported flags for hcp-aws\nexit status 4\n",
          metadata: {
            exit: 1,
            description: "Probe hcp-aws charts-dir support",
          },
          time: {
            start: 1773009636729,
            end: 1773009636875,
          },
        },
      },
    }));
    step.logs.stdout.push(JSON.stringify({
      type: "step_finish",
      timestamp: 1773009636883,
      part: {
        type: "step-finish",
        reason: "tool-calls",
        cost: 0.060721,
        tokens: {
          total: 151559,
          input: 2728,
          output: 607,
          reasoning: 516,
          cache: {
            read: 148224,
            write: 0,
          },
        },
      },
    }));

    const output = renderLogsTab(step, 180, 20);
    expect(output).toContain("[tool call]");
    expect(output).toContain("Bash: Probe hcp-aws charts-dir support | go run ./cmd/apthctl cluster create --clusterclass hcp-aws --dry-run");
    expect(output).toContain("[result]");
    expect(output).toContain("Bash completed exit=1 146ms | error: --charts-dir is not supported");
    expect(output).toContain("[turn]");
    expect(output).toContain("llm turn finished: tool-calls");
    expect(output).toContain("[usage]");
    expect(output).toContain("cost=$0.0607 tok=152k in=2.7k out=607 rsn=516 cache_read=148k cache_write=0");
    expect(output).not.toContain("\"sessionID\"");
    expect(output).not.toContain("\"callID\"");
  });

  it("labels roboppi-generated truncation notes explicitly", () => {
    const step = makeStep();
    step.logs.progress.push("(logs truncated)");

    const output = renderLogsTab(step, 100, 10);
    expect(output).toContain("[roboppi note]");
    expect(output).toContain("roboppi truncated worker logs");
  });

  it("summarizes codex item lifecycle events for command execution and agent messages", () => {
    const step = makeStep();
    step.logs.stdout.push(JSON.stringify({
      type: "item.started",
      item: {
        id: "item_32",
        type: "command_execution",
        command: "/usr/bin/bash -lc 'kind get clusters || true'",
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    }));
    step.logs.stdout.push(JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_32",
        type: "command_execution",
        command: "/usr/bin/bash -lc 'kind get clusters || true'",
        aggregated_output: "No kind clusters found.\n",
        exit_code: 0,
        status: "completed",
      },
    }));
    step.logs.stdout.push(JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_33",
        type: "agent_message",
        text: "I have confirmed the exact CLI surfaces I need before spending on create flow.",
      },
    }));

    const output = renderLogsTab(step, 180, 20);
    expect(output).toContain("[tool call]");
    expect(output).toContain("Command started | kind get clusters || true");
    expect(output).toContain("[result]");
    expect(output).toContain("Command completed exit=0 | No kind clusters found.");
    expect(output).toContain("[message]");
    expect(output).toContain("I have confirmed the exact CLI surfaces I need");
    expect(output).not.toContain("structured event: item.started");
    expect(output).not.toContain("structured event: item.completed");
  });
});
