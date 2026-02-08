import type { Timestamp } from "./common.js";

export enum EscalationScope {
  WORKER_KIND = "WORKER_KIND",
  WORKSPACE = "WORKSPACE",
  GLOBAL = "GLOBAL",
}

export enum EscalationAction {
  ISOLATE = "ISOLATE",
  STOP = "STOP",
  NOTIFY = "NOTIFY",
}

export interface EscalationEvent {
  scope: EscalationScope;
  action: EscalationAction;
  target: string;
  reason: string;
  timestamp: Timestamp;
  severity: "warning" | "error" | "fatal";
}
