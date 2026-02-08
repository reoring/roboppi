import { describe, it, expect } from "bun:test";
import { parseDuration } from "../../../src/workflow/duration.js";

describe("parseDuration", () => {
  it("parses seconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("1s")).toBe(1_000);
    expect(parseDuration("120s")).toBe(120_000);
  });

  it("parses minutes", () => {
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1m")).toBe(60_000);
    expect(parseDuration("90m")).toBe(5_400_000);
  });

  it("parses hours", () => {
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  it("parses combined durations", () => {
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("1h0m30s")).toBe(3_630_000);
    expect(parseDuration("2h15m")).toBe(8_100_000);
    expect(parseDuration("1m30s")).toBe(90_000);
  });

  it("parses full h/m/s combination", () => {
    expect(parseDuration("1h2m3s")).toBe(3_723_000);
  });

  it("throws on empty string", () => {
    expect(() => parseDuration("")).toThrow("Invalid duration string");
  });

  it("throws on whitespace only", () => {
    expect(() => parseDuration("   ")).toThrow("Invalid duration string");
  });

  it("throws on invalid format", () => {
    expect(() => parseDuration("abc")).toThrow("Invalid duration string");
    expect(() => parseDuration("5")).toThrow("Invalid duration string");
    expect(() => parseDuration("5d")).toThrow("Invalid duration string");
    expect(() => parseDuration("m5")).toThrow("Invalid duration string");
  });

  it("throws on zero duration", () => {
    expect(() => parseDuration("0s")).toThrow("Invalid duration string");
    expect(() => parseDuration("0m")).toThrow("Invalid duration string");
    expect(() => parseDuration("0h")).toThrow("Invalid duration string");
  });

  it("handles trimming", () => {
    expect(parseDuration("  5m  ")).toBe(300_000);
  });
});
