import { describe, test, expect, afterEach } from "bun:test";
import { CommandSource } from "../../../src/daemon/events/command-source.js";
import type { DaemonEvent, CommandEventDef, CommandPayload } from "../../../src/daemon/types.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// CommandSource
// ---------------------------------------------------------------------------

describe("CommandSource", () => {
  const sources: CommandSource[] = [];

  function makeSource(id: string, config: CommandEventDef): CommandSource {
    const src = new CommandSource(id, config);
    sources.push(src);
    return src;
  }

  afterEach(async () => {
    for (const s of sources) {
      await s.stop();
    }
    sources.length = 0;
  });

  test("has correct id", () => {
    const source = makeSource("cmd-test", {
      type: "command",
      command: "echo hello",
      interval: "1s",
    });
    expect(source.id).toBe("cmd-test");
  });

  test("emits events with trigger_on 'always'", async () => {
    const source = makeSource("cmd-always", {
      type: "command",
      command: "echo hello",
      interval: "1s",
      trigger_on: "always",
    });

    const events: DaemonEvent[] = [];

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
      expect(event.sourceId).toBe("cmd-always");
      expect(event.payload.type).toBe("command");
      const payload = event.payload as CommandPayload;
      expect(payload.stdout.trim()).toBe("hello");
      expect(payload.exitCode).toBe(0);
    }

    // First run: changed=false (no previous), second: also false (same output)
    expect((events[0]!.payload as CommandPayload).changed).toBe(false);
    expect((events[1]!.payload as CommandPayload).changed).toBe(false);
  }, 10000);

  test("change detection: only emits when output changes", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "cmd-test-"));
    const counterFile = path.join(tmpDir, "counter");
    await writeFile(counterFile, "0");

    // Command that increments counter and prints it
    const command = `count=$(cat ${counterFile}); count=$((count + 1)); echo $count > ${counterFile}; cat ${counterFile}`;

    const source = makeSource("cmd-change", {
      type: "command",
      command,
      interval: "1s",
      trigger_on: "change",
    });

    const events: DaemonEvent[] = [];

    const collect = (async () => {
      for await (const event of source.events()) {
        events.push(event);
        if (events.length >= 3) {
          await source.stop();
        }
      }
    })();

    await collect;

    // Every run produces a new counter value, so every run should emit
    // First run: baseline with changed=false
    // Subsequent runs: changed=true (output differs from previous)
    expect(events.length).toBe(3);
    expect((events[0]!.payload as CommandPayload).changed).toBe(false);
    expect((events[1]!.payload as CommandPayload).changed).toBe(true);
    expect((events[2]!.payload as CommandPayload).changed).toBe(true);

    await rm(tmpDir, { recursive: true });
  }, 10000);

  test("change detection baseline: first run emits with changed=false", async () => {
    const source = makeSource("cmd-baseline", {
      type: "command",
      command: "echo baseline",
      interval: "1s",
      trigger_on: "change",
    });

    const events: DaemonEvent[] = [];

    const collect = (async () => {
      for await (const event of source.events()) {
        events.push(event);
        // Collect just 1 event (the baseline), then stop
        await source.stop();
      }
    })();

    await collect;

    expect(events.length).toBe(1);
    const payload = events[0]!.payload as CommandPayload;
    expect(payload.type).toBe("command");
    expect(payload.stdout.trim()).toBe("baseline");
    expect(payload.exitCode).toBe(0);
    expect(payload.changed).toBe(false);
  }, 5000);

  test("change mode suppresses events when output is unchanged", async () => {
    const source = makeSource("cmd-no-change", {
      type: "command",
      command: "echo constant",
      interval: "1s",
      trigger_on: "change",
    });

    const events: DaemonEvent[] = [];
    let iterations = 0;

    // We need to track iterations manually since the source won't yield events
    // when output doesn't change. We'll stop after a timeout.
    const timeout = setTimeout(() => {
      void source.stop();
    }, 3500);

    for await (const event of source.events()) {
      events.push(event);
      iterations++;
    }

    clearTimeout(timeout);

    // Only 1 event should be emitted: the baseline (first run)
    // Subsequent runs have same output so no events emitted
    expect(events.length).toBe(1);
    expect((events[0]!.payload as CommandPayload).changed).toBe(false);
    expect((events[0]!.payload as CommandPayload).stdout.trim()).toBe("constant");
  }, 10000);

  test("stop() gracefully stops event stream", async () => {
    const source = makeSource("cmd-stop", {
      type: "command",
      command: "echo stopping",
      interval: "1s",
      trigger_on: "always",
    });

    const events: DaemonEvent[] = [];

    // Stop after a brief delay (before first command can run)
    setTimeout(() => {
      void source.stop();
    }, 100);

    for await (const event of source.events()) {
      events.push(event);
    }

    // The command might finish before stop or not, so we just verify it ended
    expect(events.length).toBeLessThanOrEqual(1);
  }, 5000);

  test("captures non-zero exit codes", async () => {
    const source = makeSource("cmd-exit", {
      type: "command",
      command: "exit 42",
      interval: "1s",
      trigger_on: "always",
    });

    const events: DaemonEvent[] = [];

    const collect = (async () => {
      for await (const event of source.events()) {
        events.push(event);
        if (events.length >= 1) {
          await source.stop();
        }
      }
    })();

    await collect;

    expect(events.length).toBe(1);
    const payload = events[0]!.payload as CommandPayload;
    expect(payload.exitCode).toBe(42);
    expect(payload.stdout).toBe("");
  }, 5000);

  test("runs command in provided cwd", async () => {
    const tmpDir = await mkdtemp(path.join(tmpdir(), "cmd-cwd-"));
    await writeFile(path.join(tmpDir, "foo.txt"), "hello");

    const source = new CommandSource(
      "cmd-cwd",
      {
        type: "command",
        command: "cat foo.txt",
        interval: "1s",
        trigger_on: "always",
      },
      tmpDir,
    );
    sources.push(source);

    const events: DaemonEvent[] = [];
    const collect = (async () => {
      for await (const event of source.events()) {
        events.push(event);
        await source.stop();
      }
    })();
    await collect;

    expect(events.length).toBe(1);
    const payload = events[0]!.payload as CommandPayload;
    expect(payload.stdout.trim()).toBe("hello");

    await rm(tmpDir, { recursive: true, force: true });
  }, 10000);
});
