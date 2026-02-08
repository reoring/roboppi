import { describe, test, expect } from "bun:test";
import { JsonLinesTransport } from "../../../src/ipc/json-lines-transport.js";
import { IpcParseError, IpcDisconnectError, IpcBufferOverflowError, IpcSerializeError } from "../../../src/ipc/errors.js";

/** Helper: create a transport with an in-memory TransformStream pair. */
function createTestTransport(options?: { maxLineSize?: number }) {
  const inputStream = new TransformStream<Uint8Array, Uint8Array>();
  const outputStream = new TransformStream<Uint8Array, Uint8Array>();

  const transport = new JsonLinesTransport(
    inputStream.readable,
    outputStream.writable,
    options,
  );

  const inputWriter = inputStream.writable.getWriter();
  const outputReader = outputStream.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    transport,
    /** Write raw text into the transport's input (simulating stdin). */
    async feedInput(text: string) {
      await inputWriter.write(encoder.encode(text));
    },
    /** Close the input stream (simulating stdin EOF). */
    async closeInput() {
      await inputWriter.close();
    },
    /** Read all output written by the transport (simulating reading stdout). */
    async readOutput(): Promise<string> {
      const { value } = await outputReader.read();
      if (!value) return "";
      return decoder.decode(value);
    },
    encoder,
    decoder,
  };
}

/** Collect messages from transport until the close event or count is reached. */
function collectMessages(transport: JsonLinesTransport, count: number): Promise<unknown[]> {
  return new Promise((resolve) => {
    const messages: unknown[] = [];
    transport.on("message", (msg) => {
      messages.push(msg);
      if (messages.length >= count) {
        resolve(messages);
      }
    });
    transport.on("close", () => {
      resolve(messages);
    });
  });
}

describe("JsonLinesTransport", () => {
  describe("parsing", () => {
    test("parses a single valid JSON line", async () => {
      const { transport, feedInput, closeInput } = createTestTransport();
      const collected = collectMessages(transport, 1);
      transport.start();

      await feedInput('{"type":"heartbeat","timestamp":123}\n');
      const messages = await collected;

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: "heartbeat", timestamp: 123 });
      await closeInput();
      await transport.close();
    });

    test("parses multiple JSON lines in one chunk", async () => {
      const { transport, feedInput, closeInput } = createTestTransport();
      const collected = collectMessages(transport, 3);
      transport.start();

      await feedInput(
        '{"a":1}\n{"b":2}\n{"c":3}\n',
      );
      const messages = await collected;

      expect(messages).toHaveLength(3);
      expect(messages[0]).toEqual({ a: 1 });
      expect(messages[1]).toEqual({ b: 2 });
      expect(messages[2]).toEqual({ c: 3 });
      await closeInput();
      await transport.close();
    });

    test("handles partial lines across multiple chunks", async () => {
      const { transport, feedInput, closeInput } = createTestTransport();
      const collected = collectMessages(transport, 1);
      transport.start();

      await feedInput('{"type":"sub');
      await feedInput('mit_job","requestId');
      await feedInput('":"abc"}\n');

      const messages = await collected;
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: "submit_job", requestId: "abc" });
      await closeInput();
      await transport.close();
    });

    test("skips empty lines", async () => {
      const { transport, feedInput, closeInput } = createTestTransport();
      const collected = collectMessages(transport, 2);
      transport.start();

      await feedInput('{"a":1}\n\n\n{"b":2}\n');
      const messages = await collected;

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ a: 1 });
      expect(messages[1]).toEqual({ b: 2 });
      await closeInput();
      await transport.close();
    });

    test("emits IpcParseError on invalid JSON and continues", async () => {
      const { transport, feedInput, closeInput } = createTestTransport();
      const errors: Error[] = [];
      const collected = collectMessages(transport, 1);
      transport.on("error", (err) => errors.push(err));
      transport.start();

      await feedInput('not-json\n{"valid":true}\n');
      const messages = await collected;

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ valid: true });
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(IpcParseError);
      expect((errors[0] as IpcParseError).rawLine).toBe("not-json");
      await closeInput();
      await transport.close();
    });
  });

  describe("writing", () => {
    test("writes JSON followed by newline", async () => {
      const { transport, readOutput, closeInput } = createTestTransport();

      // Start reading before writing (TransformStream blocks write until reader is ready)
      const outputPromise = readOutput();
      await transport.write({ type: "ack", requestId: "r1", jobId: "j1" });
      const output = await outputPromise;

      expect(output).toBe('{"type":"ack","requestId":"r1","jobId":"j1"}\n');
      await closeInput();
      await transport.close();
    });

    test("throws IpcDisconnectError when writing to closed transport", async () => {
      const { transport, closeInput } = createTestTransport();
      await closeInput();
      await transport.close();

      expect(transport.write({ type: "heartbeat" })).rejects.toThrow(IpcDisconnectError);
    });
  });

  describe("close", () => {
    test("emits close event when input stream ends", async () => {
      const { transport, closeInput } = createTestTransport();
      let closeFired = false;
      transport.on("close", () => {
        closeFired = true;
      });
      transport.start();

      await closeInput();
      // Give the read loop time to detect the close
      await new Promise((r) => setTimeout(r, 50));
      expect(closeFired).toBe(true);
    });

    test("close() is idempotent", async () => {
      const { transport, closeInput } = createTestTransport();
      await closeInput();
      await transport.close();
      await transport.close(); // should not throw
    });
  });

  describe("buffer overflow", () => {
    test("rejects writing a message that exceeds maxLineSize", async () => {
      const { transport, closeInput } = createTestTransport({ maxLineSize: 50 });
      const bigPayload = { data: "x".repeat(100) };

      expect(transport.write(bigPayload)).rejects.toThrow(IpcBufferOverflowError);
      await closeInput();
      await transport.close();
    });
  });

  describe("messages() async iterator", () => {
    test("yields messages as they arrive", async () => {
      const { transport, feedInput, closeInput } = createTestTransport();
      const results: unknown[] = [];

      const iterPromise = (async () => {
        for await (const msg of transport.messages()) {
          results.push(msg);
          if (results.length >= 2) break;
        }
      })();

      await feedInput('{"x":1}\n{"x":2}\n');
      await iterPromise;

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ x: 1 });
      expect(results[1]).toEqual({ x: 2 });
      await closeInput();
      await transport.close();
    });

    test("terminates when transport closes", async () => {
      const { transport, feedInput, closeInput } = createTestTransport();
      const results: unknown[] = [];

      const iterPromise = (async () => {
        for await (const msg of transport.messages()) {
          results.push(msg);
        }
      })();

      await feedInput('{"a":1}\n');
      // Small delay to allow message processing
      await new Promise((r) => setTimeout(r, 20));
      await closeInput();
      await iterPromise;

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ a: 1 });
    });
  });

  describe("start", () => {
    test("start() is idempotent", async () => {
      const { transport, closeInput } = createTestTransport();
      transport.start();
      transport.start(); // should not throw or create a second read loop
      await closeInput();
      await transport.close();
    });
  });

  describe("error handling - malformed JSON", () => {
    test("multiple malformed lines each emit separate IpcParseError events", async () => {
      const { transport, feedInput, closeInput } = createTestTransport();
      const errors: Error[] = [];
      const collected = collectMessages(transport, 1);
      transport.on("error", (err) => errors.push(err));
      transport.start();

      await feedInput('{bad json}\n[also bad\n{"valid":true}\n');
      const messages = await collected;

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ valid: true });
      expect(errors).toHaveLength(2);
      expect(errors[0]).toBeInstanceOf(IpcParseError);
      expect(errors[1]).toBeInstanceOf(IpcParseError);
      await closeInput();
      await transport.close();
    });

    test("truncated JSON at stream end does not crash", async () => {
      const { transport, feedInput, closeInput } = createTestTransport();
      const errors: Error[] = [];
      transport.on("error", (err) => errors.push(err));
      transport.start();

      // Feed partial JSON then close — should not throw
      await feedInput('{"incomplete": tr');
      await closeInput();
      await new Promise((r) => setTimeout(r, 50));
      await transport.close();
      // No crash — the partial buffer is just discarded at EOF
    });
  });

  describe("error handling - mid-message disconnect", () => {
    test("abrupt input close mid-line emits close event", async () => {
      const { transport, feedInput, closeInput } = createTestTransport();
      let closeFired = false;
      transport.on("close", () => { closeFired = true; });
      transport.start();

      // Send partial data then close abruptly
      await feedInput('{"type":"heartbeat","timestamp":');
      await closeInput();
      await new Promise((r) => setTimeout(r, 50));

      expect(closeFired).toBe(true);
    });
  });

  describe("error handling - buffer overflow on read", () => {
    test("oversized line without newline triggers IpcBufferOverflowError and recovers", async () => {
      const { transport, feedInput, closeInput } = createTestTransport({ maxLineSize: 50 });
      const errors: Error[] = [];
      const collected = collectMessages(transport, 1);
      transport.on("error", (err) => errors.push(err));
      transport.start();

      // Send data exceeding maxLineSize without a newline, then follow with valid data
      const big = "x".repeat(100);
      await feedInput(big);
      // Give time for overflow detection
      await new Promise((r) => setTimeout(r, 20));
      await feedInput('\n{"ok":true}\n');
      const messages = await collected;

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0]).toBeInstanceOf(IpcBufferOverflowError);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ ok: true });
      await closeInput();
      await transport.close();
    });

    test("oversized line with newline emits overflow error and continues with rest", async () => {
      const { transport, feedInput, closeInput } = createTestTransport({ maxLineSize: 30 });
      const errors: Error[] = [];
      const collected = collectMessages(transport, 1);
      transport.on("error", (err) => errors.push(err));
      transport.start();

      // One oversized line followed by newline, then a valid line
      const oversized = JSON.stringify({ data: "y".repeat(50) });
      await feedInput(oversized + '\n{"good":true}\n');
      const messages = await collected;

      expect(errors.length).toBeGreaterThanOrEqual(1);
      const overflowError = errors.find((e) => e instanceof IpcBufferOverflowError);
      expect(overflowError).toBeDefined();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ good: true });
      await closeInput();
      await transport.close();
    });
  });

  describe("error handling - serialization failures", () => {
    test("circular reference in write throws IpcSerializeError", async () => {
      const { transport, closeInput } = createTestTransport();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const circular: any = { a: 1 };
      circular.self = circular;

      await expect(transport.write(circular)).rejects.toThrow(IpcSerializeError);
      await closeInput();
      await transport.close();
    });

    test("BigInt value in write throws IpcSerializeError", async () => {
      const { transport, closeInput } = createTestTransport();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bigIntObj: any = { value: BigInt(123) };

      await expect(transport.write(bigIntObj)).rejects.toThrow(IpcSerializeError);
      await closeInput();
      await transport.close();
    });
  });

  describe("byte-length buffer check with multi-byte Unicode", () => {
    test("multi-byte characters are correctly measured for overflow check", async () => {
      // Each emoji is 4 bytes in UTF-8. With maxLineSize=20 bytes,
      // 6 emoji chars = 24 bytes > 20 byte limit, but only 6 chars.
      // If using .length (char count), it would pass incorrectly.
      const { transport, closeInput } = createTestTransport({ maxLineSize: 20 });
      const emojiMsg = { d: "\u{1F600}\u{1F600}\u{1F600}" }; // 3 emoji = 12 bytes just for the emoji chars

      // The full JSON + newline will exceed 20 bytes
      // {"d":"😀😀😀"}\n = ~24 bytes
      await expect(transport.write(emojiMsg)).rejects.toThrow(IpcBufferOverflowError);
      await closeInput();
      await transport.close();
    });

    test("multi-byte characters within limit pass successfully", async () => {
      const { transport, readOutput, closeInput } = createTestTransport({ maxLineSize: 200 });
      const msg = { text: "\u{1F600}\u{1F4A9}\u{2764}" };

      const outputPromise = readOutput();
      await transport.write(msg);
      const output = await outputPromise;

      expect(output).toContain("\u{1F600}");
      await closeInput();
      await transport.close();
    });

    test("readLoop buffer overflow uses byte length for multi-byte input", async () => {
      // maxLineSize=30 bytes. Send emoji data that's few characters but many bytes.
      const { transport, feedInput, closeInput } = createTestTransport({ maxLineSize: 30 });
      const errors: Error[] = [];
      const collected = collectMessages(transport, 1);
      transport.on("error", (err) => errors.push(err));
      transport.start();

      // 10 emoji = 40 bytes, but only 10 chars. Without byte-length check, this would pass.
      const emojiLine = "\u{1F600}".repeat(10);
      await feedInput(emojiLine + '\n{"ok":1}\n');
      const messages = await collected;

      expect(errors.length).toBeGreaterThanOrEqual(1);
      const overflowError = errors.find((e) => e instanceof IpcBufferOverflowError);
      expect(overflowError).toBeDefined();
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ ok: 1 });
      await closeInput();
      await transport.close();
    });
  });
});
