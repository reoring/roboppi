import { describe, test, expect } from "bun:test";
import { JobEventThrottle } from "../../../src/core/job-event-throttle.js";
import type { WorkerEvent } from "../../../src/worker/worker-adapter.js";

describe("JobEventThrottle", () => {
  describe("stdout/stderr filtering", () => {
    test("drops stdout by default", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      throttle.emit({ type: "stdout", data: "hello" });
      expect(forwarded).toHaveLength(0);
    });

    test("drops stderr by default", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      throttle.emit({ type: "stderr", data: "err" });
      expect(forwarded).toHaveLength(0);
    });

    test("forwards stdout when forwardStdio is true", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev), { forwardStdio: true });

      throttle.emit({ type: "stdout", data: "hello" });
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toEqual({ type: "stdout", data: "hello" });
    });

    test("forwards stderr when forwardStdio is true", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev), { forwardStdio: true });

      throttle.emit({ type: "stderr", data: "err" });
      expect(forwarded).toHaveLength(1);
    });

    test("always forwards progress regardless of forwardStdio", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      throttle.emit({ type: "progress", message: "step 1" });
      expect(forwarded).toHaveLength(1);
    });

    test("always forwards patch regardless of forwardStdio", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      throttle.emit({ type: "patch", filePath: "foo.ts", diff: "+line" });
      expect(forwarded).toHaveLength(1);
    });
  });

  describe("event data truncation", () => {
    test("truncates stdout data exceeding 16KB", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev), { forwardStdio: true });

      const bigData = "x".repeat(20_000);
      throttle.emit({ type: "stdout", data: bigData });

      expect(forwarded).toHaveLength(1);
      const ev = forwarded[0] as { type: "stdout"; data: string };
      expect(Buffer.byteLength(ev.data, "utf8")).toBeLessThanOrEqual(16 * 1024 + 20);
      expect(ev.data).toEndWith("...(truncated)");
    });

    test("truncates stderr data exceeding 16KB", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev), { forwardStdio: true });

      throttle.emit({ type: "stderr", data: "e".repeat(20_000) });

      const ev = forwarded[0] as { type: "stderr"; data: string };
      expect(ev.data).toEndWith("...(truncated)");
    });

    test("truncates progress message exceeding 16KB", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      throttle.emit({ type: "progress", message: "m".repeat(20_000) });
      expect(forwarded).toHaveLength(1);

      const ev = forwarded[0] as { type: "progress"; message: string };
      expect(ev.message).toEndWith("...(truncated)");
    });

    test("truncates patch diff at 256KB", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      throttle.emit({ type: "patch", filePath: "foo.ts", diff: "d".repeat(300_000) });

      const ev = forwarded[0] as { type: "patch"; filePath: string; diff: string };
      expect(Buffer.byteLength(ev.diff, "utf8")).toBeLessThanOrEqual(256 * 1024 + 20);
      expect(ev.diff).toEndWith("...(truncated)");
      expect(ev.filePath).toBe("foo.ts");
    });

    test("does not truncate data within limits", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev), { forwardStdio: true });

      const data = "x".repeat(100);
      throttle.emit({ type: "stdout", data });
      expect((forwarded[0] as { type: "stdout"; data: string }).data).toBe(data);
    });

    test("handles multibyte characters correctly", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      // Japanese characters: each is 3 bytes in UTF-8
      const multibyteData = "あ".repeat(6000); // 18,000 bytes > 16KB
      throttle.emit({ type: "progress", message: multibyteData });

      const ev = forwarded[0] as { type: "progress"; message: string };
      expect(Buffer.byteLength(ev.message, "utf8")).toBeLessThanOrEqual(16 * 1024 + 20);
      expect(ev.message).toEndWith("...(truncated)");
    });
  });

  describe("per-job queue limit", () => {
    test("forwards up to 500 non-progress events", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      for (let i = 0; i < 500; i++) {
        throttle.emit({ type: "patch", filePath: `file${i}.ts`, diff: `+line ${i}` });
      }

      expect(forwarded).toHaveLength(500);
    });

    test("drops non-progress events after 500 and sends one truncation notice", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      for (let i = 0; i < 600; i++) {
        throttle.emit({ type: "patch", filePath: `file${i}.ts`, diff: `+line ${i}` });
      }

      // 500 regular + 1 truncation notice
      expect(forwarded).toHaveLength(501);
      const lastEvent = forwarded[500]!;
      expect(lastEvent.type).toBe("progress");
      expect((lastEvent as { type: "progress"; message: string }).message).toBe("(logs truncated)");
    });

    test("sends truncation notice only once", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      for (let i = 0; i < 1000; i++) {
        throttle.emit({ type: "patch", filePath: `file${i}.ts`, diff: `+line ${i}` });
      }

      const truncationEvents = forwarded.filter(
        (ev) => ev.type === "progress" && (ev as { message: string }).message === "(logs truncated)",
      );
      expect(truncationEvents).toHaveLength(1);
      expect(forwarded).toHaveLength(501);
    });

    test("progress events bypass the queue limit", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      // Exhaust the non-progress budget
      for (let i = 0; i < 500; i++) {
        throttle.emit({ type: "patch", filePath: `file${i}.ts`, diff: `+line ${i}` });
      }
      expect(forwarded).toHaveLength(500);

      // Progress should still come through even after budget exhaustion
      // (wait >100ms so throttle doesn't buffer it)
      throttle.emit({ type: "progress", message: "still alive" });
      expect(forwarded).toHaveLength(501);
      const progressEvent = forwarded[500]!;
      expect(progressEvent.type).toBe("progress");
      expect((progressEvent as { type: "progress"; message: string }).message).toBe("still alive");
    });
  });

  describe("progress throttling", () => {
    test("forwards first progress event immediately", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      throttle.emit({ type: "progress", message: "step 1" });

      expect(forwarded).toHaveLength(1);
      expect((forwarded[0] as { type: "progress"; message: string }).message).toBe("step 1");
    });

    test("buffers rapid progress events and flushes latest", async () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      // First event goes through immediately
      throttle.emit({ type: "progress", message: "step 1" });
      expect(forwarded).toHaveLength(1);

      // Rapid-fire progress events should be buffered
      throttle.emit({ type: "progress", message: "step 2" });
      throttle.emit({ type: "progress", message: "step 3" });

      // Only step 1 should have been forwarded so far
      expect(forwarded).toHaveLength(1);

      // Wait for throttle flush
      await new Promise((r) => setTimeout(r, 150));

      // After throttle period, the LATEST buffered event should be forwarded
      expect(forwarded).toHaveLength(2);
      expect((forwarded[1] as { type: "progress"; message: string }).message).toBe("step 3");
    });

    test("non-progress events pass through while progress is throttled", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      throttle.emit({ type: "progress", message: "step 1" });
      throttle.emit({ type: "patch", filePath: "foo.ts", diff: "+line" });

      // progress went through immediately, patch should also go through
      expect(forwarded).toHaveLength(2);
      expect(forwarded[0]!.type).toBe("progress");
      expect(forwarded[1]!.type).toBe("patch");
    });
  });

  describe("dispose", () => {
    test("flushes pending progress on dispose", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      // First progress goes through
      throttle.emit({ type: "progress", message: "step 1" });
      // Second is buffered
      throttle.emit({ type: "progress", message: "step 2" });

      expect(forwarded).toHaveLength(1);

      throttle.dispose();

      expect(forwarded).toHaveLength(2);
      expect((forwarded[1] as { type: "progress"; message: string }).message).toBe("step 2");
    });

    test("dispose is safe to call when no pending events", () => {
      const forwarded: WorkerEvent[] = [];
      const throttle = new JobEventThrottle((ev) => forwarded.push(ev));

      // No events emitted — dispose should not throw
      throttle.dispose();
      expect(forwarded).toHaveLength(0);
    });
  });
});
