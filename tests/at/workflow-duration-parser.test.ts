/**
 * AT-8: DurationString parser
 */
import { describe, it, expect } from "bun:test";
import { parseDuration } from "../../src/workflow/duration.js";

describe("AT-8: DurationString parser", () => {
  it('parses "5s" to 5000ms', () => {
    expect(parseDuration("5s")).toBe(5000);
  });

  it('parses "30s" to 30000ms', () => {
    expect(parseDuration("30s")).toBe(30000);
  });

  it('parses "5m" to 300000ms', () => {
    expect(parseDuration("5m")).toBe(300000);
  });

  it('parses "2h" to 7200000ms', () => {
    expect(parseDuration("2h")).toBe(7200000);
  });

  it('parses "1h30m" to 5400000ms', () => {
    expect(parseDuration("1h30m")).toBe(5400000);
  });

  it('parses "1h30m45s" to 5445000ms', () => {
    expect(parseDuration("1h30m45s")).toBe(5445000);
  });

  it('throws on empty string ""', () => {
    expect(() => parseDuration("")).toThrow();
  });

  it('throws on "0s"', () => {
    expect(() => parseDuration("0s")).toThrow();
  });

  it('throws on "abc"', () => {
    expect(() => parseDuration("abc")).toThrow();
  });

  it('throws on "5x" (invalid unit)', () => {
    expect(() => parseDuration("5x")).toThrow();
  });

  it('throws on "-5m" (negative)', () => {
    expect(() => parseDuration("-5m")).toThrow();
  });
});
