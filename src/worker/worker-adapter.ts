import type { UUID } from "../types/index.js";
import type { WorkerKind, WorkerTask } from "../types/index.js";
import type { WorkerResult } from "../types/index.js";

export interface WorkerHandle {
  handleId: UUID;
  workerKind: WorkerKind;
  abortSignal: AbortSignal;
}

export type WorkerEvent =
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "progress"; message: string; percent?: number }
  | { type: "patch"; filePath: string; diff: string };

export interface WorkerAdapter {
  readonly kind: WorkerKind;
  startTask(task: WorkerTask): Promise<WorkerHandle>;
  streamEvents(handle: WorkerHandle): AsyncIterable<WorkerEvent>;
  cancel(handle: WorkerHandle): Promise<void>;
  awaitResult(handle: WorkerHandle): Promise<WorkerResult>;
}
