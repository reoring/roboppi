import { describe, test, expect } from "bun:test";
import { RingBuffer } from "../../../src/tui/ring-buffer.js";

describe("RingBuffer", () => {
  test("pushes and retrieves items in insertion order", () => {
    const buf = new RingBuffer<string>({ maxLines: 10 });
    buf.push("a");
    buf.push("b");
    buf.push("c");
    expect(buf.lines()).toEqual(["a", "b", "c"]);
  });

  test("evicts oldest when maxLines exceeded", () => {
    const buf = new RingBuffer<string>({ maxLines: 3 });
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d");
    expect(buf.lines()).toEqual(["b", "c", "d"]);
    expect(buf.length).toBe(3);
  });

  test("evicts oldest when maxBytes exceeded", () => {
    // Each item is 5 chars, maxBytes=12 means at most 2 items fit
    const buf = new RingBuffer<string>({ maxLines: 100, maxBytes: 12 });
    buf.push("aaaaa"); // 5 bytes, total=5
    buf.push("bbbbb"); // 5 bytes, total=10
    buf.push("ccccc"); // 5 bytes, total=15 > 12, evict "aaaaa" => total=10
    expect(buf.lines()).toEqual(["bbbbb", "ccccc"]);
    expect(buf.totalBytes).toBe(10);
  });

  test("handles combined line and byte limits", () => {
    // maxLines=5, maxBytes=8
    const buf = new RingBuffer<string>({ maxLines: 5, maxBytes: 8 });
    buf.push("aaa"); // 3 bytes
    buf.push("bbb"); // 3 bytes, total=6
    buf.push("ccc"); // 3 bytes, total=9 > 8, evict "aaa" => total=6
    expect(buf.lines()).toEqual(["bbb", "ccc"]);
    expect(buf.length).toBe(2);
    expect(buf.totalBytes).toBe(6);
  });

  test("clear() resets state", () => {
    const buf = new RingBuffer<string>({ maxLines: 10 });
    buf.push("a");
    buf.push("b");
    buf.clear();
    expect(buf.lines()).toEqual([]);
    expect(buf.length).toBe(0);
    expect(buf.totalBytes).toBe(0);
  });

  test("length and totalBytes track correctly", () => {
    const buf = new RingBuffer<string>({ maxLines: 10 });
    expect(buf.length).toBe(0);
    expect(buf.totalBytes).toBe(0);

    buf.push("hello"); // 5 bytes
    expect(buf.length).toBe(1);
    expect(buf.totalBytes).toBe(5);

    buf.push("world!"); // 6 bytes
    expect(buf.length).toBe(2);
    expect(buf.totalBytes).toBe(11);
  });

  test("works with empty buffer", () => {
    const buf = new RingBuffer<string>({ maxLines: 10 });
    expect(buf.lines()).toEqual([]);
    expect(buf.length).toBe(0);
    expect(buf.totalBytes).toBe(0);
  });

  test("uses default limits when no options provided", () => {
    const buf = new RingBuffer<string>();
    // Should not throw when pushing items
    for (let i = 0; i < 100; i++) {
      buf.push(`line ${i}`);
    }
    expect(buf.length).toBe(100);
  });

  test("lines() returns a copy, not the internal buffer", () => {
    const buf = new RingBuffer<string>({ maxLines: 10 });
    buf.push("a");
    const snapshot = buf.lines();
    buf.push("b");
    expect(snapshot).toEqual(["a"]);
    expect(buf.lines()).toEqual(["a", "b"]);
  });
});
