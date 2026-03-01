/**
 * Engine factory — creates the appropriate ManagementAgentEngine based on config.
 */

import type { StepRunner } from "../executor.js";
import type { ManagementAgentEngine, ManagementAgentConfig } from "./types.js";
import { WorkerEngine } from "./worker-engine.js";
import { PiSdkEngine, type CreateAgentSessionFn } from "./pi-sdk-engine.js";

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface CreateEngineOptions {
  contextDir: string;
  workspaceDir: string;
  agentConfig: ManagementAgentConfig;
  /** Required for WorkerEngine; optional for PiSdkEngine. */
  stepRunner?: StepRunner;
  baseEnv?: Record<string, string>;
  /** Inject createAgentSession for PiSdkEngine testing. */
  createAgentSession?: CreateAgentSessionFn;
}

// ---------------------------------------------------------------------------
// createEngine
// ---------------------------------------------------------------------------

/**
 * Create a ManagementAgentEngine based on the engine type.
 *
 * @param engineType - "worker" (default) or "pi"
 * @param opts - engine configuration
 */
export function createEngine(
  engineType: string | undefined,
  opts: CreateEngineOptions,
): ManagementAgentEngine {
  const type = engineType ?? "worker";

  if (type === "pi") {
    return new PiSdkEngine({
      contextDir: opts.contextDir,
      workspaceDir: opts.workspaceDir,
      agentConfig: opts.agentConfig,
      createAgentSession: opts.createAgentSession,
    });
  }

  // Default: worker engine
  if (!opts.stepRunner) {
    throw new Error("WorkerEngine requires a stepRunner.");
  }
  return new WorkerEngine({
    contextDir: opts.contextDir,
    stepRunner: opts.stepRunner,
    workspaceDir: opts.workspaceDir,
    agentConfig: opts.agentConfig,
    baseEnv: opts.baseEnv,
  });
}
