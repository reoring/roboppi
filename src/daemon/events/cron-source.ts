import type { DaemonEvent } from "../types.js";
import type { EventSource } from "./event-source.js";
import { waitOrAbort } from "./event-source.js";

// ---------------------------------------------------------------------------
// Simple cron parser (5-field: minute hour day-of-month month day-of-week)
// ---------------------------------------------------------------------------

interface CronField {
  values: Set<number>;
  any: boolean;
}

function parseField(field: string, min: number, max: number): CronField {
  if (field === "*") {
    return { values: new Set(), any: true };
  }

  const values = new Set<number>();
  const parts = field.split(",");

  for (const part of parts) {
    // Handle */N (every N)
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    if (stepMatch) {
      const step = parseInt(stepMatch[1]!, 10);
      if (step <= 0) throw new Error(`Invalid cron step: ${part}`);
      for (let i = min; i <= max; i += step) {
        values.add(i);
      }
      continue;
    }

    // Handle range with step: N-M/S
    const rangeStepMatch = /^(\d+)-(\d+)\/(\d+)$/.exec(part);
    if (rangeStepMatch) {
      const start = parseInt(rangeStepMatch[1]!, 10);
      const end = parseInt(rangeStepMatch[2]!, 10);
      const step = parseInt(rangeStepMatch[3]!, 10);
      if (start < min || end > max || start > end || step <= 0) {
        throw new Error(`Invalid cron range: ${part}`);
      }
      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
      continue;
    }

    // Handle range: N-M
    const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      if (start < min || end > max || start > end) {
        throw new Error(`Invalid cron range: ${part}`);
      }
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
      continue;
    }

    // Single value
    const val = parseInt(part, 10);
    if (isNaN(val) || val < min || val > max) {
      throw new Error(`Invalid cron value: ${part} (expected ${min}-${max})`);
    }
    values.add(val);
  }

  return { values, any: false };
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Invalid cron expression: expected 5 fields, got ${fields.length}`,
    );
  }
  return {
    minute: parseField(fields[0]!, 0, 59),
    hour: parseField(fields[1]!, 0, 23),
    dayOfMonth: parseField(fields[2]!, 1, 31),
    month: parseField(fields[3]!, 1, 12),
    dayOfWeek: parseField(fields[4]!, 0, 6), // 0 = Sunday
  };
}

function fieldMatches(field: CronField, value: number): boolean {
  return field.any || field.values.has(value);
}

/**
 * Compute the next fire time for a cron schedule, starting from `from`.
 * Searches forward minute-by-minute (up to ~2 years ahead).
 */
export function computeNextFire(schedule: string, from: Date): Date {
  const cron = parseCron(schedule);

  // Start from the next minute
  const candidate = new Date(from.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Search up to ~2 years ahead (prevent infinite loop)
  const maxIterations = 366 * 24 * 60;
  for (let i = 0; i < maxIterations; i++) {
    if (
      fieldMatches(cron.month, candidate.getMonth() + 1) &&
      fieldMatches(cron.dayOfMonth, candidate.getDate()) &&
      fieldMatches(cron.dayOfWeek, candidate.getDay()) &&
      fieldMatches(cron.hour, candidate.getHours()) &&
      fieldMatches(cron.minute, candidate.getMinutes())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`No next fire time found for schedule: ${schedule}`);
}

// ---------------------------------------------------------------------------
// CronSource
// ---------------------------------------------------------------------------

export class CronSource implements EventSource {
  readonly id: string;
  private readonly schedule: string;
  private abortController = new AbortController();

  constructor(id: string, schedule: string) {
    // Validate cron expression eagerly
    parseCron(schedule);
    this.id = id;
    this.schedule = schedule;
  }

  async *events(): AsyncGenerator<DaemonEvent> {
    const signal = this.abortController.signal;

    while (!signal.aborted) {
      const now = new Date();
      const next = computeNextFire(this.schedule, now);
      const delay = next.getTime() - Date.now();

      if (delay > 0) {
        const aborted = await waitOrAbort(delay, signal);
        if (aborted) break;
      }

      if (signal.aborted) break;

      yield {
        sourceId: this.id,
        timestamp: Date.now(),
        payload: {
          type: "cron",
          schedule: this.schedule,
          firedAt: Date.now(),
        },
      };
    }
  }

  async stop(): Promise<void> {
    this.abortController.abort();
  }
}
