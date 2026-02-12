import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { JsonLinesTransport } from "../../src/ipc/json-lines-transport.js";
import { IpcProtocol } from "../../src/ipc/protocol.js";
import { AgentCore } from "../../src/core/agentcore.js";
import { MockWorkerAdapter } from "../../src/worker/adapters/mock-adapter.js";
import { WorkerKind } from "../../src/types/index.js";
import type { StepDefinition } from "../../src/workflow/types.js";
import { CoreIpcStepRunner } from "../../src/workflow/core-ipc-step-runner.js";
import { createIpcStreamPair } from "../helpers/fixtures.js";

describe("CoreIpcStepRunner (in-process IPC)", () => {
  let core: AgentCore | null = null;
  let schedulerProtocol: IpcProtocol | null = null;
  let runner: CoreIpcStepRunner | null = null;
  let workspaceDir: string | null = null;

  afterEach(async () => {
    try {
      await runner?.shutdown();
    } catch {
      // best-effort
    }
    runner = null;

    try {
      await core?.shutdown();
    } catch {
      // best-effort
    }
    core = null;

    try {
      await schedulerProtocol?.stop();
    } catch {
      // best-effort
    }
    schedulerProtocol = null;

    if (workspaceDir) {
      await rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = null;
    }
  });

  async function setup(mockOptions?: ConstructorParameters<typeof MockWorkerAdapter>[1]) {
    workspaceDir = await mkdtemp(path.join(tmpdir(), "wf-core-ipc-"));

    const streams = createIpcStreamPair();
    const coreTransport = new JsonLinesTransport(streams.coreInput, streams.coreOutput);
    const coreProtocol = new IpcProtocol(coreTransport);

    const schedulerTransport = new JsonLinesTransport(streams.schedulerInput, streams.schedulerOutput);
    schedulerProtocol = new IpcProtocol(schedulerTransport);
    schedulerProtocol.start();

    core = new AgentCore(coreProtocol);
    core.getWorkerGateway().registerAdapter(
      WorkerKind.CLAUDE_CODE,
      new MockWorkerAdapter(WorkerKind.CLAUDE_CODE, mockOptions ?? { delayMs: 10 }),
    );
    core.start();

    runner = new CoreIpcStepRunner({ ipc: schedulerProtocol });
  }

  test("runs a CLAUDE_CODE step via Core IPC", async () => {
    await setup({ delayMs: 10 });

    const step: StepDefinition = {
      worker: "CLAUDE_CODE",
      instructions: "Do a small task",
      capabilities: ["READ"],
      timeout: "10s",
    };

    const result = await runner!.runStep(
      "step-1",
      step,
      workspaceDir!,
      new AbortController().signal,
    );

    expect(result.status).toBe("SUCCEEDED");
  });

  test("abort sends cancel_job and does not hang", async () => {
    await setup({ shouldTimeout: true, shouldRespectCancel: true });

    const step: StepDefinition = {
      worker: "CLAUDE_CODE",
      instructions: "Long running task",
      capabilities: ["READ"],
      timeout: "30s",
    };

    const ac = new AbortController();
    const p = runner!.runStep("step-cancel", step, workspaceDir!, ac.signal);

    // Let the job start.
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    const result = await p;
    expect(result.status).toBe("FAILED");
    // No ghost workers remain.
    expect(core!.getWorkerGateway().getActiveWorkerCount()).toBe(0);
  });
});
