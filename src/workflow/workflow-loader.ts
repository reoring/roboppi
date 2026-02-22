/**
 * Shared workflow + agent catalog loading logic.
 *
 * Consolidates the duplicated loading patterns from `run.ts` and `daemon.ts`
 * and provides `loadChildWorkflow()` for subworkflow resolution.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseWorkflow } from "./parser.js";
import { parseAgentCatalog, type AgentCatalog } from "./agent-catalog.js";
import type { WorkflowDefinition } from "./types.js";

export interface LoadedWorkflow {
  definition: WorkflowDefinition;
  definitionPath: string;       // absolute path
  agentCatalog?: AgentCatalog;
}

export interface LoadWorkflowOptions {
  explicitAgentsPaths?: string[];
  envAgentsPaths?: string[];
  parentAgentCatalog?: AgentCatalog;
}

/**
 * Load an agent catalog for a given workflow YAML path.
 *
 * Resolution order:
 * 1. Explicit paths from env + CLI (merged).
 * 2. If no explicit paths: look for agents.yaml / agents.yml next to the workflow.
 * 3. If a parentAgentCatalog is provided, merge it underneath (child overrides).
 */
export async function loadAgentCatalog(
  workflowYamlPath: string,
  options?: {
    explicitAgentsPaths?: string[];
    envAgentsPaths?: string[];
    parentAgentCatalog?: AgentCatalog;
  },
): Promise<AgentCatalog | undefined> {
  const envPaths = options?.envAgentsPaths ?? [];
  const cliPaths = options?.explicitAgentsPaths ?? [];
  const explicit = [...envPaths, ...cliPaths];

  const candidates: string[] = [];
  if (explicit.length > 0) {
    candidates.push(...explicit.map((p) => path.resolve(p)));
  } else {
    const dir = path.dirname(workflowYamlPath);
    candidates.push(path.join(dir, "agents.yaml"));
    candidates.push(path.join(dir, "agents.yml"));
  }

  let catalog: AgentCatalog | undefined;

  // Start with parent catalog if provided
  if (options?.parentAgentCatalog) {
    catalog = { ...options.parentAgentCatalog };
  }

  for (const p of candidates) {
    try {
      const content = await readFile(p, "utf-8");
      const parsed = parseAgentCatalog(content);
      catalog = { ...(catalog ?? {}), ...parsed };
    } catch (err: unknown) {
      const code = (err as any)?.code;

      // In implicit mode, missing default files are ignored.
      if (explicit.length === 0 && code === "ENOENT") {
        continue;
      }

      if (code === "ENOENT") {
        throw new Error(`Agent catalog not found: ${p}`);
      }
      throw err;
    }
  }

  return catalog;
}

/**
 * Load and parse a workflow YAML file.
 */
export async function loadWorkflow(
  yamlPath: string,
  options?: LoadWorkflowOptions,
): Promise<LoadedWorkflow> {
  const definitionPath = path.resolve(yamlPath);
  const yamlContent = await readFile(definitionPath, "utf-8");
  const agentCatalog = await loadAgentCatalog(definitionPath, {
    explicitAgentsPaths: options?.explicitAgentsPaths,
    envAgentsPaths: options?.envAgentsPaths,
    parentAgentCatalog: options?.parentAgentCatalog,
  });
  const definition = parseWorkflow(yamlContent, { agents: agentCatalog });
  return { definition, definitionPath, agentCatalog };
}

/**
 * Load a child (sub) workflow.
 *
 * Path resolution:
 * - If `parentDefinitionPath` is provided, resolve relative to its directory.
 * - Otherwise, resolve relative to `workspaceDir`.
 *
 * Agent catalog inheritance:
 * Children inherit the parent's **resolved** catalog via `parentAgentCatalog`.
 * Explicit CLI/env agent paths are intentionally not propagated here because
 * they are already incorporated into the parent's resolved catalog at load
 * time.  The child may further overlay its own colocated agents.yaml on top.
 */
export async function loadChildWorkflow(
  childRelativePath: string,
  parentDefinitionPath: string | undefined,
  workspaceDir: string,
  parentAgentCatalog?: AgentCatalog,
): Promise<LoadedWorkflow> {
  const baseDir = parentDefinitionPath
    ? path.dirname(parentDefinitionPath)
    : workspaceDir;

  const childAbsPath = path.resolve(baseDir, childRelativePath);

  return loadWorkflow(childAbsPath, {
    parentAgentCatalog,
  });
}
