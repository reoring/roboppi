import { mkdir, readFile, writeFile, cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { InputRef, OutputDef } from "./types.js";

export interface StepMeta {
  stepId: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  wallTimeMs?: number;
  attempts: number;
  iterations?: number;
  maxIterations?: number;
  workerKind: string;
  artifacts: Array<{ name: string; path: string; type?: string }>;
  workerResult?: unknown;
}

function validatePathSegment(name: string): void {
  if (name.includes("..") || name.includes(path.sep) || name.includes("/")) {
    throw new Error(`Invalid path segment: ${name}`);
  }
}

function ensureWithinBase(basePath: string, targetPath: string): string {
  // Reject raw ".." segments in the input before resolution
  const segments = targetPath.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new Error(`Path traversal detected: ${targetPath}`);
  }
  const resolved = path.resolve(basePath, targetPath);
  const resolvedBase = path.resolve(basePath);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path traversal detected: ${targetPath}`);
  }
  return resolved;
}

export class ContextManager {
  constructor(private readonly contextDir: string) {}

  async initWorkflow(workflowId: string, workflowName: string): Promise<void> {
    await mkdir(this.contextDir, { recursive: true });
    const workflowMeta = {
      id: workflowId,
      name: workflowName,
      startedAt: Date.now(),
      status: "RUNNING",
    };
    await writeFile(
      path.join(this.contextDir, "_workflow.json"),
      JSON.stringify(workflowMeta, null, 2),
    );
  }

  async initStep(stepId: string): Promise<void> {
    await mkdir(path.join(this.contextDir, stepId), { recursive: true });
  }

  async resolveInputs(
    _stepId: string,
    inputs: InputRef[],
    workspaceDir: string,
  ): Promise<void> {
    for (const input of inputs) {
      validatePathSegment(input.artifact);
      const srcDir = ensureWithinBase(this.contextDir, path.join(input.from, input.artifact));
      const localName = input.as ?? input.artifact;
      const destDir = ensureWithinBase(workspaceDir, localName);

      const srcStat = await stat(srcDir).catch(() => null);
      if (!srcStat) continue;

      await cp(srcDir, destDir, { recursive: true });
    }
  }

  async collectOutputs(
    stepId: string,
    outputs: OutputDef[],
    workspaceDir: string,
  ): Promise<void> {
    for (const output of outputs) {
      const srcPath = ensureWithinBase(workspaceDir, output.path);
      const destDir = ensureWithinBase(this.contextDir, path.join(stepId, output.name));

      const srcStat = await stat(srcPath).catch(() => null);
      if (!srcStat) continue;

      if (srcStat.isDirectory()) {
        await cp(srcPath, destDir, { recursive: true });
      } else {
        await mkdir(destDir, { recursive: true });
        await cp(srcPath, path.join(destDir, path.basename(output.path)));
      }
    }
  }

  async writeStepMeta(stepId: string, meta: StepMeta): Promise<void> {
    const metaPath = path.join(this.contextDir, stepId, "_meta.json");
    await mkdir(path.join(this.contextDir, stepId), { recursive: true });
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
  }

  async readStepMeta(stepId: string): Promise<StepMeta | null> {
    const metaPath = path.join(this.contextDir, stepId, "_meta.json");
    try {
      const content = await readFile(metaPath, "utf-8");
      return JSON.parse(content) as StepMeta;
    } catch {
      return null;
    }
  }

  async writeWorkflowMeta(data: Record<string, unknown>): Promise<void> {
    const metaPath = path.join(this.contextDir, "_workflow.json");
    await writeFile(metaPath, JSON.stringify(data, null, 2));
  }

  async cleanup(): Promise<void> {
    await rm(this.contextDir, { recursive: true, force: true });
  }

  getArtifactPath(stepId: string, artifactName: string): string {
    validatePathSegment(artifactName);
    return path.join(this.contextDir, stepId, artifactName);
  }
}
