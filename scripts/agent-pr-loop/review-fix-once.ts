#!/usr/bin/env bun
// NOTE: Legacy/experimental helper.
// This script spawns worker CLIs directly (not via Core IPC) and is no longer used
// by the supervised demo workflow.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

import { MultiWorkerStepRunner } from "../../src/workflow/multi-worker-step-runner.js";
import type { StepDefinition } from "../../src/workflow/types.js";

async function exists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(p: string): Promise<string> {
  return readFile(p, "utf8");
}

async function nonEmpty(p: string): Promise<boolean> {
  try {
    const t = await readText(p);
    return t.trim().length > 0;
  } catch {
    return false;
  }
}

async function sh(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bash", "-lc", cmd], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function main(): Promise<void> {
  const workspaceDir = process.cwd();
  const loopDir = path.join(workspaceDir, ".agentcore-loop");
  await mkdir(loopDir, { recursive: true });

  const verbose =
    process.env.AGENTCORE_VERBOSE === "1" ||
    process.env.VERBOSE === "1" ||
    process.env.DEBUG === "1";

  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const baseBranchPath = path.join(loopDir, "base-branch.txt");
  const baseBranch = (await exists(baseBranchPath))
    ? (await readFile(baseBranchPath, "utf8")).trim() || "main"
    : "main";

  // Determine BASE_REF.
  await sh(`git fetch origin ${escapeShell(baseBranch)} >/dev/null 2>&1 || true`);
  const hasOrigin = (await sh(`git show-ref --verify --quiet refs/remotes/origin/${escapeShell(baseBranch)}`)).code === 0;
  const hasLocal = (await sh(`git show-ref --verify --quiet refs/heads/${escapeShell(baseBranch)}`)).code === 0;
  const baseRef = hasOrigin ? `origin/${baseBranch}` : hasLocal ? baseBranch : "HEAD";

  const diff = await sh(`git diff --no-color ${escapeShell(baseRef)} || true`);
  const status = await sh("git status --porcelain=v1 || true");
  const untracked = await sh("git ls-files --others --exclude-standard || true");

  await writeFile(path.join(loopDir, "review.diff"), diff.stdout);
  await writeFile(path.join(loopDir, "review.status"), status.stdout);
  await writeFile(path.join(loopDir, "review.untracked"), untracked.stdout);

  await writeFile(path.join(loopDir, "review.verdict"), "FAIL\n");
  await writeFile(path.join(loopDir, "review.md"), "");
  await writeFile(path.join(loopDir, "fix.md"), "");

  const runner = new MultiWorkerStepRunner(verbose);

  const reviewStep: StepDefinition = {
    worker: "OPENCODE",
    model: "openai/gpt-5.2",
    instructions: `You are OpenCode.

Task:
- Review the work against the request.
- Use apply_patch to create/overwrite these files:
  - .agentcore-loop/review.md
  - .agentcore-loop/review.verdict (PASS or FAIL only)
- If verdict is FAIL, also create/overwrite:
  - .agentcore-loop/fix.md (non-empty; concrete, actionable steps; include file paths)

You must read at least:
- .agentcore-loop/request.md
- .agentcore-loop/design.md (if present)
- .agentcore-loop/todo.md (if present)
- .agentcore-loop/review.diff
- .agentcore-loop/review.status
- .agentcore-loop/review.untracked

Format for .agentcore-loop/review.md:
- Sections: Summary, Strengths, Issues, Verification
`,
    capabilities: ["READ", "EDIT"],
    timeout: "15m",
  };

  console.log("[review-fix-once] review: start");

  const reviewResult = await runner.runStep(
    "review",
    reviewStep,
    workspaceDir,
    abort.signal,
  );

  console.log(`[review-fix-once] review: ${reviewResult.status}`);

  if (reviewResult.status !== "SUCCEEDED") {
    throw new Error("review step failed");
  }

  const reviewMdPath = path.join(loopDir, "review.md");
  const verdictPath = path.join(loopDir, "review.verdict");

  // If the reviewer did not actually write the required files, retry once with a minimal prompt.
  if (!(await nonEmpty(reviewMdPath)) || !(await nonEmpty(verdictPath))) {
    const retryStep: StepDefinition = {
      worker: "OPENCODE",
      model: "openai/gpt-5.2",
      instructions: `Use apply_patch to write:
- .agentcore-loop/review.md
- .agentcore-loop/review.verdict (PASS or FAIL)

If verdict is FAIL, also write:
- .agentcore-loop/fix.md (non-empty)

Base your decision on:
- .agentcore-loop/request.md
- .agentcore-loop/artifacts/problem.md
- .agentcore-loop/artifacts/solution.md
`,
      capabilities: ["READ", "EDIT"],
      timeout: "10m",
    };

    const retryResult = await runner.runStep(
      "review_retry_write_files",
      retryStep,
      workspaceDir,
      abort.signal,
    );
    if (retryResult.status !== "SUCCEEDED") {
      throw new Error("review step did not write required files");
    }
  }

  const verdictRaw = await readText(verdictPath);
  const verdict = verdictRaw.trim().toUpperCase();

  console.log(`[review-fix-once] verdict: ${verdict || "(missing)"}`);
  if (verdict === "PASS") {
    return;
  }

  const fixPath = path.join(loopDir, "fix.md");
  const fixBytes = (await readText(fixPath)).trim().length;

  // Guardrail: if the reviewer returned FAIL without actionable fix instructions,
  // ask once more for fix.md instead of failing the whole workflow.
  if (fixBytes === 0) {
    const fixOnlyStep: StepDefinition = {
      worker: "OPENCODE",
      model: "openai/gpt-5.2",
      instructions: `You are OpenCode.

The previous review produced verdict FAIL but did not provide fix instructions.

Task:
- Write .agentcore-loop/fix.md with concrete, actionable instructions to make the implementation pass.

Read:
- .agentcore-loop/request.md
- .agentcore-loop/design.md
- .agentcore-loop/todo.md
- .agentcore-loop/review.diff
- .agentcore-loop/review.status
- .agentcore-loop/review.untracked

Write:
- .agentcore-loop/fix.md

Rules:
- Include file paths.
- Keep it minimal and unambiguous.
`,
      capabilities: ["READ", "EDIT"],
      timeout: "10m",
    };

    const fixOnlyResult = await runner.runStep(
      "review_fix_missing_fix_md",
      fixOnlyStep,
      workspaceDir,
      abort.signal,
    );

    if (fixOnlyResult.status !== "SUCCEEDED") {
      throw new Error("verdict was FAIL and fix.md is missing; fix-only step failed");
    }
  }

  const fixBytes2 = (await readText(fixPath)).trim().length;
  if (fixBytes2 === 0) {
    throw new Error("verdict was FAIL but .agentcore-loop/fix.md is still empty");
  }

  const fixStep: StepDefinition = {
    worker: "CODEX_CLI",
    model: "gpt-5.3-codex",
    instructions: `You are Codex CLI.

Task: Apply the requested fixes.

Read:
- .agentcore-loop/fix.md
- .agentcore-loop/todo.md

Do:
- Make the minimal changes required to address the issues.
- Run tests (use bun test if this is a Bun repo; otherwise pick the most appropriate command).
- Do not introduce unrelated refactors.
`,
    capabilities: ["READ", "EDIT", "RUN_TESTS", "RUN_COMMANDS"],
    timeout: "20m",
  };

  console.log("[review-fix-once] fix: start");

  const fixResult = await runner.runStep(
    "fix",
    fixStep,
    workspaceDir,
    abort.signal,
  );

  console.log(`[review-fix-once] fix: ${fixResult.status}`);

  if (fixResult.status !== "SUCCEEDED") {
    const obs = (fixResult.observations ?? [])
      .map((o) => (o.summary ? o.summary.trim() : ""))
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (obs) {
      await writeFile(path.join(loopDir, "fix.last-output.txt"), obs + "\n");
      console.log("[review-fix-once] fix: wrote .agentcore-loop/fix.last-output.txt");
    }
    throw new Error("fix step failed");
  }
}

function escapeShell(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

if (import.meta.main) {
  main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[review-fix-once] ${msg}\n`);
    process.exit(1);
  });
}
