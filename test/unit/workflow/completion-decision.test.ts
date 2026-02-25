import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveCompletionDecision } from "../../../src/workflow/completion-decision.js";
import type { CompletionCheckDef } from "../../../src/workflow/types.js";

let lastTmpDir: string | null = null;

afterEach(async () => {
  if (!lastTmpDir) return;
  await rm(lastTmpDir, { recursive: true, force: true });
  lastTmpDir = null;
});

function makeCheck(decisionFile: string): CompletionCheckDef {
  return {
    worker: "OPENCODE",
    model: "openai/gpt-5.2",
    instructions: "Write a decision_file",
    capabilities: ["READ"],
    decision_file: decisionFile,
  } as unknown as CompletionCheckDef;
}

function makeCheckNoFile(): CompletionCheckDef {
  return {
    worker: "OPENCODE",
    model: "openai/gpt-5.2",
    instructions: "Output a completion decision",
    capabilities: ["READ"],
  } as unknown as CompletionCheckDef;
}

describe("resolveCompletionDecision (decision_file JSON)", () => {
  test("fails when decision_file is missing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roboppi-decision-"));
    lastTmpDir = dir;

    const check = makeCheck("decision.json");
    const res = await resolveCompletionDecision(check, dir, Date.now(), "check-1");
    expect(res.decision).toBe("fail");
    expect(res.source).toBe("none");
    expect(res.reason).toBe("decision_file missing");
  });

  test("reads decision=complete with matching check_id", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roboppi-decision-"));
    lastTmpDir = dir;

    const check = makeCheck("decision.json");
    const checkId = "check-123";
    const startedAt = Date.now();
    await writeFile(
      path.join(dir, "decision.json"),
      JSON.stringify({ decision: "complete", check_id: checkId, reasons: ["ok"], fingerprints: ["t:1"] }),
      "utf-8",
    );

    const res = await resolveCompletionDecision(check, dir, startedAt, checkId);
    expect(res.decision).toBe("complete");
    expect(res.source).toBe("file-json");
    expect(res.checkIdMatch).toBe(true);
    expect(res.reasons).toEqual(["ok"]);
    expect(res.fingerprints).toEqual(["t:1"]);
  });

  test("fails when check_id mismatches", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roboppi-decision-"));
    lastTmpDir = dir;

    const check = makeCheck("decision.json");
    const startedAt = Date.now();
    await writeFile(
      path.join(dir, "decision.json"),
      JSON.stringify({ decision: "complete", check_id: "wrong" }),
      "utf-8",
    );

    const res = await resolveCompletionDecision(check, dir, startedAt, "expected");
    expect(res.decision).toBe("fail");
    expect(res.source).toBe("file-json");
    expect(res.checkIdMatch).toBe(false);
    expect(res.reason).toContain("check_id mismatch");
  });
});

describe("resolveCompletionDecision (decision_file text)", () => {
  test("reads FAIL as incomplete", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roboppi-decision-"));
    lastTmpDir = dir;

    const check = makeCheck("verdict.txt");
    const startedAt = Date.now();
    await writeFile(path.join(dir, "verdict.txt"), "FAIL\n", "utf-8");

    const res = await resolveCompletionDecision(check, dir, startedAt, "check-1");
    expect(res.decision).toBe("incomplete");
    expect(res.source).toBe("file-text");
  });

  test("reads COMPLETE as complete", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roboppi-decision-"));
    lastTmpDir = dir;

    const check = makeCheck("verdict.txt");
    const startedAt = Date.now();
    await writeFile(path.join(dir, "verdict.txt"), "COMPLETE\n", "utf-8");

    const res = await resolveCompletionDecision(check, dir, startedAt, "check-1");
    expect(res.decision).toBe("complete");
    expect(res.source).toBe("file-text");
  });
});

describe("resolveCompletionDecision (worker output fallback)", () => {
  test("uses stdout marker when no decision_file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roboppi-decision-"));
    lastTmpDir = dir;

    const check = makeCheckNoFile();
    const startedAt = Date.now();

    const res = await resolveCompletionDecision(
      check,
      dir,
      startedAt,
      "check-xyz",
      "some text\nINCOMPLETE\nmore text\n",
    );
    expect(res.decision).toBe("incomplete");
    expect(res.source).toBe("marker");
  });

  test("parses structured JSON from stdout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "roboppi-decision-"));
    lastTmpDir = dir;

    const check = makeCheckNoFile();
    const startedAt = Date.now();
    const checkId = "check-999";

    const res = await resolveCompletionDecision(
      check,
      dir,
      startedAt,
      checkId,
      [
        "noise",
        JSON.stringify({ decision: "incomplete", check_id: checkId, reasons: ["r1"], fingerprints: ["fp1"] }),
      ].join("\n"),
    );
    expect(res.decision).toBe("incomplete");
    expect(res.source).toBe("stdout-json");
    expect(res.checkIdMatch).toBe(true);
    expect(res.reasons).toEqual(["r1"]);
    expect(res.fingerprints).toEqual(["fp1"]);
  });
});
