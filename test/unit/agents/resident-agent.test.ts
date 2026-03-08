import { describe, test, expect } from "bun:test";

import { createAdapterForAgentProfile } from "../../../src/agents/resident-agent.js";
import { CodexCliAdapter } from "../../../src/worker/adapters/codex-cli-adapter.js";
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
});
