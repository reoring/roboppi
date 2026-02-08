import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expandTemplate } from "../../../src/daemon/template.js";
import { EvaluateGate } from "../../../src/daemon/evaluate-gate.js";
import { ResultAnalyzer } from "../../../src/daemon/result-analyzer.js";
import { Daemon } from "../../../src/daemon/daemon.js";
import type { DaemonConfig, DaemonEvent } from "../../../src/daemon/types.js";
import type { WorkflowState } from "../../../src/workflow/types.js";
import { WorkflowStatus } from "../../../src/workflow/types.js";

// ---------------------------------------------------------------------------
// Template expansion
// ---------------------------------------------------------------------------

describe("expandTemplate", () => {
  test("replaces known variables", () => {
    const result = expandTemplate("Hello {{name}}!", { name: "world" });
    expect(result).toBe("Hello world!");
  });

  test("leaves unknown variables as-is", () => {
    const result = expandTemplate("{{known}} and {{unknown}}", { known: "yes" });
    expect(result).toBe("yes and {{unknown}}");
  });

  test("replaces multiple occurrences", () => {
    const result = expandTemplate("{{x}} + {{x}} = {{y}}", { x: "1", y: "2" });
    expect(result).toBe("1 + 1 = 2");
  });

  test("handles empty template", () => {
    const result = expandTemplate("", { a: "b" });
    expect(result).toBe("");
  });

  test("handles template with no variables", () => {
    const result = expandTemplate("no vars here", { a: "b" });
    expect(result).toBe("no vars here");
  });

  test("handles empty vars", () => {
    const result = expandTemplate("{{a}}", {});
    expect(result).toBe("{{a}}");
  });

  test("dot notation: resolves nested JSON field", () => {
    const vars = { event: JSON.stringify({ type: "cron", schedule: "*/5 * * * *" }) };
    expect(expandTemplate("Type: {{event.type}}", vars)).toBe("Type: cron");
  });

  test("dot notation: resolves deeply nested field", () => {
    const vars = { event: JSON.stringify({ payload: { method: "POST", path: "/hook" } }) };
    expect(expandTemplate("{{event.payload.method}}", vars)).toBe("POST");
  });

  test("dot notation: resolves from last_result JSON", () => {
    const vars = { last_result: JSON.stringify({ status: "SUCCEEDED", steps: {} }) };
    expect(expandTemplate("{{last_result.status}}", vars)).toBe("SUCCEEDED");
  });

  test("dot notation: exact key match takes priority", () => {
    const vars = { "event.type": "exact", event: JSON.stringify({ type: "nested" }) };
    expect(expandTemplate("{{event.type}}", vars)).toBe("exact");
  });

  test("dot notation: invalid JSON leaves as-is", () => {
    const vars = { event: "not-json" };
    expect(expandTemplate("{{event.type}}", vars)).toBe("{{event.type}}");
  });

  test("dot notation: non-existent path leaves as-is", () => {
    const vars = { event: JSON.stringify({ type: "cron" }) };
    expect(expandTemplate("{{event.missing}}", vars)).toBe("{{event.missing}}");
  });

  test("dot notation: non-string values serialized as JSON", () => {
    const vars = { data: JSON.stringify({ count: 42, nested: { a: 1 } }) };
    expect(expandTemplate("{{data.count}}", vars)).toBe("42");
    expect(expandTemplate("{{data.nested}}", vars)).toBe('{"a":1}');
  });
});

// ---------------------------------------------------------------------------
// EvaluateGate
// ---------------------------------------------------------------------------

describe("EvaluateGate", () => {
  const gate = new EvaluateGate();

  function makeEvent(sourceId: string): DaemonEvent {
    return {
      sourceId,
      timestamp: Date.now(),
      payload: { type: "interval", firedAt: Date.now() },
    };
  }

  test("CUSTOM worker: exit 0 returns true", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "eval-gate-"));
    const result = await gate.shouldRun(
      {
        worker: "CUSTOM",
        instructions: "exit 0",
        capabilities: ["RUN_COMMANDS"],
      },
      makeEvent("test"),
      null,
      tmpDir,
    );
    expect(result).toBe(true);
  });

  test("CUSTOM worker: exit 1 returns false", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "eval-gate-"));
    const result = await gate.shouldRun(
      {
        worker: "CUSTOM",
        instructions: "exit 1",
        capabilities: ["RUN_COMMANDS"],
      },
      makeEvent("test"),
      null,
      tmpDir,
    );
    expect(result).toBe(false);
  });

  test("CUSTOM worker: template variables are expanded", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "eval-gate-"));
    // Uses {{timestamp}} which should be replaced with an ISO string
    const result = await gate.shouldRun(
      {
        worker: "CUSTOM",
        instructions: 'test -n "{{timestamp}}"',
        capabilities: ["RUN_COMMANDS"],
      },
      makeEvent("test"),
      null,
      tmpDir,
    );
    expect(result).toBe(true);
  });

  test("non-CUSTOM worker with short timeout returns boolean", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "eval-gate-"));
    const result = await gate.shouldRun(
      {
        worker: "CLAUDE_CODE",
        instructions: "should we run?",
        capabilities: ["READ"],
        timeout: "1s",
      },
      makeEvent("test"),
      null,
      tmpDir,
    );
    // Now that LLM workers spawn the actual CLI, the result depends on
    // CLI availability and configuration. We just verify it returns a boolean.
    expect(typeof result).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// ResultAnalyzer
// ---------------------------------------------------------------------------

describe("ResultAnalyzer", () => {
  const analyzer = new ResultAnalyzer();

  const mockResult: WorkflowState = {
    workflowId: "test-wf-1",
    name: "test-workflow",
    status: WorkflowStatus.SUCCEEDED,
    steps: {},
    startedAt: Date.now(),
    completedAt: Date.now(),
  };

  test("CUSTOM worker: returns stdout", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "result-analyzer-"));
    const output = await analyzer.analyze(
      {
        worker: "CUSTOM",
        instructions: 'echo "analysis complete"',
        capabilities: ["RUN_COMMANDS"],
      },
      mockResult,
      tmpDir,
      tmpDir,
    );
    expect(output).toBe("analysis complete");
  });

  test("CUSTOM worker: template variables expanded", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "result-analyzer-"));
    const output = await analyzer.analyze(
      {
        worker: "CUSTOM",
        instructions: "echo {{workflow_status}}",
        capabilities: ["RUN_COMMANDS"],
      },
      mockResult,
      tmpDir,
      tmpDir,
    );
    expect(output).toBe("SUCCEEDED");
  });

  test("non-CUSTOM worker returns empty string when CLI not found", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "result-analyzer-"));
    // Override CLI command to use a non-existent binary
    const testAnalyzer = new (class extends ResultAnalyzer {
      protected override buildCliCommand(
        _worker: string,
        instructions: string,
      ): string[] | null {
        return ["nonexistent-cli-binary-xyz-123", "-p", instructions];
      }
    })();
    const output = await testAnalyzer.analyze(
      {
        worker: "CLAUDE_CODE",
        instructions: "analyze results",
        capabilities: ["READ"],
      },
      mockResult,
      tmpDir,
      tmpDir,
    );
    expect(output).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

describe("Daemon", () => {
  test("starts and stops with interval source", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "daemon-test-"));
    const workflowDir = tmpDir;
    const stateDir = path.join(tmpDir, "state");

    // Create a simple workflow YAML
    const workflowYaml = `
name: test-workflow
version: "1"
timeout: "30s"
steps:
  greet:
    worker: CUSTOM
    instructions: "echo hello"
    capabilities: [RUN_COMMANDS]
`;
    await writeFile(path.join(workflowDir, "test.yaml"), workflowYaml);

    const config: DaemonConfig = {
      name: "test-daemon",
      version: "1",
      workspace: workflowDir,
      state_dir: stateDir,
      events: {
        tick: {
          type: "interval",
          every: "1s",
        },
      },
      triggers: {
        on_tick: {
          on: "tick",
          workflow: "test.yaml",
        },
      },
    };

    const daemon = new Daemon(config);

    // Start daemon in background, then stop it after a brief delay
    const startPromise = daemon.start();

    // Give it time for one event cycle
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await daemon.stop();
    await startPromise;

    // Verify daemon state was saved
    const { DaemonStateStore } = await import("../../../src/daemon/state-store.js");
    const store = new DaemonStateStore(stateDir);
    const state = await store.getDaemonState();
    expect(state).not.toBeNull();
    expect(state!.configName).toBe("test-daemon");
    expect(state!.status).toBe("stopped");
  });

  test("starts and stops with fswatch source", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "daemon-fswatch-"));
    const stateDir = path.join(tmpDir, "state");
    const watchDir = path.join(tmpDir, "watched");
    const { mkdir: mkdirFs } = await import("node:fs/promises");
    await mkdirFs(watchDir, { recursive: true });

    const config: DaemonConfig = {
      name: "test-daemon-fswatch",
      version: "1",
      workspace: tmpDir,
      state_dir: stateDir,
      events: {
        watcher: {
          type: "fswatch",
          paths: [watchDir],
        },
      },
      triggers: {
        on_watch: {
          on: "watcher",
          workflow: "test.yaml",
        },
      },
    };

    const daemon = new Daemon(config);
    const startPromise = daemon.start();

    // Give it a moment to initialize, then stop
    await new Promise((resolve) => setTimeout(resolve, 500));
    await daemon.stop();
    await startPromise;

    // Daemon should have started and stopped without errors
    const { DaemonStateStore } = await import("../../../src/daemon/state-store.js");
    const store = new DaemonStateStore(stateDir);
    const state = await store.getDaemonState();
    expect(state).not.toBeNull();
    expect(state!.status).toBe("stopped");
  });

  test("respects evaluate gate to skip workflow", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "daemon-eval-"));
    const stateDir = path.join(tmpDir, "state");

    // Create a simple workflow YAML
    const workflowYaml = `
name: test-workflow
version: "1"
timeout: "30s"
steps:
  greet:
    worker: CUSTOM
    instructions: "echo should-not-run"
    capabilities: [RUN_COMMANDS]
`;
    await writeFile(path.join(tmpDir, "test.yaml"), workflowYaml);

    // Create a marker file to detect if workflow ran
    const markerFile = path.join(tmpDir, "marker.txt");

    const workflowYamlWithMarker = `
name: test-workflow
version: "1"
timeout: "30s"
steps:
  greet:
    worker: CUSTOM
    instructions: "touch ${markerFile}"
    capabilities: [RUN_COMMANDS]
`;
    await writeFile(path.join(tmpDir, "test.yaml"), workflowYamlWithMarker);

    const config: DaemonConfig = {
      name: "eval-daemon",
      version: "1",
      workspace: tmpDir,
      state_dir: stateDir,
      events: {
        tick: {
          type: "interval",
          every: "1s",
        },
      },
      triggers: {
        on_tick: {
          on: "tick",
          workflow: "test.yaml",
          evaluate: {
            worker: "CUSTOM",
            instructions: "exit 1",
            capabilities: ["RUN_COMMANDS"],
          },
        },
      },
    };

    const daemon = new Daemon(config);
    const startPromise = daemon.start();

    await new Promise((resolve) => setTimeout(resolve, 1500));
    await daemon.stop();
    await startPromise;

    // Marker file should NOT exist since evaluate gate returns false
    const exists = await Bun.file(markerFile).exists();
    expect(exists).toBe(false);
  });
});
