import { describe, test, expect } from "bun:test";
import { ansiWrap } from "../../../src/tui/ansi-utils.js";

describe("ansiWrap", () => {
  test("wraps plain text by visible width", () => {
    expect(ansiWrap("abcdefghij", 5)).toEqual(["abcde", "fghij"]);
  });

  test("wraps across newlines", () => {
    expect(ansiWrap("ab\ncd", 1)).toEqual(["a", "b", "c", "d"]);
  });

  test("treats ANSI SGR as zero-width", () => {
    const s = "\x1b[31mred\x1b[0mblue";
    expect(ansiWrap(s, 4)).toEqual(["\x1b[31mred\x1b[0mb", "lue"]);
  });

  test("handles fullwidth characters", () => {
    expect(ansiWrap("あい", 2)).toEqual(["あ", "い"]);
  });

  test("keeps combining marks attached", () => {
    expect(ansiWrap("e\u0301", 1)).toEqual(["e\u0301"]);
  });

  test("width <= 0 yields a single empty line", () => {
    expect(ansiWrap("abc", 0)).toEqual([""]);
    expect(ansiWrap("abc", -10)).toEqual([""]);
  });
});
