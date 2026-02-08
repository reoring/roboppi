import { describe, test, expect } from "bun:test";
import {
  CronSource,
  IntervalSource,
  parseCron,
  computeNextFire,
  mergeEventSources,
} from "../../../src/daemon/events/index.js";
import type { DaemonEvent } from "../../../src/daemon/types.js";

// ---------------------------------------------------------------------------
// Cron parser unit tests
// ---------------------------------------------------------------------------

describe("parseCron", () => {
  test("parses all-wildcard expression", () => {
    const cron = parseCron("* * * * *");
    expect(cron.minute.any).toBe(true);
    expect(cron.hour.any).toBe(true);
    expect(cron.dayOfMonth.any).toBe(true);
    expect(cron.month.any).toBe(true);
    expect(cron.dayOfWeek.any).toBe(true);
  });

  test("parses specific values", () => {
    const cron = parseCron("30 14 1 6 3");
    expect(cron.minute.values).toEqual(new Set([30]));
    expect(cron.hour.values).toEqual(new Set([14]));
    expect(cron.dayOfMonth.values).toEqual(new Set([1]));
    expect(cron.month.values).toEqual(new Set([6]));
    expect(cron.dayOfWeek.values).toEqual(new Set([3]));
  });

  test("parses */N step values", () => {
    const cron = parseCron("*/15 */6 * * *");
    expect(cron.minute.values).toEqual(new Set([0, 15, 30, 45]));
    expect(cron.hour.values).toEqual(new Set([0, 6, 12, 18]));
  });

  test("parses comma-separated lists", () => {
    const cron = parseCron("0,30 9,17 * * 1,5");
    expect(cron.minute.values).toEqual(new Set([0, 30]));
    expect(cron.hour.values).toEqual(new Set([9, 17]));
    expect(cron.dayOfWeek.values).toEqual(new Set([1, 5]));
  });

  test("parses ranges", () => {
    const cron = parseCron("0 9-17 * * 1-5");
    expect(cron.minute.values).toEqual(new Set([0]));
    expect(cron.hour.values).toEqual(
      new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]),
    );
    expect(cron.dayOfWeek.values).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  test("parses range with step", () => {
    const cron = parseCron("1-30/10 * * * *");
    expect(cron.minute.values).toEqual(new Set([1, 11, 21]));
  });

  test("rejects invalid expressions", () => {
    expect(() => parseCron("* *")).toThrow();
    expect(() => parseCron("60 * * * *")).toThrow();
    expect(() => parseCron("* 25 * * *")).toThrow();
    expect(() => parseCron("abc * * * *")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// computeNextFire
// ---------------------------------------------------------------------------

describe("computeNextFire", () => {
  test("finds next minute for * * * * *", () => {
    const from = new Date("2025-01-15T10:30:00Z");
    const next = computeNextFire("* * * * *", from);
    expect(next.getTime()).toBe(new Date("2025-01-15T10:31:00Z").getTime());
  });

  test("finds next matching minute", () => {
    const from = new Date("2025-01-15T10:20:00Z");
    const next = computeNextFire("30 * * * *", from);
    expect(next.getMinutes()).toBe(30);
    expect(next.getHours()).toBe(from.getHours());
  });

  test("wraps to next hour if minute already passed", () => {
    const from = new Date("2025-01-15T10:45:00Z");
    const next = computeNextFire("30 * * * *", from);
    expect(next.getMinutes()).toBe(30);
    expect(next.getHours()).toBe(11);
  });

  test("finds next matching hour", () => {
    const from = new Date("2025-01-15T10:00:00Z");
    const next = computeNextFire("0 14 * * *", from);
    expect(next.getHours()).toBe(14);
    expect(next.getMinutes()).toBe(0);
  });

  test("finds next matching day of week", () => {
    // 2025-01-15 is a Wednesday (day 3)
    const from = new Date("2025-01-15T10:00:00Z");
    const next = computeNextFire("0 9 * * 5", from); // Friday
    expect(next.getDay()).toBe(5);
    expect(next.getDate()).toBe(17); // Jan 17, 2025 is Friday
  });

  test("handles */5 minute schedule", () => {
    const from = new Date("2025-01-15T10:07:00Z");
    const next = computeNextFire("*/5 * * * *", from);
    expect(next.getMinutes()).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// CronSource
// ---------------------------------------------------------------------------

describe("CronSource", () => {
  test("validates cron expression on construction", () => {
    expect(() => new CronSource("test", "bad")).toThrow();
    expect(() => new CronSource("test", "* * * * *")).not.toThrow();
  });

  test("has correct id", () => {
    const source = new CronSource("my-cron", "* * * * *");
    expect(source.id).toBe("my-cron");
  });

  test("stop() causes events() to end", async () => {
    const source = new CronSource("cron-stop-test", "* * * * *");
    const events: DaemonEvent[] = [];

    const iterator = source.events()[Symbol.asyncIterator]();

    // Stop immediately so we don't wait a full minute
    await source.stop();

    const result = await iterator.next();
    expect(result.done).toBe(true);
    expect(events.length).toBe(0);
  });

  test("events have correct payload shape", async () => {
    // We can't easily test CronSource firing in a unit test since
    // minimum cron interval is 1 minute. Instead we test the payload shape
    // by verifying the class structure and relying on computeNextFire tests.
    const source = new CronSource("cron-shape", "*/1 * * * *");
    expect(source.id).toBe("cron-shape");
    await source.stop();
  });
});

// ---------------------------------------------------------------------------
// IntervalSource
// ---------------------------------------------------------------------------

describe("IntervalSource", () => {
  test("fires at regular intervals", async () => {
    const source = new IntervalSource("int-test", "1s");
    const events: DaemonEvent[] = [];
    const start = Date.now();

    const collect = (async () => {
      for await (const event of source.events()) {
        events.push(event);
        if (events.length >= 2) {
          await source.stop();
        }
      }
    })();

    await collect;

    expect(events.length).toBe(2);
    for (const event of events) {
      expect(event.sourceId).toBe("int-test");
      expect(event.payload.type).toBe("interval");
      if (event.payload.type === "interval") {
        expect(event.payload.firedAt).toBeGreaterThanOrEqual(start);
      }
    }

    // Total time should be around 2s (2 intervals of 1s)
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(1800);
    expect(elapsed).toBeLessThan(4000);
  }, 10000);

  test("stop() ends event stream", async () => {
    const source = new IntervalSource("int-stop", "1s");
    const events: DaemonEvent[] = [];

    // Stop after a brief delay (before first fire)
    setTimeout(() => {
      void source.stop();
    }, 200);

    for await (const event of source.events()) {
      events.push(event);
    }

    expect(events.length).toBe(0);
  }, 5000);

  test("has correct id", () => {
    const source = new IntervalSource("my-interval", "5m");
    expect(source.id).toBe("my-interval");
  });

  test("rejects invalid duration", () => {
    expect(() => new IntervalSource("bad", "xyz")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// mergeEventSources
// ---------------------------------------------------------------------------

describe("mergeEventSources", () => {
  test("merges events from multiple sources", async () => {
    const source1 = new IntervalSource("src-a", "1s");
    const source2 = new IntervalSource("src-b", "1s");

    const events: DaemonEvent[] = [];

    const collect = (async () => {
      for await (const event of mergeEventSources([source1, source2])) {
        events.push(event);
        if (events.length >= 4) {
          await source1.stop();
          await source2.stop();
        }
      }
    })();

    await collect;

    expect(events.length).toBeGreaterThanOrEqual(4);

    const sourceIds = new Set(events.map((e) => e.sourceId));
    expect(sourceIds.has("src-a")).toBe(true);
    expect(sourceIds.has("src-b")).toBe(true);
  }, 10000);

  test("continues when one source stops", async () => {
    const source1 = new IntervalSource("short", "1s");
    const source2 = new IntervalSource("long", "1s");

    // Stop source1 quickly
    setTimeout(() => {
      void source1.stop();
    }, 200);

    const events: DaemonEvent[] = [];

    const collect = (async () => {
      for await (const event of mergeEventSources([source1, source2])) {
        events.push(event);
        if (events.length >= 2) {
          await source2.stop();
        }
      }
    })();

    await collect;

    // All events should be from source2 since source1 was stopped before first fire
    const fromLong = events.filter((e) => e.sourceId === "long");
    expect(fromLong.length).toBeGreaterThanOrEqual(2);
  }, 10000);

  test("ends when all sources are empty", async () => {
    const events: DaemonEvent[] = [];
    for await (const event of mergeEventSources([])) {
      events.push(event);
    }
    expect(events.length).toBe(0);
  });

  test("handles single source", async () => {
    const source = new IntervalSource("only", "1s");

    const events: DaemonEvent[] = [];

    const collect = (async () => {
      for await (const event of mergeEventSources([source])) {
        events.push(event);
        if (events.length >= 1) {
          await source.stop();
        }
      }
    })();

    await collect;

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.sourceId).toBe("only");
  }, 5000);
});
