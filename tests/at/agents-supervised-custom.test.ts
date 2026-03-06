/**
 * AT: Supervised workflow scenario — 2 CUSTOM workers exchanging agent messages.
 *
 * Covers `docs/spec/agents.md` §3.6:
 * - runs with supervised mode enabled
 * - uses `roboppi agents ...` CLI commands (not direct store API calls)
 * - includes two CUSTOM workers exchanging messages/tasks
 * - verifies emitted agent_* ExecEvents and _agents/_events.jsonl artifacts
 *
 * Note: the mailbox `_events.jsonl` is deleted by the default cleanup policy
 * (retain_mailbox=false), so we verify events via:
 * - the collectingSink (ExecEvent captures in memory)
 * - the agents-level `_agents/_events.jsonl` (survives cleanup)
 */
import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { parseWorkflow } from "../../src/workflow/parser.js";
import { ContextManager } from "../../src/workflow/context-manager.js";
import { WorkflowExecutor } from "../../src/workflow/executor.js";
import type { StepRunResult, CheckResult } from "../../src/workflow/executor.js";
import type { StepDefinition, CompletionCheckDef } from "../../src/workflow/types.js";
import { WorkflowStatus } from "../../src/workflow/types.js";
import { TuiStateStore } from "../../src/tui/state-store.js";
import type { ExecEvent } from "../../src/tui/exec-event.js";
import { agentEventsPath } from "../../src/agents/paths.js";
import { withTempDir, path } from "./helpers.js";
import type { AgentCatalog } from "../../src/workflow/agent-catalog.js";

const REPO_ROOT = process.cwd();

/**
 * Run `roboppi agents ...` via CLI subprocess (Spec 3.6 requirement).
 * Returns parsed JSON stdout and exit code.
 */
function runAgentsCliSync(
  args: string[],
  env?: Record<string, string>,
): { json: any; code: number } {
  const result = spawnSync(
    process.execPath,
    ["run", "src/cli.ts", "--", "agents", ...args],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    },
  );
  const stdout = result.stdout?.toString("utf-8")?.trim() ?? "";
  let json: any = {};
  try {
    json = JSON.parse(stdout);
  } catch {
    // non-JSON output
  }
  return { json, code: result.status ?? 1 };
}

const WORKFLOW_YAML = `
name: agents-custom-test
version: "1"
timeout: "30s"
concurrency: 4

agents:
  enabled: true
  team_name: "custom-test-team"
  members:
    lead:
      agent: lead_agent
    worker1:
      agent: worker1_agent
    worker2:
      agent: worker2_agent

steps:
  noop:
    worker: CUSTOM
    instructions: "echo done"
    capabilities: [READ]
    timeout: "10s"
`;

const AGENT_CATALOG: AgentCatalog = {
  lead_agent: {
    worker: "CUSTOM",
    base_instructions: "#!/bin/bash\necho lead-ready",
    capabilities: ["READ", "MAILBOX", "TASKS"],
  },
  worker1_agent: {
    worker: "CUSTOM",
    base_instructions: "#!/bin/bash\necho worker1-ready",
    capabilities: ["READ", "MAILBOX", "TASKS"],
  },
  worker2_agent: {
    worker: "CUSTOM",
    base_instructions: "#!/bin/bash\necho worker2-ready",
    capabilities: ["READ", "MAILBOX", "TASKS"],
  },
};

describe("AT: agents supervised workflow with 2 CUSTOM workers", () => {
  it("workers exchange messages/tasks via CLI and agent events appear in artifacts", async () => {
    await withTempDir(async (dir) => {
      const definition = parseWorkflow(WORKFLOW_YAML);
      const contextDir = path.join(dir, "context");
      const ctx = new ContextManager(contextDir);

      // Collecting sink to capture emitted ExecEvents
      const store = new TuiStateStore();
      const collectedEvents: ExecEvent[] = [];
      const collectingSink = {
        emit(event: ExecEvent) {
          collectedEvents.push(event);
          store.emit(event);
        },
      };

      // Track which teammate steps run and CLI results
      const ranSteps: string[] = [];
      const cliResults: { stepId: string; cmd: string; code: number; ok: boolean }[] = [];

      const mockRunner = {
        async runStep(
          stepId: string,
          _step: StepDefinition,
          _workspace: string,
          _signal: AbortSignal,
          env?: Record<string, string>,
        ): Promise<StepRunResult> {
          ranSteps.push(stepId);

          if (stepId === "_agent:worker1" && env) {
            const ctxDir = env.ROBOPPI_AGENTS_CONTEXT_DIR;
            if (ctxDir) {
              const cliEnv = {
                ROBOPPI_AGENTS_CONTEXT_DIR: ctxDir,
                ROBOPPI_AGENTS_MEMBER_ID: "worker1",
              };

              // worker1: add a task via CLI
              const addResult = runAgentsCliSync([
                "tasks", "add",
                "--context", ctxDir,
                "--title", "Review module X",
                "--description", "Check for bugs",
              ], cliEnv);
              cliResults.push({ stepId, cmd: "tasks add", code: addResult.code, ok: addResult.json.ok });

              // worker1: send a message to worker2 via CLI
              const sendResult = runAgentsCliSync([
                "message", "send",
                "--context", ctxDir,
                "--from", "worker1",
                "--to", "worker2",
                "--topic", "task-assignment",
                "--body", "Please review module X",
              ], cliEnv);
              cliResults.push({ stepId, cmd: "message send", code: sendResult.code, ok: sendResult.json.ok });

              // worker1: send a message to lead via CLI
              const send2Result = runAgentsCliSync([
                "message", "send",
                "--context", ctxDir,
                "--from", "worker1",
                "--to", "lead",
                "--topic", "findings",
                "--body", "I found a bug in module X.",
              ], cliEnv);
              cliResults.push({ stepId, cmd: "message send (lead)", code: send2Result.code, ok: send2Result.json.ok });
            }
          }

          if (stepId === "_agent:worker2" && env) {
            const ctxDir = env.ROBOPPI_AGENTS_CONTEXT_DIR;
            if (ctxDir) {
              const cliEnv = {
                ROBOPPI_AGENTS_CONTEXT_DIR: ctxDir,
                ROBOPPI_AGENTS_MEMBER_ID: "worker2",
              };

              // worker2: send a response back to worker1 via CLI
              const sendResult = runAgentsCliSync([
                "message", "send",
                "--context", ctxDir,
                "--from", "worker2",
                "--to", "worker1",
                "--topic", "task-response",
                "--body", "Acknowledged, will review",
              ], cliEnv);
              cliResults.push({ stepId, cmd: "message send", code: sendResult.code, ok: sendResult.json.ok });

              // worker2: receive and claim messages via CLI
              const recvResult = runAgentsCliSync([
                "message", "recv",
                "--context", ctxDir,
                "--for", "worker2",
                "--claim",
                "--max", "5",
              ], cliEnv);
              cliResults.push({ stepId, cmd: "message recv", code: recvResult.code, ok: recvResult.json.ok });

              // worker2: ack each claimed message via CLI
              if (recvResult.json.ok && Array.isArray(recvResult.json.messages)) {
                for (const msg of recvResult.json.messages) {
                  if (msg.claim?.token) {
                    const ackResult = runAgentsCliSync([
                      "message", "ack",
                      "--context", ctxDir,
                      "--for", "worker2",
                      "--claim-token", msg.claim.token,
                    ], cliEnv);
                    cliResults.push({ stepId, cmd: "message ack", code: ackResult.code, ok: ackResult.json.ok });
                  }
                }
              }
            }
          }

          return { status: "SUCCEEDED" };
        },

        async runCheck(
          _stepId: string,
          _check: CompletionCheckDef,
          _workspace: string,
          _signal: AbortSignal,
        ): Promise<CheckResult> {
          return { complete: true, failed: false };
        },
      };

      const executor = new WorkflowExecutor(
        definition,
        ctx,
        mockRunner,
        dir,
        undefined,    // env
        undefined,    // abortSignal
        undefined,    // branchContext
        true,         // supervised: true (Spec 3.6)
        collectingSink,
        { agentCatalog: AGENT_CATALOG },
      );

      const state = await executor.execute();

      // 1. Workflow completed
      expect(state.status).toBe(WorkflowStatus.SUCCEEDED);

      // 2. Both teammate steps ran
      expect(ranSteps).toContain("_agent:worker1");
      expect(ranSteps).toContain("_agent:worker2");

      // 3. All CLI invocations succeeded (exit code 0, ok: true)
      for (const r of cliResults) {
        expect(r.code).toBe(0);
        expect(r.ok).toBe(true);
      }
      // At minimum: worker1 did 3 ops (tasks add, 2x message send),
      // worker2 did 2+ ops (message send, message recv, message ack(s))
      expect(cliResults.length).toBeGreaterThanOrEqual(5);

      // 4. Verify agent_* ExecEvents were emitted by coordinator event tailing.
      const agentExecEvents = collectedEvents.filter(
        (e) =>
          e.type === "agent_message_sent" ||
          e.type === "agent_message_received" ||
          e.type === "agent_task_claimed" ||
          e.type === "agent_task_completed",
      );
      const sentEvents = agentExecEvents.filter((e) => e.type === "agent_message_sent");
      expect(sentEvents.length).toBeGreaterThanOrEqual(1);

      // 5. Verify agent-level _events.jsonl (survives mailbox/tasks cleanup)
      let agentEventsContent: string;
      try {
        agentEventsContent = await readFile(agentEventsPath(contextDir), "utf-8");
      } catch {
        agentEventsContent = "";
      }

      expect(agentEventsContent).toBeTruthy();
      const agentEventLines = agentEventsContent
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      // The coordinator emits exactly one agent_cleanup event on stop
      const cleanupEvents = agentEventLines.filter(
        (e: { type: string }) => e.type === "agent_cleanup",
      );
      expect(cleanupEvents.length).toBe(1);
      expect(cleanupEvents[0]).toHaveProperty("team_id");
      expect(cleanupEvents[0]).toHaveProperty("teammates_settled");
      expect(cleanupEvents[0]).toHaveProperty("mailbox_retained");
      expect(cleanupEvents[0]).toHaveProperty("tasks_retained");
    });
  });

  it("CUSTOM worker instructions are shell-safe (no natural-language)", async () => {
    await withTempDir(async (dir) => {
      const definition = parseWorkflow(WORKFLOW_YAML);
      const contextDir = path.join(dir, "context");
      const ctx = new ContextManager(contextDir);

      const capturedSteps: { stepId: string; step: StepDefinition }[] = [];
      const mockRunner = {
        async runStep(
          stepId: string,
          step: StepDefinition,
          _workspace: string,
          _signal: AbortSignal,
        ): Promise<StepRunResult> {
          capturedSteps.push({ stepId, step });
          return { status: "SUCCEEDED" };
        },
        async runCheck(): Promise<CheckResult> {
          return { complete: true, failed: false };
        },
      };

      const executor = new WorkflowExecutor(
        definition,
        ctx,
        mockRunner,
        dir,
        undefined,
        undefined,
        undefined,
        true,         // supervised: true
        { emit() {} },
        { agentCatalog: AGENT_CATALOG },
      );

      await executor.execute();

      // Find teammate steps spawned by the coordinator
      const worker1Step = capturedSteps.find((s) => s.stepId === "_agent:worker1");
      expect(worker1Step).toBeTruthy();
      expect(worker1Step!.step.worker).toBe("CUSTOM");

      const worker2Step = capturedSteps.find((s) => s.stepId === "_agent:worker2");
      expect(worker2Step).toBeTruthy();
      expect(worker2Step!.step.worker).toBe("CUSTOM");

      // CUSTOM worker instructions must not contain natural-language lines
      for (const step of [worker1Step!, worker2Step!]) {
        const instructions = step.step.instructions!;
        expect(instructions).not.toContain("You are team member");
        expect(instructions).toContain("#!/bin/bash");
        expect(instructions).toContain("# agent teammate:");
      }
    });
  });
});
