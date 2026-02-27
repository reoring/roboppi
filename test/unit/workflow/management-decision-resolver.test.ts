import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveManagementDecision } from "../../../src/workflow/management/decision-resolver.js";

let tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "roboppi-mgmt-decision-"));
  tmpDirs.push(dir);
  return dir;
}

describe("resolveManagementDecision", () => {
  test("TC-MA-D-01: hook_id match accepts the decision", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "decision.json");
    await writeFile(
      filePath,
      JSON.stringify({
        hook_id: "A",
        hook: "pre_step",
        step_id: "s1",
        directive: { action: "proceed" },
      }),
      "utf-8",
    );

    const res = await resolveManagementDecision(
      filePath,
      "A",
      "pre_step",
      "s1",
      Date.now(),
    );

    expect(res.hookIdMatch).toBe(true);
    expect(res.directive).toEqual({ action: "proceed" });
    expect(res.source).toBe("file-json");
  });

  test("TC-MA-D-02: hook_id mismatch is stale -> reject -> proceed fallback", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "decision.json");
    await writeFile(
      filePath,
      JSON.stringify({
        hook_id: "B",
        hook: "pre_step",
        step_id: "s1",
        directive: { action: "skip", reason: "not needed" },
      }),
      "utf-8",
    );

    const res = await resolveManagementDecision(
      filePath,
      "A",
      "pre_step",
      "s1",
      Date.now(),
    );

    expect(res.hookIdMatch).toBe(false);
    expect(res.directive).toEqual({ action: "proceed" });
    expect(res.reason).toBeDefined();
    expect(
      res.reason!.toLowerCase().includes("stale") ||
        res.reason!.toLowerCase().includes("mismatch"),
    ).toBe(true);
  });

  test("TC-MA-D-03: hook_id absent + old mtime -> stale", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "decision.json");
    const hookStartedAt = Date.now();

    await writeFile(
      filePath,
      JSON.stringify({
        hook: "pre_step",
        step_id: "s1",
        directive: { action: "proceed" },
      }),
      "utf-8",
    );

    // Set file mtime to 5 seconds before hook started
    const oldTime = new Date(hookStartedAt - 5000);
    await utimes(filePath, oldTime, oldTime);

    const res = await resolveManagementDecision(
      filePath,
      "hook-123",
      "pre_step",
      "s1",
      hookStartedAt,
    );

    expect(res.directive).toEqual({ action: "proceed" });
    expect(res.reason).toBeDefined();
    expect(res.reason!.toLowerCase()).toContain("stale");
  });

  test("TC-MA-D-04: hook_id absent + recent mtime (within 2s grace) -> accept", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "decision.json");
    const hookStartedAt = Date.now() - 500;

    await writeFile(
      filePath,
      JSON.stringify({
        hook: "pre_step",
        step_id: "s1",
        directive: { action: "skip", reason: "not needed" },
      }),
      "utf-8",
    );

    const res = await resolveManagementDecision(
      filePath,
      "hook-456",
      "pre_step",
      "s1",
      hookStartedAt,
    );

    expect(res.hookIdMatch).toBeUndefined();
    expect(res.directive).toEqual({ action: "skip", reason: "not needed" });
    expect(res.source).toBe("file-json");
  });

  test("TC-MA-D-05: invalid JSON -> reject -> proceed", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "decision.json");
    await writeFile(filePath, "not json {{{", "utf-8");

    const res = await resolveManagementDecision(
      filePath,
      "hook-1",
      "pre_step",
      "s1",
      Date.now(),
    );

    expect(res.directive).toEqual({ action: "proceed" });
    expect(res.reason).toBeDefined();
    expect(
      res.reason!.toLowerCase().includes("json") ||
        res.reason!.toLowerCase().includes("parse"),
    ).toBe(true);
  });

  test("TC-MA-D-06: unknown action -> reject -> proceed", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "decision.json");
    await writeFile(
      filePath,
      JSON.stringify({
        hook_id: "A",
        hook: "pre_step",
        step_id: "s1",
        directive: { action: "explode" },
      }),
      "utf-8",
    );

    const res = await resolveManagementDecision(
      filePath,
      "A",
      "pre_step",
      "s1",
      Date.now(),
    );

    expect(res.directive).toEqual({ action: "proceed" });
    expect(res.reason).toBeDefined();
    expect(
      res.reason!.toLowerCase().includes("unknown") ||
        res.reason!.toLowerCase().includes("action"),
    ).toBe(true);
  });

  test("TC-MA-D-07: string field exceeds 4096 limit -> reject -> proceed", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "decision.json");
    await writeFile(
      filePath,
      JSON.stringify({
        hook_id: "A",
        hook: "pre_step",
        step_id: "s1",
        directive: { action: "annotate", message: "x".repeat(5000) },
      }),
      "utf-8",
    );

    const res = await resolveManagementDecision(
      filePath,
      "A",
      "pre_step",
      "s1",
      Date.now(),
    );

    expect(res.directive).toEqual({ action: "proceed" });
    expect(res.reason).toBeDefined();
    expect(
      res.reason!.toLowerCase().includes("length") ||
        res.reason!.toLowerCase().includes("4096"),
    ).toBe(true);
  });

  test("TC-MA-D-08: hook/step_id mismatch -> reject -> proceed (misattribution)", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "decision.json");
    await writeFile(
      filePath,
      JSON.stringify({
        hook_id: "A",
        hook: "post_step",
        step_id: "s2",
        directive: { action: "proceed" },
      }),
      "utf-8",
    );

    const res = await resolveManagementDecision(
      filePath,
      "A",
      "pre_step",
      "s1",
      Date.now(),
    );

    expect(res.directive).toEqual({ action: "proceed" });
    expect(res.reason).toBeDefined();
    expect(
      res.reason!.toLowerCase().includes("mismatch") ||
        res.reason!.toLowerCase().includes("misattribution"),
    ).toBe(true);
  });

  test("TC-MA-D-09: decision file missing -> source=none -> proceed", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "nonexistent-decision.json");

    const res = await resolveManagementDecision(
      filePath,
      "hook-1",
      "pre_step",
      "s1",
      Date.now(),
    );

    expect(res.source).toBe("none");
    expect(res.directive).toEqual({ action: "proceed" });
    expect(res.reason).toBeDefined();
    expect(
      res.reason!.toLowerCase().includes("missing") ||
        res.reason!.toLowerCase().includes("not found"),
    ).toBe(true);
  });

  test("TC-MA-D-10: required field missing per action type -> reject -> proceed", async () => {
    const dir = await makeTmpDir();
    const filePath = path.join(dir, "decision.json");
    // action: "skip" requires "reason" field
    await writeFile(
      filePath,
      JSON.stringify({
        hook_id: "A",
        hook: "pre_step",
        step_id: "s1",
        directive: { action: "skip" },
      }),
      "utf-8",
    );

    const res = await resolveManagementDecision(
      filePath,
      "A",
      "pre_step",
      "s1",
      Date.now(),
    );

    expect(res.directive).toEqual({ action: "proceed" });
    expect(res.reason).toBeDefined();
    expect(
      res.reason!.toLowerCase().includes("required") ||
        res.reason!.toLowerCase().includes("reason"),
    ).toBe(true);
  });
});
