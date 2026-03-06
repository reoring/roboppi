/**
 * Agents parser validation — lead semantics tests.
 *
 * Covers:
 * - Empty members -> error
 * - Missing "lead" key -> deterministic fallback (first member, _lead_fallback set)
 * - Explicit "lead" key -> no fallback
 * - Consistent error messaging
 */
import { describe, it, expect } from "bun:test";
import { parseWorkflow } from "../../../src/workflow/parser.js";
import YAML from "yaml";

function makeYaml(agents: Record<string, unknown>): string {
  return YAML.stringify({
    name: "test-wf",
    version: "1",
    timeout: "10m",
    agents,
    steps: {
      step1: {
        worker: "CUSTOM",
        instructions: "do something",
        capabilities: ["READ"],
      },
    },
  });
}

describe("agents parser validation", () => {
  it("rejects enabled agents with missing members", () => {
    expect(() =>
      parseWorkflow(
        makeYaml({
          enabled: true,
          team_name: "my-team",
        }),
      ),
    ).toThrow(/members.*required/i);
  });

  it("rejects enabled agents with empty members", () => {
    expect(() =>
      parseWorkflow(
        makeYaml({
          enabled: true,
          team_name: "my-team",
          members: {},
        }),
      ),
    ).toThrow(/non-empty/i);
  });

  it("rejects enabled agents with missing team_name", () => {
    expect(() =>
      parseWorkflow(
        makeYaml({
          enabled: true,
          members: {
            lead: { agent: "default" },
          },
        }),
      ),
    ).toThrow(/team_name.*required/i);
  });

  it("accepts agents with explicit 'lead' member (no fallback)", () => {
    const def = parseWorkflow(
      makeYaml({
        enabled: true,
        team_name: "my-team",
        members: {
          lead: { agent: "leader" },
          researcher: { agent: "research" },
        },
      }),
    );

    expect(def.agents).toBeTruthy();
    expect(def.agents!.enabled).toBe(true);
    expect(def.agents!.members).toBeTruthy();
    // No _lead_fallback when "lead" key is present
    expect((def.agents as any)._lead_fallback).toBeUndefined();
  });

  it("accepts agents without 'lead' key and sets _lead_fallback to first member", () => {
    const def = parseWorkflow(
      makeYaml({
        enabled: true,
        team_name: "my-team",
        members: {
          alice: { agent: "researcher" },
          bob: { agent: "reviewer" },
        },
      }),
    );

    expect(def.agents).toBeTruthy();
    // The parser should set _lead_fallback to first key
    expect((def.agents as any)._lead_fallback).toBe("alice");
  });

  it("allows disabled agents without members", () => {
    const def = parseWorkflow(
      makeYaml({
        enabled: false,
        team_name: "my-team",
      }),
    );

    expect(def.agents).toBeTruthy();
    expect(def.agents!.enabled).toBe(false);
  });

  it("validates member agent field is present and string", () => {
    expect(() =>
      parseWorkflow(
        makeYaml({
          enabled: true,
          team_name: "my-team",
          members: {
            lead: { agent: 123 },
          },
        }),
      ),
    ).toThrow(/agent/i);
  });

  it("validates task assigned_to references valid member", () => {
    expect(() =>
      parseWorkflow(
        makeYaml({
          enabled: true,
          team_name: "my-team",
          members: {
            lead: { agent: "leader" },
          },
          tasks: [
            {
              title: "Task 1",
              description: "desc",
              assigned_to: "nonexistent",
            },
          ],
        }),
      ),
    ).toThrow(/unknown member/i);
  });
});
