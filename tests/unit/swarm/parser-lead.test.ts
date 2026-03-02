/**
 * Swarm parser validation — lead semantics tests.
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

function makeYaml(swarm: Record<string, unknown>): string {
  return YAML.stringify({
    name: "test-wf",
    version: "1",
    timeout: "10m",
    swarm,
    steps: {
      step1: {
        worker: "CUSTOM",
        instructions: "do something",
        capabilities: ["READ"],
      },
    },
  });
}

describe("swarm parser validation", () => {
  it("rejects enabled swarm with missing members", () => {
    expect(() =>
      parseWorkflow(
        makeYaml({
          enabled: true,
          team_name: "my-team",
        }),
      ),
    ).toThrow(/members.*required/i);
  });

  it("rejects enabled swarm with empty members", () => {
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

  it("rejects enabled swarm with missing team_name", () => {
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

  it("accepts swarm with explicit 'lead' member (no fallback)", () => {
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

    expect(def.swarm).toBeTruthy();
    expect(def.swarm!.enabled).toBe(true);
    expect(def.swarm!.members).toBeTruthy();
    // No _lead_fallback when "lead" key is present
    expect((def.swarm as any)._lead_fallback).toBeUndefined();
  });

  it("accepts swarm without 'lead' key and sets _lead_fallback to first member", () => {
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

    expect(def.swarm).toBeTruthy();
    // The parser should set _lead_fallback to first key
    expect((def.swarm as any)._lead_fallback).toBe("alice");
  });

  it("allows disabled swarm without members", () => {
    const def = parseWorkflow(
      makeYaml({
        enabled: false,
        team_name: "my-team",
      }),
    );

    expect(def.swarm).toBeTruthy();
    expect(def.swarm!.enabled).toBe(false);
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
