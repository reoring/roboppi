import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveLandingDecision } from "../../../src/task-orchestrator/index.js";

describe("resolveLandingDecision", () => {
  let contextDir: string;

  beforeEach(async () => {
    contextDir = await mkdtemp(path.join(tmpdir(), "roboppi-task-landing-"));
    await mkdir(path.join(contextDir, "_task"), { recursive: true });
  });

  afterEach(async () => {
    await rm(contextDir, { recursive: true, force: true });
  });

  it("uses workflow landing directive when landing.mode=manual", async () => {
    await writeFile(
      path.join(contextDir, "_task", "landing.json"),
      JSON.stringify({
        version: "1",
        lifecycle: "ready_to_land",
        rationale: "PR opened and awaiting maintainer merge",
        metadata: {
          pr_number: 42,
        },
      }),
    );

    const decision = await resolveLandingDecision({
      contextDir,
      landing: { mode: "manual" },
      defaultLifecycle: "review_required",
      defaultRationale: "Workflow succeeded; awaiting review.",
      allowWorkflowDirective: true,
    });

    expect(decision).toEqual({
      version: "1",
      lifecycle: "ready_to_land",
      rationale: "PR opened and awaiting maintainer merge",
      metadata: {
        landing_file: path.join(contextDir, "_task", "landing.json"),
        pr_number: 42,
      },
      source: "workflow",
    });
  });

  it("ignores workflow landing directive when landing.mode=disabled", async () => {
    await writeFile(
      path.join(contextDir, "_task", "landing.json"),
      JSON.stringify({
        version: "1",
        lifecycle: "ready_to_land",
      }),
    );

    const decision = await resolveLandingDecision({
      contextDir,
      landing: { mode: "disabled" },
      defaultLifecycle: "review_required",
      defaultRationale: "Workflow succeeded; awaiting review.",
      allowWorkflowDirective: true,
    });

    expect(decision).toEqual({
      version: "1",
      lifecycle: "review_required",
      rationale: "Ignored workflow landing directive because landing.mode=disabled.",
      metadata: {
        landing_file: path.join(contextDir, "_task", "landing.json"),
        requested_lifecycle: "ready_to_land",
        requested_metadata: undefined,
      },
      source: "ignored",
    });
  });

  it("falls back to the default lifecycle when landing.json is invalid", async () => {
    await writeFile(
      path.join(contextDir, "_task", "landing.json"),
      "{not-valid-json",
    );

    const decision = await resolveLandingDecision({
      contextDir,
      landing: { mode: "manual" },
      defaultLifecycle: "review_required",
      defaultRationale: "Workflow succeeded; awaiting review.",
      allowWorkflowDirective: true,
    });

    expect(decision.source).toBe("invalid");
    expect(decision.lifecycle).toBe("review_required");
    expect(decision.rationale).toContain("Ignored invalid landing directive");
    expect(decision.metadata).toEqual({
      landing_file: path.join(contextDir, "_task", "landing.json"),
    });
  });
});
