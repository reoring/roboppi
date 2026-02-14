import { IpcParseError, IpcDisconnectError, IpcBufferOverflowError, IpcSerializeError } from "./errors.js";

export type TransportEventType = "message" | "error" | "close";

type EventHandler<T> = (data: T) => void;

const DEFAULT_MAX_LINE_SIZE = 10 * 1024 * 1024; // 10 MB

export interface JsonLinesTransportOptions {
  maxLineSize?: number;
}

export class JsonLinesTransport {
  private readonly input: ReadableStream<Uint8Array>;
  private readonly output: WritableStream<Uint8Array>;
  private readonly maxLineSize: number;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  private messageHandlers: EventHandler<unknown>[] = [];
  private errorHandlers: EventHandler<Error>[] = [];
  private closeHandlers: EventHandler<void>[] = [];

  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;
  private readLoopPromise: Promise<void> | null = null;

  private readonly traceEnabled = process.env.AGENTCORE_IPC_TRACE === "1";

  constructor(
    input: ReadableStream<Uint8Array>,
    output: WritableStream<Uint8Array>,
    options?: JsonLinesTransportOptions,
  ) {
    this.input = input;
    this.output = output;
    this.maxLineSize = options?.maxLineSize ?? DEFAULT_MAX_LINE_SIZE;
  }

  on(event: "message", handler: EventHandler<unknown>): this;
  on(event: "error", handler: EventHandler<Error>): this;
  on(event: "close", handler: EventHandler<void>): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: TransportEventType, handler: EventHandler<any>): this {
    switch (event) {
      case "message":
        this.messageHandlers.push(handler);
        break;
      case "error":
        this.errorHandlers.push(handler as EventHandler<Error>);
        break;
      case "close":
        this.closeHandlers.push(handler as EventHandler<void>);
        break;
    }
    return this;
  }

  off(event: "message", handler: EventHandler<unknown>): this;
  off(event: "error", handler: EventHandler<Error>): this;
  off(event: "close", handler: EventHandler<void>): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: TransportEventType, handler: EventHandler<any>): this {
    switch (event) {
      case "message":
        this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
        break;
      case "error":
        this.errorHandlers = this.errorHandlers.filter((h) => h !== (handler as EventHandler<Error>));
        break;
      case "close":
        this.closeHandlers = this.closeHandlers.filter((h) => h !== (handler as EventHandler<void>));
        break;
    }
    return this;
  }

  /** Start reading from the input stream. Must be called to begin receiving messages. */
  start(): void {
    if (this.readLoopPromise) return;
    this.reader = this.input.getReader();
    this.readLoopPromise = this.readLoop();
  }

  /** Write a JSON message followed by a newline to the output stream. */
  async write(message: object): Promise<void> {
    if (this.closed) {
      throw new IpcDisconnectError("Cannot write to closed transport");
    }
    if (!this.writer) {
      this.writer = this.output.getWriter();
    }
    let line: string;
    try {
      line = JSON.stringify(message) + "\n";
    } catch (err) {
      throw new IpcSerializeError(err);
    }
    const bytes = this.encoder.encode(line);

    if (this.traceEnabled) {
      traceIpc("tx", message, bytes.byteLength);
    }
    if (bytes.byteLength > this.maxLineSize) {
      throw new IpcBufferOverflowError(bytes.byteLength, this.maxLineSize);
    }
    await this.writer.write(bytes);
  }

  /** Close the transport gracefully. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.reader) {
      try {
        this.reader.cancel();
      } catch {
        // ignore cancel errors
      }
    }
    if (this.writer) {
      try {
        await this.writer.close();
      } catch {
        // ignore close errors
      }
    }
    if (this.readLoopPromise) {
      await this.readLoopPromise.catch(() => {});
    }
    this.emitClose();
    // Clear all handler arrays to prevent memory leaks
    this.messageHandlers = [];
    this.errorHandlers = [];
    this.closeHandlers = [];
  }

  /** Returns an async iterable of parsed messages. Starts the transport if not already started. */
  async *messages(): AsyncIterable<unknown> {
    const queue: unknown[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const onMessage = (msg: unknown) => {
      queue.push(msg);
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    const onClose = () => {
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    this.on("message", onMessage);
    this.on("close", onClose);

    if (!this.readLoopPromise) {
      this.start();
    }

    try {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (done) return;
        await new Promise<void>((r) => {
          resolve = r;
        });
      }
    } finally {
      this.off("message", onMessage);
      this.off("close", onClose);
    }
  }

  private async readLoop(): Promise<void> {
    let buffer = "";
    const reader = this.reader!;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += this.decoder.decode(value, { stream: true });

        // Check buffer overflow before processing (use byte length for accuracy with multi-byte chars)
        const bufferByteLength = Buffer.byteLength(buffer);
        if (bufferByteLength > this.maxLineSize) {
          // Find any newline to recover
          const nlIndex = buffer.indexOf("\n");
          if (nlIndex === -1) {
            this.emitError(new IpcBufferOverflowError(bufferByteLength, this.maxLineSize));
            buffer = "";
            continue;
          }
          // Process the oversized line as an error, then continue with the rest
          const oversizedLine = buffer.slice(0, nlIndex);
          this.emitError(new IpcBufferOverflowError(Buffer.byteLength(oversizedLine), this.maxLineSize));
          buffer = buffer.slice(nlIndex + 1);
        }

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);

          if (line.trim() === "") continue;

          try {
            const parsed: unknown = JSON.parse(line);

            if (this.traceEnabled) {
              traceIpc("rx", parsed);
            }

            this.emitMessage(parsed);
          } catch (err) {
            this.emitError(new IpcParseError(line, err));
          }
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.emitError(new IpcDisconnectError(String(err)));
      }
    } finally {
      if (!this.closed) {
        this.closed = true;
        this.emitClose();
      }
    }
  }

  private emitMessage(data: unknown): void {
    for (const handler of this.messageHandlers) {
      handler(data);
    }
  }

  private emitError(err: Error): void {
    for (const handler of this.errorHandlers) {
      handler(err);
    }
  }

  private emitClose(): void {
    for (const handler of this.closeHandlers) {
      handler();
    }
  }
}

function traceIpc(direction: "tx" | "rx", msg: unknown, byteLength?: number): void {
  try {
    if (typeof msg !== "object" || msg === null) {
      process.stderr.write(`[IPC][${direction}] pid=${process.pid} non-object\n`);
      return;
    }

    const m = msg as Record<string, unknown>;
    const type = typeof m.type === "string" ? m.type : "?";
    const requestId = typeof m.requestId === "string" ? m.requestId : "";
    const jobId = typeof m.jobId === "string" ? m.jobId : "";

    const parts: string[] = [`[IPC][${direction}]`, `pid=${process.pid}`, `type=${type}`];
    if (requestId) parts.push(`requestId=${requestId}`);
    if (jobId) parts.push(`jobId=${jobId}`);
    if (byteLength !== undefined) parts.push(`bytes=${byteLength}`);
    process.stderr.write(parts.join(" ") + "\n");
  } catch {
    // ignore
  }
}
