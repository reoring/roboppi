import { describe, it, expect } from "bun:test";

import { parseAgentCatalog, AgentCatalogParseError } from "../../../src/workflow/agent-catalog.js";

describe("parseAgentCatalog", () => {
  it("parses a minimal catalog", () => {
    const yaml = `
version: "1"
agents:
  research:
    worker: OPENCODE
    model: openai/gpt-5.2
    capabilities: [READ]
    base_instructions: "You are a research agent"
`;

    const catalog = parseAgentCatalog(yaml);
    expect(catalog.research).toBeDefined();
    expect(catalog.research!.worker).toBe("OPENCODE");
    expect(catalog.research!.model).toBe("openai/gpt-5.2");
    expect(catalog.research!.capabilities).toEqual(["READ"]);
    expect(catalog.research!.base_instructions).toBe("You are a research agent");
  });

  it("rejects wrong version", () => {
    const yaml = `
version: "2"
agents: {}
`;
    expect(() => parseAgentCatalog(yaml)).toThrow(AgentCatalogParseError);
  });
});
