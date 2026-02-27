import { afterEach, describe, expect, it } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ManagementController } from "../../../src/workflow/management/management-controller.js";
import type {
  DecisionsLogEntry,
  ManagementAgentEngine,
  ManagementAgentEngineResult,
  ManagementConfig,
} from "../../../src/workflow/management/types.js";
import { StepStatus, type StepState } from "../../../src/workflow/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mgmt-controller-"));
  tempDirs.push(dir);
  return dir;
}

function buildConfig(): ManagementConfig {
  return {
    enabled: true,
    hooks: { pre_step: true },
    agent: {
      worker: "OPENCODE",
      capabilities: ["READ"],
      timeout: "5s",
    },
  };
}

function buildSteps(): Record<string, StepState> {
  return {
    A: {
      status: StepStatus.READY,
      iteration: 0,
      maxIterations: 1,
    },
  };
}

async function readDecisions(contextDir: string): Promise<DecisionsLogEntry[]> {
  const logPath = path.join(contextDir, "_management", "decisions.jsonl");
  const text = await readFile(logPath, "utf-8");
  return text
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DecisionsLogEntry);
}

describe("ManagementController", () => {
  it("marks engine exceptions as fallback (applied=false) and records reason", async () => {
    const contextDir = await makeTempDir();
    const engine: ManagementAgentEngine = {
      async invokeHook(): Promise<ManagementAgentEngineResult> {
        throw new Error("engine boom");
      },
      async dispose(): Promise<void> {},
    };

    const controller = new ManagementController(
      contextDir,
      buildConfig(),
      engine,
    );

    try {
      const directive = await controller.invokeHook(
        "pre_step",
        "A",
        StepStatus.READY,
        buildSteps(),
        new AbortController().signal,
      );

      expect(directive).toEqual({ action: "proceed" });

      const entries = await readDecisions(contextDir);
      expect(entries.length).toBe(1);
      const entry = entries[0]!;
      expect(entry.applied).toBe(false);
      expect(entry.source).toBe("fallback");
      expect(entry.reason).toContain("engine invokeHook threw");
      expect(entry.reason).toContain("engine boom");
    } finally {
      await controller.stop();
    }
  });

  it("passes invocationPaths to engine with existing input/decision paths", async () => {
    const contextDir = await makeTempDir();
    let captured:
      | Parameters<ManagementAgentEngine["invokeHook"]>[0]["invocationPaths"]
      | undefined;

    const engine: ManagementAgentEngine = {
      async invokeHook(
        args: Parameters<ManagementAgentEngine["invokeHook"]>[0],
      ): Promise<ManagementAgentEngineResult> {
        captured = args.invocationPaths;
        return { directive: { action: "proceed" }, source: "decided" };
      },
      async dispose(): Promise<void> {},
    };

    const controller = new ManagementController(
      contextDir,
      buildConfig(),
      engine,
    );

    try {
      await controller.invokeHook(
        "pre_step",
        "A",
        StepStatus.READY,
        buildSteps(),
        new AbortController().signal,
      );

      expect(captured).toBeDefined();
      expect(path.basename(captured!.inputFile)).toBe("input.json");
      expect(path.basename(captured!.decisionFile)).toBe("decision.json");

      await access(captured!.invDir);
      await access(captured!.inputFile);
    } finally {
      await controller.stop();
    }
  });

  it("prefers engine-provided fallback reason in decisions log", async () => {
    const contextDir = await makeTempDir();
    const engine: ManagementAgentEngine = {
      async invokeHook(): Promise<ManagementAgentEngineResult> {
        return {
          directive: { action: "proceed" },
          source: "fallback",
          reason: "engine timeout while waiting for decision tool",
        };
      },
      async dispose(): Promise<void> {},
    };

    const controller = new ManagementController(
      contextDir,
      buildConfig(),
      engine,
    );

    try {
      await controller.invokeHook(
        "pre_step",
        "A",
        StepStatus.READY,
        buildSteps(),
        new AbortController().signal,
      );

      const entries = await readDecisions(contextDir);
      expect(entries.length).toBe(1);
      expect(entries[0]!.applied).toBe(false);
      expect(entries[0]!.source).toBe("fallback");
      expect(entries[0]!.reason).toBe("engine timeout while waiting for decision tool");
    } finally {
      await controller.stop();
    }
  });
});
