import path from "node:path";

export type EffectiveBaseBranchSource = "cli" | "env" | "current";
export type ProtectedBranchesSource = "default" | "env" | "cli";

export interface ResolveBranchRuntimeContextInput {
  workspaceDir: string;
  cliBaseBranch?: string;
  envBaseBranch?: string;
  cliProtectedBranches?: string;
  envProtectedBranches?: string;
  cliAllowProtectedBranch?: boolean;
  envAllowProtectedBranch?: string;
  createBranch?: boolean;
  expectedWorkBranch?: string;
  branchTransitionStep?: string;
  stepIds?: string[];
}

export interface BranchRuntimeContext {
  enabled: boolean;
  createBranch: boolean;
  expectedWorkBranch?: string;
  expectedCurrentBranch?: string;
  branchTransitionStep?: string;

  startupToplevel?: string;
  startupBranch?: string;
  startupHeadSha?: string;

  effectiveBaseBranch?: string;
  effectiveBaseBranchSource?: EffectiveBaseBranchSource;
  effectiveBaseSha?: string;

  protectedBranches: string[];
  protectedBranchesSource: ProtectedBranchesSource;
  allowProtectedBranch: boolean;

  warnings: string[];
}

const DEFAULT_PROTECTED_BRANCHES = ["main", "master", "release/*"];

export function toBranchWorkflowMeta(context: BranchRuntimeContext): Record<string, unknown> {
  return {
    create_branch: context.createBranch,
    expected_work_branch: context.expectedWorkBranch,
    expected_current_branch: context.expectedCurrentBranch,
    startup_toplevel: context.startupToplevel,
    startup_branch: context.startupBranch,
    startup_head_sha: context.startupHeadSha,
    effective_base_branch: context.effectiveBaseBranch,
    effective_base_branch_source: context.effectiveBaseBranchSource,
    effective_base_sha: context.effectiveBaseSha,
    protected_branches: context.protectedBranches,
    protected_branches_source: context.protectedBranchesSource,
    allow_protected_branch: context.allowProtectedBranch,
    branch_lock_enabled: context.enabled,
  };
}

export async function resolveBranchRuntimeContext(
  input: ResolveBranchRuntimeContextInput,
): Promise<BranchRuntimeContext> {
  const workspaceDir = path.resolve(input.workspaceDir);
  const createBranch = input.createBranch ?? false;
  const expectedWorkBranchOverride = normalizeOptionalString(input.expectedWorkBranch);

  const protectedResolved = resolveProtectedBranches(
    normalizeOptionalString(input.cliProtectedBranches),
    normalizeOptionalString(input.envProtectedBranches),
  );
  const allowProtectedBranch =
    input.cliAllowProtectedBranch === true ||
    parseEnvBool(input.envAllowProtectedBranch) === true;

  const branchTransitionStep = resolveTransitionStep(
    createBranch,
    normalizeOptionalString(input.branchTransitionStep),
    input.stepIds ?? [],
  );

  const gitDir = await runCommand(workspaceDir, ["git", "rev-parse", "--git-dir"]);
  if (gitDir.code !== 0) {
    return {
      enabled: false,
      createBranch,
      expectedWorkBranch: expectedWorkBranchOverride,
      expectedCurrentBranch: expectedWorkBranchOverride,
      branchTransitionStep,
      protectedBranches: protectedResolved.protectedBranches,
      protectedBranchesSource: protectedResolved.source,
      allowProtectedBranch,
      warnings: ["branch lock disabled: workspace is not a git repository"],
    };
  }

  const startupToplevel = await runGitOrThrow(
    workspaceDir,
    ["rev-parse", "--show-toplevel"],
    "failed to resolve startup_toplevel",
  );
  const startupBranch = await runGitOrThrow(
    workspaceDir,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    "failed to resolve startup_branch",
  );
  const startupHeadSha = await runGitOrThrow(
    workspaceDir,
    ["rev-parse", "HEAD"],
    "failed to resolve startup_head_sha",
  );

  const warnings: string[] = [];
  if (allowProtectedBranch) {
    warnings.push("allow_protected_branch=true (protected branch guard is disabled)");
  }

  const cliBaseBranch = normalizeOptionalString(input.cliBaseBranch);
  const envBaseBranch = normalizeOptionalString(input.envBaseBranch);
  let effectiveBaseBranchSource: EffectiveBaseBranchSource;
  let effectiveBaseBranch: string;
  if (cliBaseBranch) {
    effectiveBaseBranchSource = "cli";
    effectiveBaseBranch = cliBaseBranch;
  } else if (envBaseBranch) {
    effectiveBaseBranchSource = "env";
    effectiveBaseBranch = envBaseBranch;
  } else {
    if (startupBranch === "HEAD") {
      throw new Error(
        "detached HEAD is not allowed without explicit BASE_BRANCH/--base-branch",
      );
    }
    effectiveBaseBranchSource = "current";
    effectiveBaseBranch = startupBranch;
  }

  const effectiveBaseSha = await runGitOrThrow(
    workspaceDir,
    ["rev-parse", `${effectiveBaseBranch}^{commit}`],
    `failed to resolve effective_base_sha from base branch "${effectiveBaseBranch}"`,
  );

  if (
    effectiveBaseBranchSource !== "current" &&
    startupBranch !== "HEAD" &&
    startupBranch !== effectiveBaseBranch
  ) {
    warnings.push(
      `BASE_BRANCH override active: base="${effectiveBaseBranch}", startup_branch="${startupBranch}"`,
    );
  }

  const expectedWorkBranch = expectedWorkBranchOverride ?? startupBranch;
  const expectedCurrentBranch = expectedWorkBranch;

  if (
    createBranch === false &&
    expectedWorkBranch !== undefined &&
    isBranchProtected(expectedWorkBranch, protectedResolved.protectedBranches) &&
    !allowProtectedBranch
  ) {
    throw new Error(
      `blocked: expected_work_branch "${expectedWorkBranch}" is protected ` +
        `(protected_branches=${protectedResolved.protectedBranches.join(",")}). ` +
        `Use --allow-protected-branch or ROBOPPI_ALLOW_PROTECTED_BRANCH=1 to override.`,
    );
  }

  return {
    enabled: true,
    createBranch,
    expectedWorkBranch,
    expectedCurrentBranch,
    branchTransitionStep,
    startupToplevel,
    startupBranch,
    startupHeadSha,
    effectiveBaseBranch,
    effectiveBaseBranchSource,
    effectiveBaseSha,
    protectedBranches: protectedResolved.protectedBranches,
    protectedBranchesSource: protectedResolved.source,
    allowProtectedBranch,
    warnings,
  };
}

export function isBranchProtected(branch: string, protectedBranches: string[]): boolean {
  const target = branch.trim();
  if (!target) return false;
  for (const pattern of protectedBranches) {
    if (matchesBranchPattern(pattern, target)) return true;
  }
  return false;
}

function resolveTransitionStep(
  createBranch: boolean,
  configured: string | undefined,
  stepIds: string[],
): string | undefined {
  if (!createBranch) return undefined;
  if (configured) return configured;
  return stepIds.includes("branch") ? "branch" : undefined;
}

function resolveProtectedBranches(
  cliCsv: string | undefined,
  envCsv: string | undefined,
): { protectedBranches: string[]; source: ProtectedBranchesSource } {
  if (cliCsv) {
    return {
      protectedBranches: parseCsvBranches(cliCsv, "cli"),
      source: "cli",
    };
  }
  if (envCsv) {
    return {
      protectedBranches: parseCsvBranches(envCsv, "env"),
      source: "env",
    };
  }
  return {
    protectedBranches: [...DEFAULT_PROTECTED_BRANCHES],
    source: "default",
  };
}

function parseCsvBranches(csv: string, source: "cli" | "env"): string[] {
  const parts = csv
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (parts.length === 0) {
    throw new Error(`protected branches ${source} value is empty`);
  }
  return parts;
}

function matchesBranchPattern(pattern: string, branch: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (!p.includes("*")) {
    return branch === p;
  }
  const re = globToRegExp(p);
  return re.test(branch);
}

function globToRegExp(pattern: string): RegExp {
  let re = "^";
  for (const c of pattern) {
    if (c === "*") {
      re += ".*";
      continue;
    }
    if (/[\\^$.*+?()[\]{}|]/.test(c)) {
      re += `\\${c}`;
      continue;
    }
    re += c;
  }
  re += "$";
  return new RegExp(re);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseEnvBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

async function runGitOrThrow(
  cwd: string,
  args: string[],
  context: string,
): Promise<string> {
  const out = await runCommand(cwd, ["git", ...args]);
  if (out.code !== 0) {
    const detail = out.stderr.trim() || out.stdout.trim() || `exit=${out.code}`;
    throw new Error(`${context}: ${detail}`);
  }
  const trimmed = out.stdout.trim();
  if (!trimmed) {
    throw new Error(`${context}: empty output`);
  }
  return trimmed;
}

async function runCommand(
  cwd: string,
  command: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(command, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { code: 127, stdout: "", stderr: msg };
  }
}
