import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { FSWatchSource, globMatch } from "../../../src/daemon/events/fswatch-source.js";
import type { DaemonEvent, FSWatchEventDef, FSWatchPayload } from "../../../src/daemon/types.js";

// ---------------------------------------------------------------------------
// globMatch unit tests
// ---------------------------------------------------------------------------

describe("globMatch", () => {
  test("* matches any characters except /", () => {
    expect(globMatch("*.ts", "foo.ts")).toBe(true);
    expect(globMatch("*.ts", "bar.js")).toBe(false);
    expect(globMatch("*.ts", "dir/foo.ts")).toBe(false);
  });

  test("** matches any characters including /", () => {
    expect(globMatch("**/*.ts", "foo.ts")).toBe(true);
    expect(globMatch("**/*.ts", "dir/foo.ts")).toBe(true);
    expect(globMatch("**/*.ts", "a/b/c.ts")).toBe(true);
    expect(globMatch("**/*.ts", "a/b/c.js")).toBe(false);
  });

  test("? matches single character", () => {
    expect(globMatch("?.ts", "a.ts")).toBe(true);
    expect(globMatch("?.ts", "ab.ts")).toBe(false);
  });

  test("exact match without globs", () => {
    expect(globMatch("foo.ts", "foo.ts")).toBe(true);
    expect(globMatch("foo.ts", "bar.ts")).toBe(false);
  });

  test("dots are escaped", () => {
    expect(globMatch("*.log", "fooXlog")).toBe(false);
    expect(globMatch("*.log", "foo.log")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FSWatchSource integration tests (real filesystem)
// ---------------------------------------------------------------------------

describe("FSWatchSource", () => {
  let tmpDir: string;
  let source: FSWatchSource | null = null;

  afterEach(async () => {
    if (source) {
      await source.stop();
      source = null;
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("emits event when a file is created", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fswatch-test-"));

    const config: FSWatchEventDef = {
      type: "fswatch",
      paths: [tmpDir],
    };

    source = new FSWatchSource("fs-test", config, 100);
    const events: DaemonEvent[] = [];

    const collect = (async () => {
      for await (const event of source!.events()) {
        events.push(event);
        if (events.length >= 1) {
          await source!.stop();
        }
      }
    })();

    // Give the watcher time to initialize
    await sleep(100);

    // Write a file
    await writeFile(path.join(tmpDir, "hello.txt"), "hello world");

    await collect;

    expect(events.length).toBeGreaterThanOrEqual(1);
    const first = events[0]!;
    expect(first.sourceId).toBe("fs-test");
    expect(first.payload.type).toBe("fswatch");
    const payload = first.payload as FSWatchPayload;
    expect(payload.changes.length).toBeGreaterThanOrEqual(1);
    expect(payload.changes.some((c) => c.path.includes("hello.txt"))).toBe(true);
  }, 10000);

  test("ignore patterns suppress events", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fswatch-ignore-"));

    const config: FSWatchEventDef = {
      type: "fswatch",
      paths: [tmpDir],
      ignore: ["*.log"],
    };

    source = new FSWatchSource("fs-ignore", config, 100);
    const events: DaemonEvent[] = [];

    const collect = (async () => {
      for await (const event of source!.events()) {
        events.push(event);
        if (events.length >= 1) {
          await source!.stop();
        }
      }
    })();

    // Give the watcher time to initialize
    await sleep(100);

    // Write an ignored file first
    await writeFile(path.join(tmpDir, "debug.log"), "log data");

    // Wait a bit to ensure no event fires from the ignored file
    await sleep(300);

    // Write a non-ignored file to trigger an event and end the test
    await writeFile(path.join(tmpDir, "code.ts"), "const x = 1;");

    await collect;

    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const event of events) {
      const payload = event.payload as FSWatchPayload;
      for (const change of payload.changes) {
        expect(change.path).not.toMatch(/\.log$/);
      }
    }
  }, 10000);

  test("batches multiple rapid changes into one event", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fswatch-batch-"));

    const config: FSWatchEventDef = {
      type: "fswatch",
      paths: [tmpDir],
    };

    // Use a longer batch window to ensure batching
    source = new FSWatchSource("fs-batch", config, 300);
    const events: DaemonEvent[] = [];

    const collect = (async () => {
      for await (const event of source!.events()) {
        events.push(event);
        if (events.length >= 1) {
          await source!.stop();
        }
      }
    })();

    await sleep(100);

    // Write multiple files rapidly (within the batch window)
    await writeFile(path.join(tmpDir, "a.txt"), "a");
    await writeFile(path.join(tmpDir, "b.txt"), "b");
    await writeFile(path.join(tmpDir, "c.txt"), "c");

    await collect;

    // Should get exactly 1 batched event.
    // Note: fs.watch is not guaranteed to report every individual file change
    // on all platforms/filesystems, so we assert at least one change.
    expect(events.length).toBe(1);
    const payload = events[0]!.payload as FSWatchPayload;
    expect(payload.changes.length).toBeGreaterThanOrEqual(1);
  }, 10000);

  test("stop() cleanly terminates the event stream", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fswatch-stop-"));

    const config: FSWatchEventDef = {
      type: "fswatch",
      paths: [tmpDir],
    };

    source = new FSWatchSource("fs-stop", config, 100);
    const events: DaemonEvent[] = [];

    // Stop after a brief delay (before any file changes)
    setTimeout(() => {
      void source!.stop();
    }, 200);

    for await (const event of source.events()) {
      events.push(event);
    }

    expect(events.length).toBe(0);
  }, 5000);

  test("has correct id", () => {
    const config: FSWatchEventDef = {
      type: "fswatch",
      paths: ["/tmp"],
    };
    source = new FSWatchSource("my-fswatch", config);
    expect(source.id).toBe("my-fswatch");
  });

  test("event type filtering works", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fswatch-filter-"));

    const config: FSWatchEventDef = {
      type: "fswatch",
      paths: [tmpDir],
      events: ["create"], // only create events
    };

    source = new FSWatchSource("fs-filter", config, 100);
    const events: DaemonEvent[] = [];

    const collect = (async () => {
      for await (const event of source!.events()) {
        events.push(event);
        if (events.length >= 1) {
          await source!.stop();
        }
      }
    })();

    await sleep(100);

    // Create a new file (should be "rename" event which maps to "create")
    await writeFile(path.join(tmpDir, "new-file.txt"), "new");

    await collect;

    expect(events.length).toBeGreaterThanOrEqual(1);
    const payload = events[0]!.payload as FSWatchPayload;
    for (const change of payload.changes) {
      expect(change.event).toBe("create");
    }
  }, 10000);

  test("resolves relative watch paths against baseDir", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "fswatch-basedir-"));

    const config: FSWatchEventDef = {
      type: "fswatch",
      paths: ["."],
    };

    source = new FSWatchSource("fs-basedir", config, 100, tmpDir);
    const events: DaemonEvent[] = [];

    const collect = (async () => {
      for await (const event of source!.events()) {
        events.push(event);
        if (events.length >= 1) {
          await source!.stop();
        }
      }
    })();

    await sleep(100);
    await writeFile(path.join(tmpDir, "hello.txt"), "hello world");
    await collect;

    expect(events.length).toBeGreaterThanOrEqual(1);
  }, 10000);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
