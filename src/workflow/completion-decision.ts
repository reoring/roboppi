import type { WorkerResult } from "../types/index.js";

export function extractWorkerText(result: WorkerResult): string {
  const parts: string[] = [];
  for (const o of result.observations ?? []) {
    if (o.summary) parts.push(o.summary);
  }
  return parts.join("\n");
}

export type CompletionDecision = "complete" | "incomplete" | "fail";

export function parseCompletionDecision(text: string): CompletionDecision {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "fail";

  // Prefer explicit markers anywhere in the output.
  // Use word-boundary checks to avoid false positives like "turn.completed".
  const reIncomplete = /\bINCOMPLETE\b/i;
  const reComplete = /\bCOMPLETE\b/i;
  const reFail = /\bFAIL(?:ED)?\b/i;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (reIncomplete.test(line)) return "incomplete";
    if (reComplete.test(line)) return "complete";
    if (reFail.test(line)) return "fail";
  }

  return "fail";
}
