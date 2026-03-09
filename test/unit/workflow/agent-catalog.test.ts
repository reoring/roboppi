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

  it("parses resident worker defaultArgs", () => {
    const yaml = `
version: "1"
agents:
  verifier:
    worker: CODEX_CLI
    defaultArgs:
      - --full-auto
      - --sandbox
      - danger-full-access
`;

    const catalog = parseAgentCatalog(yaml);
    expect(catalog.verifier).toBeDefined();
    expect(catalog.verifier!.defaultArgs).toEqual([
      "--full-auto",
      "--sandbox",
      "danger-full-access",
    ]);
  });

  it("parses optional claude MCP settings", () => {
    const yaml = `
version: "1"
agents:
  planner:
    worker: CLAUDE_CODE
    mcp_configs:
      - tools/apthctl-loop-mcp.claude.json
    strict_mcp_config: true
`;

    const catalog = parseAgentCatalog(yaml);
    expect(catalog.planner).toBeDefined();
    expect(catalog.planner!.mcp_configs).toEqual([
      "tools/apthctl-loop-mcp.claude.json",
    ]);
    expect(catalog.planner!.strict_mcp_config).toBe(true);
  });

  it("parses generic MCP server definitions", () => {
    const yaml = `
version: "1"
agents:
  verifier:
    worker: CODEX_CLI
    mcp_servers:
      - name: apthctl_loop
        command: bun
        args: [run, tools/apthctl-loop-mcp.ts]
        env:
          LOOP_MODE: test
      - name: remote_docs
        url: https://example.test/mcp
        bearer_token_env_var: TEST_TOKEN
        enabled: false
`;

    const catalog = parseAgentCatalog(yaml);
    expect(catalog.verifier).toBeDefined();
    expect(catalog.verifier!.mcp_servers).toEqual([
      {
        name: "apthctl_loop",
        command: "bun",
        args: ["run", "tools/apthctl-loop-mcp.ts"],
        env: { LOOP_MODE: "test" },
      },
      {
        name: "remote_docs",
        url: "https://example.test/mcp",
        bearer_token_env_var: "TEST_TOKEN",
        enabled: false,
      },
    ]);
  });

  it("rejects wrong version", () => {
    const yaml = `
version: "2"
agents: {}
`;
    expect(() => parseAgentCatalog(yaml)).toThrow(AgentCatalogParseError);
  });

  it("rejects invalid MCP server definitions", () => {
    const yaml = `
version: "1"
agents:
  verifier:
    worker: CODEX_CLI
    mcp_servers:
      - name: bad.name
        command: bun
        url: https://example.test/mcp
`;
    expect(() => parseAgentCatalog(yaml)).toThrow(AgentCatalogParseError);
  });
});
