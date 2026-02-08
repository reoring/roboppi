import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Daemon } from "../../../src/daemon/daemon.js";
import type { DaemonConfig } from "../../../src/daemon/types.js";
import { DaemonStateStore } from "../../../src/daemon/state-store.js";
import { WorkflowStatus } from "../../../src/workflow/types.js";

describe("Context injection", () => {
  test("context.env: environment variables set during workflow execution", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ctx-env-"));
    const stateDir = path.join(tmpDir, "state");
    const markerFile = path.join(tmpDir, "env-marker.txt");

    // Workflow step reads the env var and writes it to a file
    const workflowYaml = `
name: env-test
version: "1"
timeout: "10s"
steps:
  check_env:
    worker: CUSTOM
    instructions: "echo $DAEMON_TEST_VAR > ${markerFile}"
    capabilities: [RUN_COMMANDS]
`;
    await writeFile(path.join(tmpDir, "test.yaml"), workflowYaml);

    const config: DaemonConfig = {
      name: "ctx-env-daemon",
      version: "1",
      workspace: tmpDir,
      state_dir: stateDir,
      events: {
        tick: { type: "interval", every: "1s" },
      },
      triggers: {
        on_tick: {
          on: "tick",
          workflow: "test.yaml",
          context: {
            env: { DAEMON_TEST_VAR: "hello-from-daemon" },
          },
        },
      },
    };

    // Make sure the env var is not already set
    const originalVal = process.env["DAEMON_TEST_VAR"];
    delete process.env["DAEMON_TEST_VAR"];

    const daemon = new Daemon(config);
    const startPromise = daemon.start();

    // Wait for at least one workflow execution
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await daemon.stop();
    await startPromise;

    // Verify marker file was created with env var content
    const content = await readFile(markerFile, "utf-8");
    expect(content.trim()).toBe("hello-from-daemon");

    // Verify env var was restored (should not leak)
    expect(process.env["DAEMON_TEST_VAR"]).toBe(originalVal);
  });

  test("context.last_result: last-result.json written to .daemon-context", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ctx-lr-"));
    const stateDir = path.join(tmpDir, "state");

    // Pre-populate a last result in the state store
    const store = new DaemonStateStore(stateDir);
    await store.saveLastResult("on_tick", {
      workflowId: "prev-run-1",
      name: "prev-workflow",
      status: WorkflowStatus.SUCCEEDED,
      steps: {},
      startedAt: 1000,
      completedAt: 2000,
    });

    const contextJsonPath = path.join(tmpDir, ".daemon-context", "last-result.json");
    const markerFile = path.join(tmpDir, "lr-marker.txt");

    // Workflow step checks if last-result.json exists
    const workflowYaml = `
name: lr-test
version: "1"
timeout: "10s"
steps:
  check_lr:
    worker: CUSTOM
    instructions: "cat ${contextJsonPath} | head -1 > ${markerFile}"
    capabilities: [RUN_COMMANDS]
`;
    await writeFile(path.join(tmpDir, "test.yaml"), workflowYaml);

    const config: DaemonConfig = {
      name: "ctx-lr-daemon",
      version: "1",
      workspace: tmpDir,
      state_dir: stateDir,
      events: {
        tick: { type: "interval", every: "1s" },
      },
      triggers: {
        on_tick: {
          on: "tick",
          workflow: "test.yaml",
          context: {
            last_result: true,
          },
        },
      },
    };

    const daemon = new Daemon(config);
    const startPromise = daemon.start();

    await new Promise((resolve) => setTimeout(resolve, 2000));
    await daemon.stop();
    await startPromise;

    // Verify that last-result.json was written
    const exists = await Bun.file(contextJsonPath).exists();
    expect(exists).toBe(true);

    const lastResultContent = JSON.parse(await readFile(contextJsonPath, "utf-8"));
    expect(lastResultContent).toHaveProperty("workflowId", "prev-run-1");
    expect(lastResultContent).toHaveProperty("status", "SUCCEEDED");
  });

  test("context.event_payload: event.json written to .daemon-context", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "ctx-ep-"));
    const stateDir = path.join(tmpDir, "state");
    const contextJsonPath = path.join(tmpDir, ".daemon-context", "event.json");
    const markerFile = path.join(tmpDir, "ep-marker.txt");

    // Workflow step checks if event.json exists
    const workflowYaml = `
name: ep-test
version: "1"
timeout: "10s"
steps:
  check_ep:
    worker: CUSTOM
    instructions: "test -f ${contextJsonPath} && echo exists > ${markerFile}"
    capabilities: [RUN_COMMANDS]
`;
    await writeFile(path.join(tmpDir, "test.yaml"), workflowYaml);

    const config: DaemonConfig = {
      name: "ctx-ep-daemon",
      version: "1",
      workspace: tmpDir,
      state_dir: stateDir,
      events: {
        tick: { type: "interval", every: "1s" },
      },
      triggers: {
        on_tick: {
          on: "tick",
          workflow: "test.yaml",
          context: {
            event_payload: true,
          },
        },
      },
    };

    const daemon = new Daemon(config);
    const startPromise = daemon.start();

    await new Promise((resolve) => setTimeout(resolve, 2000));
    await daemon.stop();
    await startPromise;

    // Verify event.json was written
    const exists = await Bun.file(contextJsonPath).exists();
    expect(exists).toBe(true);

    const eventContent = JSON.parse(await readFile(contextJsonPath, "utf-8"));
    // Interval source payload has type "interval"
    expect(eventContent).toHaveProperty("type", "interval");
  });
});
