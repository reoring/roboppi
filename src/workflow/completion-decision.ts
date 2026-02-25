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
export type CompletionDecisionSource =
  | "file-json"
  | "file-text"
  | "stdout-json"
  | "marker"
  | "none";

export interface CompletionDecisionResolution {
  decision: CompletionDecision;
  source: CompletionDecisionSource;
  reason?: string;
  checkIdMatch?: boolean;

  /** Optional: structured diagnostics produced by completion_check. */
  reasons?: string[];
  fingerprints?: string[];
}

// Completion-check correlation id.
export const COMPLETION_CHECK_ID_ENV = "ROBOPPI_COMPLETION_CHECK_ID";
const STALE_DECISION_FILE_GRACE_MS = 2_000;

export function interpolateCompletionCheckId(instructions: string, checkId: string): string {
  if (!instructions) return instructions;
  const a = `$${COMPLETION_CHECK_ID_ENV}`;
  const b = "${" + COMPLETION_CHECK_ID_ENV + "}";
  return instructions.replaceAll(a, checkId).replaceAll(b, checkId);
}

type StructuredDecisionFile = {
  decision?: unknown;
  check_id?: unknown;
  checkId?: unknown;
  reasons?: unknown;
  fingerprints?: unknown;
};

const MAX_STRUCTURED_LIST_ITEMS = 200;
const MAX_STRUCTURED_ITEM_LEN = 240;

function parseDecisionValue(value: unknown): CompletionDecision | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "complete") return "complete";
  if (normalized === "incomplete") return "incomplete";
  return null;
}

function parseMarkerValue(value: string): CompletionDecision | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "complete" || normalized === "pass") return "complete";
  if (normalized === "incomplete" || normalized === "fail" || normalized === "failed") return "incomplete";
  return null;
}

function findDecisionMarker(text: string): { decision: CompletionDecision; marker: string } | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw) continue;
    const line = raw.trim();
    if (!line) continue;

    // Exact marker line: COMPLETE / INCOMPLETE / PASS / FAIL
    let m = /^(COMPLETE|INCOMPLETE|PASS|FAIL|FAILED)\s*$/i.exec(line);
    if (m) {
      const decision = parseMarkerValue(m[1]!);
      if (decision) return { decision, marker: m[1]!.toUpperCase() };
      continue;
    }

    // Prefixed marker line: VERDICT: PASS
    m = /^(?:VERDICT|DECISION)\s*[:=]\s*(COMPLETE|INCOMPLETE|PASS|FAIL|FAILED)\b/i.exec(line);
    if (m) {
      const decision = parseMarkerValue(m[1]!);
      if (decision) return { decision, marker: m[1]!.toUpperCase() };
      continue;
    }

    // Leading marker token: INCOMPLETE: <reason>
    m = /^(COMPLETE|INCOMPLETE|PASS|FAIL|FAILED)\b/i.exec(line);
    if (m) {
      const decision = parseMarkerValue(m[1]!);
      if (decision) return { decision, marker: m[1]!.toUpperCase() };
    }
  }
  return null;
}

export async function resolveCompletionDecision(
  check: CompletionCheckDef,
  workspaceDir: string,
  checkStartedAt: number,
  checkId?: string,
  workerText?: string,
): Promise<CompletionDecisionResolution> {
  const fileRes = check.decision_file
    ? await tryDecisionFromFile(
      check.decision_file,
      workspaceDir,
      checkStartedAt,
      checkId,
    )
    : null;

  if (fileRes && (fileRes.decision === "complete" || fileRes.decision === "incomplete")) {
    return fileRes;
  }

  const text = workerText?.trim();
  if (text) {
    const outRes = tryDecisionFromWorkerText(text, checkId);
    if (outRes) return outRes;
  }

  if (fileRes) return fileRes;
  return {
    decision: "fail",
    source: "none",
    reason: "could not parse completion decision (expected decision_file or output marker)",
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
  const trimmed = content.trim();

  if (!trimmed) {
    return {
      decision: "fail",
      source: "file-text",
      reason: "decision_file empty",
    };
  }

  // Structured JSON (preferred)
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const structured = parseStructuredDecisionFromJsonText(trimmed);
    if (!structured) {
      return {
        decision: "fail",
        source: "file-json",
        reason: "decision_file invalid JSON or missing decision",
      };
    }

    const checked = applyCheckIdToDecision(structured, checkId, st.mtimeMs, checkStartedAt, "file-json");
    if (checked) return checked;
    // If check_id mismatched or the file was stale, fall back to other channels.
  } else {
    // Compatibility text marker
    const marker = findDecisionMarker(trimmed);
    if (marker) {
      if (checkId && st.mtimeMs + STALE_DECISION_FILE_GRACE_MS < checkStartedAt) {
        return {
          decision: "fail",
          source: "file-text",
          reason: "decision_file is stale",
          checkIdMatch: false,
        };
      }
      return {
        decision: marker.decision,
        source: "file-text",
      };
    }
  }

  return {
    decision: "fail",
    source: trimmed.startsWith("{") ? "file-json" : "file-text",
    reason: "decision_file has no supported decision (expected JSON or PASS/FAIL/COMPLETE/INCOMPLETE)",
  };
}

function tryDecisionFromWorkerText(workerText: string, checkId?: string): CompletionDecisionResolution | null {
  // Structured JSON on stdout (recommended when decision_file is not available).
  const structured = parseStructuredDecisionFromLines(workerText, checkId);
  if (structured) return structured;

  // Compatibility marker on stdout.
  const marker = findDecisionMarker(workerText);
  if (marker) {
    return {
      decision: marker.decision,
      source: "marker",
    };
  }

  return null;
}

function applyCheckIdToDecision(
  structured: {
    decision: CompletionDecision;
    checkId?: string;
    reasons?: string[];
    fingerprints?: string[];
  },
  checkId: string | undefined,
  mtimeMs: number,
  checkStartedAt: number,
  source: CompletionDecisionSource,
): CompletionDecisionResolution | null {
  if (structured.decision !== "complete" && structured.decision !== "incomplete") return null;

  if (checkId && structured.checkId) {
    if (structured.checkId !== checkId) {
      return {
        decision: "fail",
        source,
        reason: `stale decision check_id mismatch (got ${structured.checkId}, expected ${checkId})`,
        checkIdMatch: false,
      };
    }
    return {
      decision: structured.decision,
      source,
      checkIdMatch: true,
      ...(structured.reasons ? { reasons: structured.reasons } : {}),
      ...(structured.fingerprints ? { fingerprints: structured.fingerprints } : {}),
    };
  }

  if (checkId && mtimeMs + STALE_DECISION_FILE_GRACE_MS < checkStartedAt) {
    return {
      decision: "fail",
      source,
      reason: "decision is stale",
      checkIdMatch: false,
    };
  }

  return {
    decision: structured.decision,
    source,
    ...(structured.reasons ? { reasons: structured.reasons } : {}),
    ...(structured.fingerprints ? { fingerprints: structured.fingerprints } : {}),
  };
}

function parseStructuredDecisionFromLines(
  workerText: string,
  checkId?: string,
): CompletionDecisionResolution | null {
  const lines = workerText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!raw) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    if (trimmed.length > 10_000) continue;

    const parsed = parseStructuredDecisionFromJsonText(trimmed);
    if (!parsed) continue;
    if (checkId && parsed.checkId && parsed.checkId !== checkId) {
      // Ignore mismatched candidates and keep scanning.
      continue;
    }
    return {
      decision: parsed.decision,
      source: "stdout-json",
      ...(checkId && parsed.checkId
        ? { checkIdMatch: parsed.checkId === checkId }
        : {}),
      ...(parsed.reasons ? { reasons: parsed.reasons } : {}),
      ...(parsed.fingerprints ? { fingerprints: parsed.fingerprints } : {}),
    };
  }
  return null;
}

function parseStructuredDecisionFromJsonText(content: string): {
  decision: CompletionDecision;
  checkId?: string;
  reasons?: string[];
  fingerprints?: string[];
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
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
  const value = parseDecisionValue(d.decision);
  if (value === null) return null;

  const fileCheckId =
    typeof d.check_id === "string" && d.check_id.trim().length > 0
      ? d.check_id.trim()
      : typeof d.checkId === "string" && d.checkId.trim().length > 0
        ? d.checkId.trim()
        : undefined;

  const reasons = normalizeStructuredStringList(d.reasons);
  const fingerprints = normalizeStructuredStringList(d.fingerprints);

  return {
    decision: value,
    ...(fileCheckId ? { checkId: fileCheckId } : {}),
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
