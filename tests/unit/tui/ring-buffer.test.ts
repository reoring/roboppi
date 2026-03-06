import { describe, it, expect } from "bun:test";
import { RingBuffer } from "../../../src/tui/ring-buffer.js";

describe("RingBuffer.last()", () => {
  it("returns undefined for empty buffer", () => {
    const buf = new RingBuffer<string>({ maxLines: 10 });
    expect(buf.last()).toBeUndefined();
  });

  it("returns the most recently pushed item", () => {
    const buf = new RingBuffer<string>({ maxLines: 10 });
    buf.push("first");
    buf.push("second");
    buf.push("third");
    expect(buf.last()).toBe("third");
  });

  it("returns the last item after eviction", () => {
    const buf = new RingBuffer<string>({ maxLines: 2 });
    buf.push("a");
    buf.push("b");
    buf.push("c");
    expect(buf.last()).toBe("c");
    expect(buf.length).toBe(2);
  });
});
