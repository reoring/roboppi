declare module "@mariozechner/pi-coding-agent" {
  export function createAgentSession(opts: Record<string, unknown>): Promise<{
    session: {
      prompt(text: string, opts?: Record<string, unknown>): Promise<void>;
      subscribe(listener: (event: unknown) => void): () => void;
      dispose(): void;
      abort(): Promise<void>;
    };
  }>;
  export const SessionManager: {
    inMemory(): unknown;
  };
  export function createCodingTools(cwd: string): unknown[];
  export function createReadOnlyTools(cwd: string): unknown[];
  export function createBashTool(cwd: string): unknown;
  export function createReadTool(cwd: string): unknown;
  export function createGrepTool(cwd: string): unknown;
  export function createFindTool(cwd: string): unknown;
  export function createLsTool(cwd: string): unknown;
}
