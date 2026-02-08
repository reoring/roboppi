import type { UUID } from "../types/index.js";

export enum DeduplicationPolicy {
  COALESCE = "COALESCE",
  LATEST_WINS = "LATEST_WINS",
  REJECT = "REJECT",
}

export type RegisterResult =
  | { action: "proceed" }
  | { action: "proceed"; cancelJobId: string }
  | { action: "coalesce"; existingJobId: string }
  | { action: "reject"; existingJobId: string };

interface InFlightEntry {
  jobId: UUID;
  policy: DeduplicationPolicy;
}

export class InFlightRegistry {
  private readonly entries = new Map<string, InFlightEntry>();

  register(key: string, jobId: UUID, policy: DeduplicationPolicy): RegisterResult {
    const existing = this.entries.get(key);

    if (!existing) {
      this.entries.set(key, { jobId, policy });
      return { action: "proceed" };
    }

    switch (policy) {
      case DeduplicationPolicy.COALESCE:
        return { action: "coalesce", existingJobId: existing.jobId };

      case DeduplicationPolicy.LATEST_WINS: {
        const cancelJobId = existing.jobId;
        this.entries.set(key, { jobId, policy });
        return { action: "proceed", cancelJobId };
      }

      case DeduplicationPolicy.REJECT:
        return { action: "reject", existingJobId: existing.jobId };
    }
  }

  deregister(key: string): void {
    this.entries.delete(key);
  }

  lookup(key: string): UUID | undefined {
    return this.entries.get(key)?.jobId;
  }

  isInFlight(key: string): boolean {
    return this.entries.has(key);
  }
}
