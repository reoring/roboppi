import { createHmac, timingSafeEqual } from "node:crypto";
import type { DaemonEvent, WebhookEventDef } from "../types.js";
import type { EventSource } from "./event-source.js";
import type { WebhookServer } from "./webhook-server.js";

export class WebhookSource implements EventSource {
  readonly id: string;
  private readonly config: WebhookEventDef;
  private readonly server: WebhookServer;
  private readonly method: string;
  private readonly secret: string | undefined;
  private abortController = new AbortController();
  private buffer: DaemonEvent[] = [];
  private resolve: (() => void) | null = null;

  constructor(id: string, config: WebhookEventDef, server: WebhookServer) {
    this.id = id;
    this.config = config;
    this.server = server;
    this.method = (config.method ?? "POST").toUpperCase();
    this.secret = this.resolveSecret(config.secret);

    this.server.registerRoute(config.path, (req) => this.handleRequest(req));
  }

  async *events(): AsyncGenerator<DaemonEvent> {
    const signal = this.abortController.signal;

    while (!signal.aborted) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }

      const aborted = await new Promise<boolean>((res) => {
        if (signal.aborted) {
          res(true);
          return;
        }
        const onAbort = () => {
          res(true);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.resolve = () => {
          signal.removeEventListener("abort", onAbort);
          res(false);
        };
      });

      if (aborted) break;
    }
  }

  async stop(): Promise<void> {
    this.abortController.abort();
    this.server.unregisterRoute(this.config.path);
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  private resolveSecret(secret: string | undefined): string | undefined {
    if (secret === undefined) return undefined;
    const match = /^\$\{(.+)\}$/.exec(secret);
    if (match) {
      const value = process.env[match[1]!];
      if (!value) {
        throw new Error(
          `Webhook secret env var \${${match[1]!}} is not set or empty — refusing to start with an empty secret`,
        );
      }
      return value;
    }
    if (secret === "") {
      throw new Error("Webhook secret must not be empty");
    }
    return secret;
  }

  private async handleRequest(req: Request): Promise<Response> {
    if (req.method !== this.method) {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const rawBody = await req.text();

    // Enforce body size limit (Content-Length can be spoofed, so check actual body)
    if (rawBody.length > 1024 * 1024) {
      return new Response("Payload Too Large", { status: 413 });
    }

    if (this.secret) {
      const sigHeader = req.headers.get("x-hub-signature-256");
      if (!sigHeader) {
        return new Response("Unauthorized", { status: 401 });
      }

      const hmac = createHmac("sha256", this.secret);
      hmac.update(rawBody);
      const expected = `sha256=${hmac.digest("hex")}`;

      const sigBuf = Buffer.from(sigHeader);
      const expectedBuf = Buffer.from(expected);

      if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody;
    }

    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const url = new URL(req.url);

    const event: DaemonEvent = {
      sourceId: this.id,
      timestamp: Date.now(),
      payload: {
        type: "webhook",
        method: req.method,
        path: url.pathname,
        headers,
        body,
      },
    };

    this.buffer.push(event);
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r();
    }

    return new Response("OK", { status: 200 });
  }
}
