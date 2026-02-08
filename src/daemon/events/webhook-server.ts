import type { Server } from "bun";

export type RouteHandler = (req: Request) => Promise<Response>;

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

export class WebhookServer {
  private routes = new Map<string, RouteHandler>();
  private server: Server<undefined> | null = null;

  registerRoute(path: string, handler: RouteHandler): void {
    this.routes.set(path, handler);
  }

  unregisterRoute(path: string): void {
    this.routes.delete(path);
  }

  start(port: number): void {
    this.server = Bun.serve({
      port,
      fetch: async (req) => {
        // Enforce request body size limit to prevent DoS
        const contentLength = req.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
          return new Response("Payload Too Large", { status: 413 });
        }

        const url = new URL(req.url);
        const handler = this.routes.get(url.pathname);
        if (!handler) {
          return new Response("Not Found", { status: 404 });
        }
        return handler(req);
      },
    });
  }

  stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
  }

  get port(): number | null {
    return this.server?.port ?? null;
  }
}
