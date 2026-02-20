import { describe, it, expect } from "bun:test";
import { isWorkerTaskJobPayload } from "../../../src/types/worker-task-job-payload.js";

function validPayload() {
  return {
    workerTaskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    workerKind: "CLAUDE_CODE",
    workspaceRef: "/workspace",
    instructions: "do something",
    capabilities: ["READ", "EDIT"],
    outputMode: "BATCH",
    budget: {
      deadlineAt: Date.now() + 60_000,
    },
  };
}

describe("isWorkerTaskJobPayload", () => {
  // ── valid payloads ──────────────────────────────────────────────

  it("returns true for a valid minimal payload", () => {
    expect(isWorkerTaskJobPayload(validPayload())).toBe(true);
  });

  it("returns true when all optional fields are present", () => {
    const p = {
      ...validPayload(),
      model: "claude-sonnet-4-6",
      env: { FOO: "bar", BAZ: "qux" },
      budget: {
        deadlineAt: Date.now() + 60_000,
        maxSteps: 100,
        maxCommandTimeMs: 30_000,
      },
    };
    expect(isWorkerTaskJobPayload(p)).toBe(true);
  });

  it("accepts all valid workerKind values", () => {
    for (const kind of ["CODEX_CLI", "CLAUDE_CODE", "OPENCODE", "CUSTOM"]) {
      expect(isWorkerTaskJobPayload({ ...validPayload(), workerKind: kind })).toBe(true);
    }
  });

  it("accepts all valid capability values", () => {
    for (const cap of ["READ", "EDIT", "RUN_TESTS", "RUN_COMMANDS"]) {
      expect(isWorkerTaskJobPayload({ ...validPayload(), capabilities: [cap] })).toBe(true);
    }
  });

  it("accepts both BATCH and STREAM outputMode", () => {
    expect(isWorkerTaskJobPayload({ ...validPayload(), outputMode: "BATCH" })).toBe(true);
    expect(isWorkerTaskJobPayload({ ...validPayload(), outputMode: "STREAM" })).toBe(true);
  });

  // ── missing required fields ─────────────────────────────────────

  it("returns false for null / undefined / non-object", () => {
    expect(isWorkerTaskJobPayload(null)).toBe(false);
    expect(isWorkerTaskJobPayload(undefined)).toBe(false);
    expect(isWorkerTaskJobPayload("string")).toBe(false);
    expect(isWorkerTaskJobPayload(42)).toBe(false);
  });

  for (const field of [
    "workerTaskId",
    "workerKind",
    "workspaceRef",
    "instructions",
    "capabilities",
    "outputMode",
    "budget",
  ] as const) {
    it(`returns false when ${field} is missing`, () => {
      const { [field]: _, ...rest } = validPayload();
      expect(isWorkerTaskJobPayload(rest)).toBe(false);
    });
  }

  // ── enum validation ─────────────────────────────────────────────

  it("returns false for unknown workerKind", () => {
    expect(isWorkerTaskJobPayload({ ...validPayload(), workerKind: "UNKNOWN" })).toBe(false);
  });

  it("returns false for unknown outputMode", () => {
    expect(isWorkerTaskJobPayload({ ...validPayload(), outputMode: "INVALID" })).toBe(false);
  });

  it("returns false when capabilities contain an unknown value", () => {
    expect(isWorkerTaskJobPayload({ ...validPayload(), capabilities: ["READ", "FLY"] })).toBe(false);
  });

  it("returns false when capabilities contain a non-string element", () => {
    expect(isWorkerTaskJobPayload({ ...validPayload(), capabilities: ["READ", 42] })).toBe(false);
  });

  // ── budget validation ───────────────────────────────────────────

  it("returns false when budget.deadlineAt is missing", () => {
    expect(isWorkerTaskJobPayload({ ...validPayload(), budget: {} })).toBe(false);
  });

  it("returns false when budget.deadlineAt is NaN", () => {
    expect(isWorkerTaskJobPayload({ ...validPayload(), budget: { deadlineAt: NaN } })).toBe(false);
  });

  it("returns false when budget.deadlineAt is Infinity", () => {
    expect(isWorkerTaskJobPayload({ ...validPayload(), budget: { deadlineAt: Infinity } })).toBe(false);
  });

  it("returns false when budget.maxSteps is not a finite number", () => {
    const p = { ...validPayload(), budget: { deadlineAt: Date.now() + 1000, maxSteps: NaN } };
    expect(isWorkerTaskJobPayload(p)).toBe(false);
  });

  it("returns false when budget.maxCommandTimeMs is Infinity", () => {
    const p = { ...validPayload(), budget: { deadlineAt: Date.now() + 1000, maxCommandTimeMs: Infinity } };
    expect(isWorkerTaskJobPayload(p)).toBe(false);
  });

  // ── env validation ──────────────────────────────────────────────

  it("returns false when env value is not a string", () => {
    expect(isWorkerTaskJobPayload({ ...validPayload(), env: { OK: "yes", BAD: 123 } })).toBe(false);
  });

  it("returns false when env is an array", () => {
    expect(isWorkerTaskJobPayload({ ...validPayload(), env: ["a"] })).toBe(false);
  });

  it("returns false when env is null", () => {
    expect(isWorkerTaskJobPayload({ ...validPayload(), env: null })).toBe(false);
  });
});
