import { describe, test, expect, afterEach } from "bun:test";
import { createHmac } from "node:crypto";
import { WebhookServer } from "../../../src/daemon/events/webhook-server.js";
import { WebhookSource } from "../../../src/daemon/events/webhook-source.js";
import type { DaemonEvent, WebhookEventDef, WebhookPayload } from "../../../src/daemon/types.js";

function startServerOnEphemeralPort(server: WebhookServer): number {
  server.start(0);
  const port = server.port;
  if (!port) throw new Error("WebhookServer did not expose a port after start()");
  return port;
}

describe("WebhookServer", () => {
  let server: WebhookServer;

  afterEach(() => {
    server?.stop();
  });

  test("returns 404 for unknown path", async () => {
    server = new WebhookServer();
    const port = startServerOnEphemeralPort(server);

    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  test("routes requests to registered handlers", async () => {
    server = new WebhookServer();
    const port = startServerOnEphemeralPort(server);

    server.registerRoute("/test", async () => {
      return new Response("OK", { status: 200 });
    });

    const res = await fetch(`http://localhost:${port}/test`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  test("stop closes the server", async () => {
    server = new WebhookServer();
    const port = startServerOnEphemeralPort(server);

    server.stop();

    // After stop, requests should fail
    try {
      await fetch(`http://localhost:${port}/test`);
      // If fetch succeeds, the server didn't stop (which is unexpected)
      expect(false).toBe(true);
    } catch {
      // Expected - connection refused
      expect(true).toBe(true);
    }
  });
});

describe("WebhookSource", () => {
  let server: WebhookServer;
  let source: WebhookSource;

  afterEach(async () => {
    await source?.stop();
    server?.stop();
  });

  test("receives POST webhook and emits event", async () => {
    server = new WebhookServer();
    const port = startServerOnEphemeralPort(server);

    const config: WebhookEventDef = {
      type: "webhook",
      path: "/hooks/test",
    };

    source = new WebhookSource("wh-test", config, server);

    const events: DaemonEvent[] = [];
    const collectPromise = (async () => {
      for await (const event of source.events()) {
        events.push(event);
        if (events.length >= 1) {
          await source.stop();
        }
      }
    })();

    // Give the event loop a tick to start listening
    await new Promise((r) => setTimeout(r, 50));

    const body = { action: "push", ref: "refs/heads/main" };
    const res = await fetch(`http://localhost:${port}/hooks/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);

    await collectPromise;

    expect(events.length).toBe(1);
    const payload = events[0]!.payload as WebhookPayload;
    expect(payload.type).toBe("webhook");
    expect(payload.method).toBe("POST");
    expect(payload.path).toBe("/hooks/test");
    expect(payload.body).toEqual(body);
    expect(events[0]!.sourceId).toBe("wh-test");
  }, 10000);

  test("rejects wrong method with 405", async () => {
    server = new WebhookServer();
    const port = startServerOnEphemeralPort(server);

    const config: WebhookEventDef = {
      type: "webhook",
      path: "/hooks/post-only",
      method: "POST",
    };

    source = new WebhookSource("wh-method", config, server);

    const res = await fetch(`http://localhost:${port}/hooks/post-only`, {
      method: "GET",
    });

    expect(res.status).toBe(405);
  });

  test("accepts custom method", async () => {
    server = new WebhookServer();
    const port = startServerOnEphemeralPort(server);

    const config: WebhookEventDef = {
      type: "webhook",
      path: "/hooks/put-hook",
      method: "PUT",
    };

    source = new WebhookSource("wh-put", config, server);

    const events: DaemonEvent[] = [];
    const collectPromise = (async () => {
      for await (const event of source.events()) {
        events.push(event);
        if (events.length >= 1) {
          await source.stop();
        }
      }
    })();

    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://localhost:${port}/hooks/put-hook`, {
      method: "PUT",
      body: "hello",
    });

    expect(res.status).toBe(200);
    await collectPromise;

    expect(events.length).toBe(1);
    const payload = events[0]!.payload as WebhookPayload;
    expect(payload.method).toBe("PUT");
  }, 10000);

  test("validates HMAC-SHA256 signature - valid", async () => {
    server = new WebhookServer();
    const port = startServerOnEphemeralPort(server);
    const secret = "my-secret-key";

    const config: WebhookEventDef = {
      type: "webhook",
      path: "/hooks/signed",
      secret,
    };

    source = new WebhookSource("wh-hmac", config, server);

    const events: DaemonEvent[] = [];
    const collectPromise = (async () => {
      for await (const event of source.events()) {
        events.push(event);
        if (events.length >= 1) {
          await source.stop();
        }
      }
    })();

    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.stringify({ test: true });
    const hmac = createHmac("sha256", secret);
    hmac.update(body);
    const signature = `sha256=${hmac.digest("hex")}`;

    const res = await fetch(`http://localhost:${port}/hooks/signed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
      },
      body,
    });

    expect(res.status).toBe(200);
    await collectPromise;

    expect(events.length).toBe(1);
  }, 10000);

  test("rejects invalid HMAC signature with 401", async () => {
    server = new WebhookServer();
    const port = startServerOnEphemeralPort(server);

    const config: WebhookEventDef = {
      type: "webhook",
      path: "/hooks/signed-reject",
      secret: "correct-secret",
    };

    source = new WebhookSource("wh-hmac-bad", config, server);

    const body = JSON.stringify({ test: true });

    // Wrong signature
    const res = await fetch(`http://localhost:${port}/hooks/signed-reject`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=invalid",
      },
      body,
    });

    expect(res.status).toBe(401);
  });

  test("rejects missing signature header with 401 when secret is set", async () => {
    server = new WebhookServer();
    const port = startServerOnEphemeralPort(server);

    const config: WebhookEventDef = {
      type: "webhook",
      path: "/hooks/no-sig",
      secret: "my-secret",
    };

    source = new WebhookSource("wh-no-sig", config, server);

    const res = await fetch(`http://localhost:${port}/hooks/no-sig`, {
      method: "POST",
      body: "{}",
    });

    expect(res.status).toBe(401);
  });

  test("resolves secret from environment variable", async () => {
    server = new WebhookServer();
    const port = startServerOnEphemeralPort(server);
    const envSecret = "env-secret-value-" + Date.now();

    process.env["TEST_WEBHOOK_SECRET"] = envSecret;

    const config: WebhookEventDef = {
      type: "webhook",
      path: "/hooks/env-secret",
      secret: "${TEST_WEBHOOK_SECRET}",
    };

    source = new WebhookSource("wh-env", config, server);

    const events: DaemonEvent[] = [];
    const collectPromise = (async () => {
      for await (const event of source.events()) {
        events.push(event);
        if (events.length >= 1) {
          await source.stop();
        }
      }
    })();

    await new Promise((r) => setTimeout(r, 50));

    const body = JSON.stringify({ env: true });
    const hmac = createHmac("sha256", envSecret);
    hmac.update(body);
    const signature = `sha256=${hmac.digest("hex")}`;

    const res = await fetch(`http://localhost:${port}/hooks/env-secret`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signature,
      },
      body,
    });

    expect(res.status).toBe(200);
    await collectPromise;

    expect(events.length).toBe(1);

    delete process.env["TEST_WEBHOOK_SECRET"];
  }, 10000);

  test("unknown path returns 404", async () => {
    server = new WebhookServer();
    const port = startServerOnEphemeralPort(server);

    const config: WebhookEventDef = {
      type: "webhook",
      path: "/hooks/known",
    };

    source = new WebhookSource("wh-404", config, server);

    const res = await fetch(`http://localhost:${port}/hooks/unknown`, {
      method: "POST",
    });

    expect(res.status).toBe(404);
  });

  test("stop() ends the event stream", async () => {
    server = new WebhookServer();
    startServerOnEphemeralPort(server);

    const config: WebhookEventDef = {
      type: "webhook",
      path: "/hooks/stop-test",
    };

    source = new WebhookSource("wh-stop", config, server);

    const events: DaemonEvent[] = [];

    // Stop almost immediately
    setTimeout(() => {
      void source.stop();
    }, 100);

    for await (const event of source.events()) {
      events.push(event);
    }

    expect(events.length).toBe(0);
  }, 5000);

  test("multiple webhook sources on same server", async () => {
    server = new WebhookServer();
    const port = startServerOnEphemeralPort(server);

    const config1: WebhookEventDef = {
      type: "webhook",
      path: "/hooks/one",
    };
    const config2: WebhookEventDef = {
      type: "webhook",
      path: "/hooks/two",
    };

    const source1 = new WebhookSource("wh-1", config1, server);
    const source2 = new WebhookSource("wh-2", config2, server);
    source = source1; // for afterEach cleanup

    const events1: DaemonEvent[] = [];
    const events2: DaemonEvent[] = [];

    const collect1 = (async () => {
      for await (const event of source1.events()) {
        events1.push(event);
        if (events1.length >= 1) {
          await source1.stop();
        }
      }
    })();

    const collect2 = (async () => {
      for await (const event of source2.events()) {
        events2.push(event);
        if (events2.length >= 1) {
          await source2.stop();
        }
      }
    })();

    await new Promise((r) => setTimeout(r, 50));

    await fetch(`http://localhost:${port}/hooks/one`, {
      method: "POST",
      body: JSON.stringify({ from: "one" }),
    });

    await fetch(`http://localhost:${port}/hooks/two`, {
      method: "POST",
      body: JSON.stringify({ from: "two" }),
    });

    await Promise.all([collect1, collect2]);

    expect(events1.length).toBe(1);
    expect(events2.length).toBe(1);
    expect(events1[0]!.sourceId).toBe("wh-1");
    expect(events2[0]!.sourceId).toBe("wh-2");
  }, 10000);

  test("non-JSON body is passed as string", async () => {
    server = new WebhookServer();
    const port = startServerOnEphemeralPort(server);

    const config: WebhookEventDef = {
      type: "webhook",
      path: "/hooks/plain",
    };

    source = new WebhookSource("wh-plain", config, server);

    const events: DaemonEvent[] = [];
    const collectPromise = (async () => {
      for await (const event of source.events()) {
        events.push(event);
        if (events.length >= 1) {
          await source.stop();
        }
      }
    })();

    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://localhost:${port}/hooks/plain`, {
      method: "POST",
      body: "plain text body",
    });

    expect(res.status).toBe(200);
    await collectPromise;

    expect(events.length).toBe(1);
    const payload = events[0]!.payload as WebhookPayload;
    expect(payload.body).toBe("plain text body");
  }, 10000);
});
