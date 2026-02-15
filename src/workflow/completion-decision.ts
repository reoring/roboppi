import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { WorkerResult } from "../types/index.js";
import type { CompletionCheckDef } from "./types.js";

export function extractWorkerText(result: WorkerResult): string {
  const parts: string[] = [];
  for (const o of result.observations ?? []) {
    if (o.summary) parts.push(o.summary);
  }
  return parts.join("\n");
}

export type CompletionDecision = "complete" | "incomplete" | "fail";
export type CompletionDecisionSource = "file-json" | "file-legacy" | "marker" | "none";

export interface CompletionDecisionResolution {
  decision: CompletionDecision;
  source: CompletionDecisionSource;
  reason?: string;
  checkIdMatch?: boolean;

  /** Optional: structured diagnostics produced by completion_check. */
  reasons?: string[];
  fingerprints?: string[];
}

export const COMPLETION_CHECK_ID_ENV = "AGENTCORE_COMPLETION_CHECK_ID";
const STALE_DECISION_FILE_GRACE_MS = 2_000;

const RE_COMPLETE = /\bCOMPLETE\b/i;
const RE_INCOMPLETE = /\bINCOMPLETE\b/i;
const RE_FAIL = /\bFAIL(?:ED)?\b/i;

type StructuredDecisionFile = {
  decision?: unknown;
  status?: unknown;
  result?: unknown;
  check_id?: unknown;
  reasons?: unknown;
  fingerprints?: unknown;
};

const MAX_STRUCTURED_LIST_ITEMS = 200;
const MAX_STRUCTURED_ITEM_LEN = 240;

function parseDecisionValue(value: unknown): CompletionDecision | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "complete" || normalized === "pass") return "complete";
  if (normalized === "incomplete" || normalized === "fail" || normalized === "failed") return "incomplete";
  return null;
}

export function parseCompletionDecision(text: string): CompletionDecision {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return "fail";

  // Prefer explicit markers anywhere in the output.
  // Use word-boundary checks to avoid false positives like "turn.completed".
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (RE_INCOMPLETE.test(line)) return "incomplete";
    if (RE_COMPLETE.test(line)) return "complete";
    if (RE_FAIL.test(line)) return "incomplete";
  }

  return "fail";
}

export function parseCompletionDecisionFromFile(content: string): CompletionDecision {
  const v = content.trim().toUpperCase();
  if (v === "COMPLETE" || v === "PASS") return "complete";
  if (v === "INCOMPLETE" || v === "FAIL") return "incomplete";
  return "fail";
}

export async function resolveCompletionDecision(
  check: CompletionCheckDef,
  workspaceDir: string,
  checkStartedAt: number,
  result: WorkerResult,
  checkId?: string,
): Promise<CompletionDecisionResolution> {
  const text = extractWorkerText(result);

  let fileFailureReason: string | undefined;
  if (check.decision_file) {
    const fileDecision = await tryDecisionFromFile(
      check.decision_file,
      workspaceDir,
      checkStartedAt,
      checkId,
    );
    if (fileDecision.decision === "complete" || fileDecision.decision === "incomplete") {
      return fileDecision;
    }
    fileFailureReason = fileDecision.reason;
  }

  const markerDecision = parseCompletionDecision(text);
  if (markerDecision !== "fail") {
    return {
      decision: markerDecision,
      source: "marker",
    };
  }

  return {
    decision: "fail",
    source: "none",
    reason: fileFailureReason
      ?? "could not parse completion decision (expected COMPLETE/INCOMPLETE marker)",
  };
}

async function tryDecisionFromFile(
  relPath: string,
  workspaceDir: string,
  checkStartedAt: number,
  checkId?: string,
): Promise<CompletionDecisionResolution> {
  const full = resolveWithin(workspaceDir, relPath);
  const st = await stat(full).catch(() => null);
  if (!st) {
    return {
      decision: "fail",
      source: "none",
      reason: "decision_file missing",
    };
  }

  const content = await readFile(full, "utf-8").catch(() => "");
  const structured = parseStructuredDecisionFromFile(content);

  if (structured) {
    if (structured.decision === "complete" || structured.decision === "incomplete") {
      if (checkId && structured.checkId) {
        if (structured.checkId !== checkId) {
          return {
            decision: "fail",
            source: "file-json",
            reason: `stale decision_file check_id mismatch (got ${structured.checkId}, expected ${checkId})`,
            checkIdMatch: false,
          };
        }

        return {
          decision: structured.decision,
          source: "file-json",
          checkIdMatch: true,
          ...(structured.reasons ? { reasons: structured.reasons } : {}),
          ...(structured.fingerprints ? { fingerprints: structured.fingerprints } : {}),
        };
      }

      if (checkId && st.mtimeMs + STALE_DECISION_FILE_GRACE_MS < checkStartedAt) {
        return {
          decision: "fail",
          source: "file-json",
          reason: "decision_file is stale",
          checkIdMatch: false,
        };
      }

      return {
        decision: structured.decision,
        source: "file-json",
        ...(structured.reasons ? { reasons: structured.reasons } : {}),
        ...(structured.fingerprints ? { fingerprints: structured.fingerprints } : {}),
      };
    }
  }

  const legacy = parseCompletionDecisionFromFile(content);
  if (legacy !== "fail") {
    if (checkId && st.mtimeMs + STALE_DECISION_FILE_GRACE_MS < checkStartedAt) {
      return {
        decision: "fail",
        source: "file-legacy",
        reason: "decision_file is stale",
        checkIdMatch: false,
      };
    }

    return {
      decision: legacy,
      source: "file-legacy",
    };
  }

  return {
    decision: "fail",
    source: "file-json",
    reason: "decision_file has unsupported format",
  };
}

function parseStructuredDecisionFromFile(content: string): {
  decision: CompletionDecision;
  checkId?: string;
  reasons?: string[];
  fingerprints?: string[];
} | null {
  const trimmed = content.trim();
  if (!trimmed || !trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    return null;
  }

  const d = parsed as StructuredDecisionFile;
  const value = parseDecisionValue(
    d.decision ?? d.status ?? d.result,
  );
  if (value === null) return null;

  const checkId = typeof d.check_id === "string" && d.check_id.trim().length > 0
    ? d.check_id.trim()
    : undefined;

  const reasons = normalizeStructuredStringList(d.reasons);
  const fingerprints = normalizeStructuredStringList(d.fingerprints);

  return {
    decision: value,
    checkId,
    ...(reasons ? { reasons } : {}),
    ...(fingerprints ? { fingerprints } : {}),
  };
}

function normalizeStructuredStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== "string") return;
    const s = v.trim();
    if (!s) return;
    out.push(s.length > MAX_STRUCTURED_ITEM_LEN ? s.slice(0, MAX_STRUCTURED_ITEM_LEN) : s);
  };

  if (typeof value === "string") {
    push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      push(item);
      if (out.length >= MAX_STRUCTURED_LIST_ITEMS) break;
    }
  }

  if (out.length === 0) return undefined;
  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const s of out) {
    if (seen.has(s)) continue;
    seen.add(s);
    deduped.push(s);
  }
  return deduped;
}

function resolveWithin(baseDir: string, relPath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(baseDir, relPath);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Path traversal detected: ${relPath}`);
  }
  return resolved;
}
