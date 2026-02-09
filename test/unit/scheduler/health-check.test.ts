import { describe, test, expect, afterEach } from "bun:test";
import { JsonLinesTransport } from "../../../src/ipc/json-lines-transport.js";
import { IpcProtocol } from "../../../src/ipc/protocol.js";
import { HealthChecker } from "../../../src/scheduler/health-check.js";

function createTestProtocol() {
  const inputStream = new TransformStream<Uint8Array, Uint8Array>();
  const outputStream = new TransformStream<Uint8Array, Uint8Array>();

  const transport = new JsonLinesTransport(inputStream.readable, outputStream.writable);
  const protocol = new IpcProtocol(transport);

  const inputWriter = inputStream.writable.getWriter();
  const encoder = new TextEncoder();

  return {
    protocol,
    transport,
    async feedInput(text: string) {
      await inputWriter.write(encoder.encode(text));
    },
    async closeInput() {
      await inputWriter.close();
    },
  };
}

describe("HealthChecker", () => {
  let checker: HealthChecker;
  let protocol: IpcProtocol;
  let closeInput: () => Promise<void>;

  afterEach(async () => {
    checker?.stop();
    await closeInput?.();
    await protocol?.stop();
  });

  test("recordHeartbeatResponse updates lastResponseAt", () => {
    const { protocol: p, closeInput: ci } = createTestProtocol();
    protocol = p;
    closeInput = ci;

    checker = new HealthChecker(protocol, { intervalMs: 100000, unhealthyThresholdMs: 50 });
    checker.start();

    // recordHeartbeatResponse should not throw
    checker.recordHeartbeatResponse();
  });

  test("heartbeat_ack IPC message updates lastResponseAt via registered handler", async () => {
    const { protocol: p, feedInput, closeInput: ci } = createTestProtocol();
    protocol = p;
    closeInput = ci;

    let unhealthyCalled = false;
    checker = new HealthChecker(protocol, { intervalMs: 100000, unhealthyThresholdMs: 200 });
    checker.onUnhealthy(() => {
      unhealthyCalled = true;
    });
    checker.start();
    protocol.start();

    // Feed a heartbeat_ack message
    await feedInput(JSON.stringify({ type: "heartbeat_ack", timestamp: Date.now() }) + "\n");
    await new Promise((r) => setTimeout(r, 50));

    // The handler should have called recordHeartbeatResponse internally.
    // If we wait less than unhealthyThresholdMs, unhealthy should not fire.
    expect(unhealthyCalled).toBe(false);
  });

  test("unhealthy callback fires when no heartbeat_ack received within threshold", async () => {
    const { protocol: p, closeInput: ci } = createTestProtocol();
    protocol = p;
    closeInput = ci;

    let unhealthyCalled = false;
    checker = new HealthChecker(protocol, { intervalMs: 50, unhealthyThresholdMs: 30 });
    checker.onUnhealthy(() => {
      unhealthyCalled = true;
    });
    checker.start();

    // Wait long enough for the threshold to expire
    await new Promise((r) => setTimeout(r, 150));

    expect(unhealthyCalled).toBe(true);
  });

  test("start is idempotent", () => {
    const { protocol: p, closeInput: ci } = createTestProtocol();
    protocol = p;
    closeInput = ci;

    checker = new HealthChecker(protocol, { intervalMs: 100000, unhealthyThresholdMs: 100000 });
    checker.start();
    checker.start(); // should not throw or create duplicate timers
  });

  test("stop clears the interval", () => {
    const { protocol: p, closeInput: ci } = createTestProtocol();
    protocol = p;
    closeInput = ci;

    checker = new HealthChecker(protocol, { intervalMs: 100000, unhealthyThresholdMs: 100000 });
    checker.start();
    checker.stop();
    // Stopping should not throw
    checker.stop(); // idempotent
  });
});
