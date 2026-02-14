import { describe, test, expect } from "bun:test";

import {
  parseCompletionDecision,
  parseCompletionDecisionFromFile,
} from "../../../src/workflow/completion-decision.js";

describe("parseCompletionDecision", () => {
  test("returns fail on empty", () => {
    expect(parseCompletionDecision("")).toBe("fail");
    expect(parseCompletionDecision("\n\n")).toBe("fail");
  });

  test("detects COMPLETE marker", () => {
    expect(parseCompletionDecision("COMPLETE\n")).toBe("complete");
    expect(parseCompletionDecision("some text\nCOMPLETE\nmore\n")).toBe("complete");
  });

  test("detects INCOMPLETE marker", () => {
    expect(parseCompletionDecision("INCOMPLETE\n")).toBe("incomplete");
    expect(parseCompletionDecision("foo\nINCOMPLETE\nbar\n")).toBe("incomplete");
  });

  test("does not confuse completed with COMPLETE", () => {
    expect(parseCompletionDecision('{"type":"turn.completed"}\n')).toBe("fail");
    expect(parseCompletionDecision('{"type":"item.completed"}\n')).toBe("fail");
  });

  test("detects markers inside JSON output", () => {
    const text = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"INCOMPLETE"}}',
      '{"type":"turn.completed"}',
    ].join("\n");
    expect(parseCompletionDecision(text)).toBe("incomplete");

    const text2 = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"COMPLETE"}}',
      '{"type":"turn.completed"}',
    ].join("\n");
    expect(parseCompletionDecision(text2)).toBe("complete");
  });
});

describe("parseCompletionDecisionFromFile", () => {
  test("maps PASS/FAIL", () => {
    expect(parseCompletionDecisionFromFile("PASS\n")).toBe("complete");
    expect(parseCompletionDecisionFromFile("FAIL\n")).toBe("incomplete");
  });

  test("maps COMPLETE/INCOMPLETE", () => {
    expect(parseCompletionDecisionFromFile("COMPLETE\n")).toBe("complete");
    expect(parseCompletionDecisionFromFile("INCOMPLETE\n")).toBe("incomplete");
  });

  test("returns fail on unknown", () => {
    expect(parseCompletionDecisionFromFile("maybe")).toBe("fail");
  });
});
