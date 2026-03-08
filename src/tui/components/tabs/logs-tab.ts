import type { StepUiState } from "../../state-store.js";
import { ansiWrap, ansiWidth, sanitizeForTui } from "../../ansi-utils.js";

export function renderLogsTab(
  step: StepUiState | undefined,
  width: number,
  height: number,
): string {
  if (!step) {
    return padLines(["\x1b[90mNo step selected\x1b[0m"], height);
  }

  // Merge all log sources
  const entries: { channel: string; line: string }[] = [];

  for (const line of step.logs.stdout.lines()) {
    entries.push(...expandLogEntry("worker_stdout", line));
  }
  for (const line of step.logs.stderr.lines()) {
    entries.push(...expandLogEntry("worker_stderr", line));
  }
  for (const line of step.logs.progress.lines()) {
    entries.push(...expandLogEntry("worker_progress", line));
  }

  if (entries.length === 0) {
    return padLines(["\x1b[90mNo logs yet\x1b[0m"], height);
  }

  const lines: string[] = [];

  // Build the last N physical lines with wrapping.
  for (let idx = entries.length - 1; idx >= 0 && lines.length < height; idx--) {
    const e = entries[idx]!;
    const prefix = getChannelPrefix(e.channel);
    const prefixW = ansiWidth(prefix);
    const available = Math.max(0, width - prefixW - 1);

    const safe = sanitizeForTui(e.line);
    const chunks = ansiWrap(safe, available);

    const contPrefix = " ".repeat(prefixW) + " ";
    const entryLines: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const p = i === 0 ? `${prefix} ` : contPrefix;
      entryLines.push(p + (chunks[i] ?? ""));
    }

    // Prepend only what we still need.
    const remaining = height - lines.length;
    const take = entryLines.slice(Math.max(0, entryLines.length - remaining));
    for (let i = take.length - 1; i >= 0; i--) {
      lines.unshift(take[i]!);
    }
  }

  return padLines(lines, height);
}

function getChannelPrefix(channel: string): string {
  switch (channel) {
    case "worker_stdout": return "\x1b[90m[worker stdout]\x1b[0m";
    case "worker_stderr": return "\x1b[31m[worker stderr]\x1b[0m";
    case "worker_progress": return "\x1b[36m[worker progress]\x1b[0m";
    case "llm_message": return "\x1b[32m[message]\x1b[0m";
    case "llm_thinking": return "\x1b[35m[thinking]\x1b[0m";
    case "llm_tool_call": return "\x1b[33m[tool call]\x1b[0m";
    case "llm_usage": return "\x1b[36m[usage]\x1b[0m";
    case "llm_result": return "\x1b[32m[result]\x1b[0m";
    case "llm_turn": return "\x1b[34m[turn]\x1b[0m";
    case "roboppi_note": return "\x1b[90m[roboppi note]\x1b[0m";
    default: return "\x1b[90m[unknown]\x1b[0m";
  }
}

function expandLogEntry(channel: string, line: string): Array<{ channel: string; line: string }> {
  if (channel === "worker_progress" && line === "(logs truncated)") {
    return [{ channel: "roboppi_note", line: "roboppi truncated worker logs after the per-job limit was reached" }];
  }

  const parsed = tryParseJson(line);
  if (!isRecord(parsed)) {
    return [{ channel, line }];
  }

  const expanded = summarizeStructuredEvent(parsed);
  return expanded.length > 0 ? expanded : [{ channel: inferUnknownChannel(parsed, channel), line: summarizeUnknownEvent(parsed) }];
}

function summarizeStructuredEvent(parsed: Record<string, unknown>): Array<{ channel: string; line: string }> {
  const entries: Array<{ channel: string; line: string }> = [];
  const part = isRecord(parsed.part) ? parsed.part : undefined;

  if (part) {
    entries.push(...summarizeNestedPart(parsed, part));
  }

  const progressMessage = typeof parsed.message === "string" ? parsed.message : undefined;
  if (parsed.type === "progress" && progressMessage) {
    entries.push({ channel: "worker_progress", line: progressMessage });
  }

  const resultSummary = getResultSummary(parsed);
  if (resultSummary) {
    entries.push({ channel: "llm_result", line: resultSummary });
  }

  const content = getContentItems(parsed);
  for (const item of content) {
    const summarized = summarizeContentItem(item);
    if (summarized) entries.push(summarized);
  }

  const usageSummary = getUsageSummary(parsed);
  if (usageSummary) {
    entries.push({ channel: "llm_usage", line: usageSummary });
  }

  if (entries.length === 0 && typeof parsed.result === "string") {
    entries.push({ channel: "llm_result", line: parsed.result });
  }

  return entries;
}

function summarizeNestedPart(
  outer: Record<string, unknown>,
  part: Record<string, unknown>,
): Array<{ channel: string; line: string }> {
  const entries: Array<{ channel: string; line: string }> = [];
  const rawType = typeof part.type === "string"
    ? part.type
    : (typeof outer.type === "string" ? outer.type : "");
  const type = rawType.replace(/_/g, "-");

  if (type === "step-start") {
    entries.push({ channel: "llm_turn", line: "llm turn started" });
    return entries;
  }

  if (type === "step-finish") {
    const reason = typeof part.reason === "string" ? part.reason : "completed";
    entries.push({ channel: "llm_turn", line: `llm turn finished: ${reason}` });

    const usage = getPartTokensSummary(part);
    const cost = typeof part.cost === "number" ? `cost=$${part.cost.toFixed(4)}` : undefined;
    if (usage || cost) {
      entries.push({
        channel: "llm_usage",
        line: [cost, usage].filter(Boolean).join(" "),
      });
    }
    return entries;
  }

  if (type === "tool") {
    entries.push({ channel: "llm_tool_call", line: summarizeNestedToolUse(part) });
    const resultLine = summarizeNestedToolResult(part);
    if (resultLine) {
      entries.push({ channel: "llm_result", line: resultLine });
    }
    return entries;
  }

  return entries;
}

function getContentItems(parsed: Record<string, unknown>): Record<string, unknown>[] {
  const direct = parsed.content;
  if (Array.isArray(direct)) {
    return direct.filter(isRecord);
  }

  const message = parsed.message;
  if (isRecord(message) && Array.isArray(message.content)) {
    return message.content.filter(isRecord);
  }

  return [];
}

function summarizeContentItem(item: Record<string, unknown>): { channel: string; line: string } | undefined {
  const type = typeof item.type === "string" ? item.type : undefined;
  if (!type) return undefined;

  if (type === "thinking" && typeof item.thinking === "string") {
    return { channel: "llm_thinking", line: truncateInline(item.thinking, 220) };
  }

  if (type === "text") {
    const text = typeof item.text === "string"
      ? item.text
      : (typeof item.content === "string" ? item.content : undefined);
    if (text) {
      return { channel: "llm_message", line: truncateInline(text, 220) };
    }
  }

  if (type === "tool_use") {
    return { channel: "llm_tool_call", line: summarizeToolUse(item) };
  }

  if (type === "tool_result") {
    const toolUseId = typeof item.tool_use_id === "string" ? item.tool_use_id : "tool";
    const content = typeof item.content === "string" ? truncateInline(item.content, 180) : "completed";
    return { channel: "llm_result", line: `${toolUseId}: ${content}` };
  }

  return undefined;
}

function summarizeToolUse(item: Record<string, unknown>): string {
  const name = typeof item.name === "string" ? item.name : "tool";
  const input = isRecord(item.input) ? item.input : undefined;
  const description = input && typeof input.description === "string"
    ? truncateInline(input.description, 100)
    : undefined;

  if (name === "Bash" && input && typeof input.command === "string") {
    const command = truncateInline(input.command, 180);
    return description ? `${name}: ${description} | ${command}` : `${name}: ${command}`;
  }

  const path = input && typeof input.file_path === "string"
    ? input.file_path
    : input && typeof input.path === "string"
      ? input.path
      : undefined;
  if (path) {
    return description ? `${name}: ${description} | ${path}` : `${name}: ${path}`;
  }

  return description ? `${name}: ${description}` : name;
}

function summarizeNestedToolUse(part: Record<string, unknown>): string {
  const toolNameRaw = typeof part.tool === "string"
    ? part.tool
    : (typeof part.name === "string" ? part.name : "tool");
  const toolName = normalizeToolName(toolNameRaw);
  const state = isRecord(part.state) ? part.state : undefined;
  const input = state && isRecord(state.input) ? state.input : undefined;
  const metadata = state && isRecord(state.metadata) ? state.metadata : undefined;
  const title = typeof state?.title === "string"
    ? state.title
    : (typeof metadata?.description === "string" ? metadata.description : undefined);
  const description = input && typeof input.description === "string"
    ? input.description
    : title;

  if (toolNameRaw.toLowerCase() === "bash" && input && typeof input.command === "string") {
    const command = truncateInline(input.command, 180);
    return description
      ? `${toolName}: ${truncateInline(description, 100)} | ${command}`
      : `${toolName}: ${command}`;
  }

  const path = input && typeof input.file_path === "string"
    ? input.file_path
    : input && typeof input.path === "string"
      ? input.path
      : undefined;
  if (path) {
    return description
      ? `${toolName}: ${truncateInline(description, 100)} | ${path}`
      : `${toolName}: ${path}`;
  }

  return description
    ? `${toolName}: ${truncateInline(description, 100)}`
    : toolName;
}

function summarizeNestedToolResult(part: Record<string, unknown>): string | undefined {
  const toolNameRaw = typeof part.tool === "string"
    ? part.tool
    : (typeof part.name === "string" ? part.name : "tool");
  const toolName = normalizeToolName(toolNameRaw);
  const state = isRecord(part.state) ? part.state : undefined;
  if (!state) return undefined;

  const metadata = isRecord(state.metadata) ? state.metadata : undefined;
  const status = typeof state.status === "string" ? state.status : undefined;
  const exit = typeof metadata?.exit === "number" ? metadata.exit : undefined;
  const output = typeof state.output === "string"
    ? state.output
    : (typeof metadata?.output === "string" ? metadata.output : undefined);
  const time = isRecord(state.time) ? state.time : undefined;
  const duration = typeof time?.start === "number" && typeof time?.end === "number"
    ? `${Math.max(0, Math.round(time.end - time.start))}ms`
    : undefined;

  const firstLine = output
    ? truncateInline(
        output
          .split("\n")
          .map((line) => line.trim())
          .find(Boolean) ?? "",
        180,
      )
    : undefined;

  const summaryParts = [
    toolName,
    status,
    exit !== undefined ? `exit=${exit}` : undefined,
    duration,
  ].filter(Boolean);

  if (summaryParts.length === 0 && !firstLine) return undefined;
  if (!firstLine) return summaryParts.join(" ");
  return `${summaryParts.join(" ")} | ${firstLine}`;
}

function getPartTokensSummary(part: Record<string, unknown>): string | undefined {
  const tokens = isRecord(part.tokens) ? part.tokens : undefined;
  if (!tokens) return undefined;

  const fields: string[] = [];
  addUsageField(fields, "tok", tokens.total);
  addUsageField(fields, "in", tokens.input);
  addUsageField(fields, "out", tokens.output);
  addUsageField(fields, "rsn", tokens.reasoning);

  const cache = isRecord(tokens.cache) ? tokens.cache : undefined;
  if (cache) {
    addUsageField(fields, "cache_read", cache.read);
    addUsageField(fields, "cache_write", cache.write);
  }

  if (fields.length === 0) return undefined;
  return fields.join(" ");
}

function getUsageSummary(parsed: Record<string, unknown>): string | undefined {
  const usage = isRecord(parsed.usage)
    ? parsed.usage
    : (isRecord(parsed.message) && isRecord(parsed.message.usage) ? parsed.message.usage : undefined);
  if (!usage) return undefined;

  const fields: string[] = [];
  addUsageField(fields, "in", usage.input_tokens);
  addUsageField(fields, "out", usage.output_tokens);
  addUsageField(fields, "cache_read", usage.cache_read_input_tokens);
  addUsageField(fields, "cache_write", usage.cache_creation_input_tokens);
  if (fields.length === 0) return undefined;
  return `tokens ${fields.join(" ")}`;
}

function addUsageField(parts: string[], label: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value)) return;
  parts.push(`${label}=${formatCount(value)}`);
}

function getResultSummary(parsed: Record<string, unknown>): string | undefined {
  const result = parsed.result;
  if (typeof result === "string") {
    return truncateInline(result, 220);
  }
  if (result !== undefined) {
    return truncateInline(JSON.stringify(result), 220);
  }
  return undefined;
}

function summarizeUnknownEvent(parsed: Record<string, unknown>): string {
  const type = typeof parsed.type === "string" ? parsed.type : "json";
  const role = typeof parsed.role === "string" ? ` role=${parsed.role}` : "";
  return `structured event: ${type}${role}`;
}

function inferUnknownChannel(parsed: Record<string, unknown>, fallback: string): string {
  if (isRecord(parsed.part) || Array.isArray(parsed.content) || isRecord(parsed.message) || isRecord(parsed.usage)) {
    return "llm_result";
  }
  return fallback;
}

function tryParseJson(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateInline(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  if (max <= 3) return collapsed.slice(0, max);
  return `${collapsed.slice(0, max - 3)}...`;
}

function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}

function normalizeToolName(name: string): string {
  if (!name) return "tool";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
