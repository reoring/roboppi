/**
 * Chat tab — displays chat message history with inline input.
 *
 * Shows recent messages exchanged via agents, and provides an
 * inline input area for sending messages directly from the TUI.
 *
 * When an agent is selected in the left pane, messages are filtered
 * to only show those involving that agent.
 */
import type { WorkflowUiState } from "../../state-store.js";
import { agentMemberId } from "../../state-store.js";
import { ansiWrap, sanitizeForTui } from "../../ansi-utils.js";

export function renderChatTab(
  state: WorkflowUiState,
  width: number,
  height: number,
): string {
  const lines: string[] = [];

  // Reserve space for input area at the bottom (separator + input or hint)
  const inputAreaLines = state.chatInputActive ? 2 : 1;
  const headerLines = 2; // title + blank
  const messageAreaHeight = Math.max(0, height - headerLines - inputAreaLines);

  // Determine the selected agent for filtering
  const selectedAgent = state.selectedStepId
    ? agentMemberId(state.selectedStepId)
    : undefined;

  // Filter messages to those involving the selected agent
  const entries = selectedAgent
    ? state.chatMessages.filter(
        (m) => m.fromMemberId === selectedAgent || m.toMemberId === selectedAgent,
      )
    : state.chatMessages;

  const title = selectedAgent
    ? `\x1b[1mChat\x1b[0m \x1b[90mwith\x1b[0m \x1b[36m${sanitizeForTui(selectedAgent)}\x1b[0m`
    : "\x1b[1mChat\x1b[0m";
  lines.push(title);
  lines.push("");

  if (entries.length === 0 && !state.chatInputActive) {
    lines.push("\x1b[90mNo chat messages yet. Press \x1b[0mi\x1b[90m to start chatting.\x1b[0m");
    // Pad to message area
    while (lines.length < headerLines + messageAreaHeight) lines.push("");
  } else {
    const target = Math.max(0, messageAreaHeight);
    const physical: string[] = [];

    const displayEntries = entries.slice(-target);
    for (const entry of displayEntries) {
      const line = formatChatEntry(entry);
      const safe = sanitizeForTui(line);
      const chunks = ansiWrap(safe, Math.max(0, width));
      for (const chunk of chunks) {
        if (physical.length >= target) break;
        physical.push(chunk);
      }
    }

    for (const l of physical) lines.push(l);
    // Pad remaining message area
    while (lines.length < headerLines + messageAreaHeight) lines.push("");
  }

  // Input area at the bottom
  if (state.chatInputActive) {
    lines.push("\x1b[90m" + "\u2500".repeat(Math.max(0, width)) + "\x1b[0m");
    const inputTarget = state.chatInputTarget || "?";
    const prompt = `\x1b[32m${sanitizeForTui(inputTarget)}\x1b[0m> `;
    const buf = sanitizeForTui(state.chatInputBuffer);
    lines.push(prompt + buf + "\x1b[7m \x1b[0m");
  } else {
    const inputTarget = state.chatInputTarget || selectedAgent;
    const hint = inputTarget
      ? `Press \x1b[1mi\x1b[0m\x1b[90m to chat with \x1b[36m${sanitizeForTui(inputTarget)}\x1b[0m`
      : "Press \x1b[1mi\x1b[0m\x1b[90m to start chatting";
    lines.push(`\x1b[90m${hint}\x1b[0m`);
  }

  return padLines(lines, height);
}

export interface ChatMessageEntry {
  ts: number;
  /** Unique message identifier for deduplication. */
  messageId?: string;
  fromMemberId: string;
  fromName: string;
  /** Recipient member ID. */
  toMemberId?: string;
  kind: string;
  body: string;
}

function formatChatEntry(entry: ChatMessageEntry): string {
  const time = new Date(entry.ts).toISOString().slice(11, 19);
  const isUser = entry.fromMemberId === "user";
  const sender = isUser ? "you" : (entry.fromName || entry.fromMemberId);
  const senderColor = isUser ? "\x1b[32m" : "\x1b[36m"; // green for you, cyan for agents
  // Show recipient when it's not the user (e.g. implementer→lead)
  const toTag = entry.toMemberId && entry.toMemberId !== "user"
    ? `\x1b[90m→${entry.toMemberId}\x1b[0m `
    : "";
  const kindTag = entry.kind !== "text" ? ` \x1b[90m[${entry.kind}]\x1b[0m` : "";
  return `\x1b[90m${time}\x1b[0m \x1b[1m${senderColor}${sender}\x1b[0m ${toTag}${kindTag}: ${entry.body}`;
}

function padLines(lines: string[], height: number): string {
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
