import type { ErrorClass } from "./common.js";

export enum WorkerStatus {
  SUCCEEDED = "SUCCEEDED",
  FAILED = "FAILED",
  CANCELLED = "CANCELLED",
}

export interface Artifact {
  type: "patch" | "diff" | "log" | "binary" | string;
  ref: string;
  content?: string;
}

export interface Observation {
  command?: string;
  filesChanged?: string[];
  summary?: string;
}

export interface WorkerCost {
  estimatedTokens?: number;
  wallTimeMs: number;
}

export interface WorkerResult {
  status: WorkerStatus;
  artifacts: Artifact[];
  observations: Observation[];
  cost: WorkerCost;
  durationMs: number;
  errorClass?: ErrorClass;
}
