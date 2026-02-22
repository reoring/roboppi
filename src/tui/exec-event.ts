import type { WorkerEvent } from "../worker/worker-adapter.js";
import type { WorkerResult } from "../types/index.js";
import type { StepStatus, WorkflowStatus } from "../workflow/types.js";

export interface ExecEventSink {
  emit(event: ExecEvent): void;
}

export type ExecEvent =
  | {
      type: "workflow_started";
      workflowId: string;
      name: string;
      workspaceDir: string;
      supervised: boolean;
      startedAt: number;
      definitionSummary?: {
        steps: string[];
        concurrency?: number;
        timeout: string;
      };
    }
  | {
      type: "workflow_finished";
      status: WorkflowStatus;
      completedAt: number;
    }
  | {
      type: "step_state";
      stepId: string;
      status: StepStatus;
      iteration: number;
      maxIterations: number;
      startedAt?: number;
      completedAt?: number;
      error?: string;
    }
  | {
      type: "step_phase";
      stepId: string;
      phase:
        | "waiting_deps"
        | "ready"
        | "submitting_job"
        | "waiting_permit"
        | "executing"
        | "checking"
        | "collecting_outputs"
        | "finalizing";
      at: number;
      detail?: Record<string, unknown>;
    }
  | {
      type: "worker_event";
      stepId: string;
      ts: number;
      event: WorkerEvent;
    }
  | {
      type: "worker_result";
      stepId: string;
      ts: number;
      result: WorkerResult;
    }
  | {
      type: "core_log";
      ts: number;
      line: string;
    }
  | {
      type: "warning";
      ts: number;
      message: string;
      data?: unknown;
    };
