import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isBranchProtected,
  resolveBranchRuntimeContext,
} from "../../../src/workflow/branch-context.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "branch-context-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("branch-context", () => {
  it("resolves startup current branch as effective base when BASE_BRANCH is unset", async () => {
    const repoDir = path.join(tempDir, "repo");
    await initRepo(repoDir);

    const context = await resolveBranchRuntimeContext({
      workspaceDir: repoDir,
      createBranch: false,
      cliAllowProtectedBranch: true,
    });

    expect(context.enabled).toBe(true);
    expect(context.startupBranch).toBe("main");
    expect(context.effectiveBaseBranch).toBe("main");
    expect(context.effectiveBaseBranchSource).toBe("current");
    expect(context.expectedWorkBranch).toBe("main");
  });

  it("uses env BASE_BRANCH when provided and records warning if startup branch differs", async () => {
    const repoDir = path.join(tempDir, "repo");
    await initRepo(repoDir);
    await gitMust(repoDir, ["checkout", "-b", "feature/demo"]);

    const context = await resolveBranchRuntimeContext({
      workspaceDir: repoDir,
      envBaseBranch: "main",
      createBranch: true,
    });

    expect(context.enabled).toBe(true);
    expect(context.startupBranch).toBe("feature/demo");
    expect(context.effectiveBaseBranch).toBe("main");
    expect(context.effectiveBaseBranchSource).toBe("env");
    expect(context.warnings.length).toBeGreaterThan(0);
  });

  it("prioritizes CLI base branch over env BASE_BRANCH", async () => {
    const repoDir = path.join(tempDir, "repo");
    await initRepo(repoDir);
    await gitMust(repoDir, ["checkout", "-b", "release/v1"]);
    await writeFile(path.join(repoDir, "release.txt"), "v1\n");
    await gitMust(repoDir, ["add", "release.txt"]);
    await gitMust(repoDir, ["commit", "-m", "add release branch"]);

    const context = await resolveBranchRuntimeContext({
      workspaceDir: repoDir,
      cliBaseBranch: "release/v1",
      envBaseBranch: "main",
      createBranch: true,
    });

    expect(context.enabled).toBe(true);
    expect(context.effectiveBaseBranch).toBe("release/v1");
    expect(context.effectiveBaseBranchSource).toBe("cli");
  });

  it("fails on detached HEAD when BASE_BRANCH is not explicitly set", async () => {
    const repoDir = path.join(tempDir, "repo");
    await initRepo(repoDir);

    const headSha = await gitMust(repoDir, ["rev-parse", "HEAD"]);
    await gitMust(repoDir, ["checkout", "--detach", headSha.trim()]);

    await expect(
      resolveBranchRuntimeContext({
        workspaceDir: repoDir,
        createBranch: true,
      }),
    ).rejects.toThrow(/detached HEAD/i);
  });

  it("blocks create_branch=false on protected branch without explicit override", async () => {
    const repoDir = path.join(tempDir, "repo");
    await initRepo(repoDir);

    await expect(
      resolveBranchRuntimeContext({
        workspaceDir: repoDir,
        createBranch: false,
      }),
    ).rejects.toThrow(/protected/i);
  });

  it("allows protected branch when override is enabled", async () => {
    const repoDir = path.join(tempDir, "repo");
    await initRepo(repoDir);

    const context = await resolveBranchRuntimeContext({
      workspaceDir: repoDir,
      createBranch: false,
      envAllowProtectedBranch: "1",
    });

    expect(context.enabled).toBe(true);
    expect(context.allowProtectedBranch).toBe(true);
  });

  it("disables branch lock outside git repository", async () => {
    const ws = path.join(tempDir, "plain");
    await mkdir(ws, { recursive: true });
    await Bun.write(path.join(ws, "README.md"), "plain workspace\n");

    const context = await resolveBranchRuntimeContext({
      workspaceDir: ws,
      createBranch: false,
    });

    expect(context.enabled).toBe(false);
    expect(context.warnings[0]).toContain("not a git repository");
  });

  it("matches protected branches with exact and glob patterns", () => {
    expect(isBranchProtected("main", ["main"])).toBe(true);
    expect(isBranchProtected("release/v1", ["release/*"])).toBe(true);
    expect(isBranchProtected("feature/x", ["release/*"])).toBe(false);
  });
});

async function initRepo(repoDir: string): Promise<void> {
  await gitMust(tempDir, ["init", "-b", "main", repoDir]);
  await gitMust(repoDir, ["config", "user.name", "Test User"]);
  await gitMust(repoDir, ["config", "user.email", "test@example.com"]);
  await writeFile(path.join(repoDir, "README.md"), "# test\n");
  await gitMust(repoDir, ["add", "README.md"]);
  await gitMust(repoDir, ["commit", "-m", "init"]);
}

async function gitMust(cwd: string, args: string[]): Promise<string> {
  const out = await run(cwd, ["git", ...args]);
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${out.stderr.trim() || out.stdout.trim() || out.code}`,
    );
  }
  return out.stdout;
}

async function run(
  cwd: string,
  command: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}
