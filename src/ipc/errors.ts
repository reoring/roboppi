export class IpcParseError extends Error {
  readonly rawLine: string;

  constructor(rawLine: string, cause?: unknown) {
    super(`Failed to parse JSON line: ${rawLine.slice(0, 200)}`);
    this.name = "IpcParseError";
    this.rawLine = rawLine;
    this.cause = cause;
  }
}

export class IpcDisconnectError extends Error {
  constructor(message = "IPC stream unexpectedly closed") {
    super(message);
    this.name = "IpcDisconnectError";
  }
}

export class IpcTimeoutError extends Error {
  readonly requestId: string;
  readonly timeoutMs: number;

  constructor(requestId: string, timeoutMs: number) {
    super(`IPC request ${requestId} timed out after ${timeoutMs}ms`);
    this.name = "IpcTimeoutError";
    this.requestId = requestId;
    this.timeoutMs = timeoutMs;
  }
}

export class IpcStoppedError extends Error {
  readonly requestId: string;

  constructor(requestId: string) {
    super(`IPC request ${requestId} aborted: protocol stopped`);
    this.name = "IpcStoppedError";
    this.requestId = requestId;
  }
}

export class IpcBufferOverflowError extends Error {
  readonly size: number;
  readonly maxSize: number;

  constructor(size: number, maxSize: number) {
    super(`IPC message size ${size} exceeds maximum ${maxSize}`);
    this.name = "IpcBufferOverflowError";
    this.size = size;
    this.maxSize = maxSize;
  }
}

export class IpcSerializeError extends Error {
  constructor(cause?: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to serialize IPC message: ${detail}`);
    this.name = "IpcSerializeError";
    this.cause = cause;
  }
}
