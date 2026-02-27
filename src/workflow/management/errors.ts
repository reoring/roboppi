export class ManagementHookTimeoutError extends Error {
  constructor(message = "management hook timed out") {
    super(message);
    this.name = "ManagementHookTimeoutError";
  }
}

export class ManagementHookAbortedError extends Error {
  constructor(message = "management hook aborted") {
    super(message);
    this.name = "ManagementHookAbortedError";
  }
}
