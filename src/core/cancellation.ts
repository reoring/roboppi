import type { UUID } from "../types/index.js";

export class CancellationManager {
  private controllers = new Map<UUID, AbortController>();
  private permitToJob = new Map<UUID, UUID>();

  createController(permitId: UUID, jobId?: UUID): AbortController {
    const controller = new AbortController();
    this.controllers.set(permitId, controller);
    if (jobId !== undefined) {
      this.permitToJob.set(permitId, jobId);
    }
    return controller;
  }

  cancel(permitId: UUID, reason?: string): void {
    const controller = this.controllers.get(permitId);
    if (controller && !controller.signal.aborted) {
      controller.abort(reason);
    }
  }

  cancelByJobId(jobId: UUID, reason?: string): void {
    for (const [permitId, mappedJobId] of this.permitToJob) {
      if (mappedJobId === jobId) {
        this.cancel(permitId, reason);
      }
    }
  }

  isAborted(permitId: UUID): boolean {
    const controller = this.controllers.get(permitId);
    return controller?.signal.aborted ?? false;
  }

  onAbort(permitId: UUID, callback: () => void): void {
    const controller = this.controllers.get(permitId);
    if (!controller) return;
    if (controller.signal.aborted) {
      callback();
      return;
    }
    controller.signal.addEventListener("abort", callback, { once: true });
  }

  removeController(permitId: UUID): void {
    this.controllers.delete(permitId);
    this.permitToJob.delete(permitId);
  }
}
