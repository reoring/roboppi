export interface McpServerConfig {
  /** Stable server name used by worker-specific config formats. */
  name: string;

  /** Local stdio command. Mutually exclusive with `url`. */
  command?: string;

  /** Optional stdio command arguments. */
  args?: string[];

  /** Optional stdio environment variables. */
  env?: Record<string, string>;

  /** Optional remote MCP endpoint. Mutually exclusive with `command`. */
  url?: string;

  /** Optional bearer token env var for remote servers. */
  bearer_token_env_var?: string;

  /** Defaults to true when omitted. */
  enabled?: boolean;
}
