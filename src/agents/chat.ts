/**
 * Agent Chat REPL — interactive chat with agents.
 *
 * Uses the file-backed mailbox (store.ts) to send/receive messages.
 * All display output goes to stderr (ANSI-colored); stdout emits only
 * a final JSON summary on exit for tool-use compatibility.
 */
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";

import {
  readTeam,
  readMembers,
  upsertMember,
  validateMember,
  deliverMessage,
  broadcastMessage,
  recvMessages,
  ackMessageByClaimToken,
} from "./store.js";
import { listTasks } from "./task-store.js";
import { allDirs } from "./paths.js";
import type { ReceivedMessage } from "./store.js";
import type { TaskStatus, MemberEntry } from "./types.js";

// ---------------------------------------------------------------------------
// ANSI helpers (stderr only)
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const MAGENTA = "\x1b[35m";

// ---------------------------------------------------------------------------
// Parsed chat command types
// ---------------------------------------------------------------------------

export type ChatCommand =
  | { type: "to"; target: string; body: string }
  | { type: "broadcast"; body: string }
  | { type: "members" }
  | { type: "tasks"; status?: string }
  | { type: "history"; count: number }
  | { type: "help" }
  | { type: "quit" }
  | { type: "repeat"; body: string }
  | { type: "empty" };

/**
 * Parse a raw input line into a ChatCommand.
 */
export function parseChatCommand(line: string): ChatCommand {
  const trimmed = line.trim();
  if (!trimmed) return { type: "empty" };

  if (!trimmed.startsWith("/")) {
    return { type: "repeat", body: trimmed };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (cmd) {
    case "/to": {
      const toSpace = rest.indexOf(" ");
      if (toSpace === -1 || !rest) {
        return { type: "help" }; // malformed → show help
      }
      const target = rest.slice(0, toSpace);
      const body = rest.slice(toSpace + 1).trim();
      if (!body) return { type: "help" };
      return { type: "to", target, body };
    }

    case "/broadcast": {
      if (!rest) return { type: "help" };
      return { type: "broadcast", body: rest };
    }

    case "/members":
      return { type: "members" };

    case "/tasks": {
      const status = rest || undefined;
      return { type: "tasks", status };
    }

    case "/history": {
      const n = rest ? parseInt(rest, 10) : 20;
      return { type: "history", count: Number.isNaN(n) ? 20 : n };
    }

    case "/help":
      return { type: "help" };

    case "/quit":
    case "/exit":
    case "/q":
      return { type: "quit" };

    default:
      return { type: "help" };
  }
}

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------

function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/**
 * Format a received AgentMessage for display.
 */
export function formatReceivedMessage(msg: ReceivedMessage): string {
  const time = `${DIM}[${formatTime(msg.message.ts)}]${RESET}`;
  const sender = `${BOLD}${CYAN}${msg.message.from.name || msg.message.from.member_id}${RESET}`;
  const kindTag =
    msg.message.kind !== "text"
      ? ` ${DIM}[${msg.message.kind}]${RESET}`
      : "";
  const body = msg.message.body;
  return `${time} ${sender}${kindTag}: ${body}`;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const CHAT_HELP = `
${BOLD}Commands:${RESET}
  /to <member> <msg>   Send to a specific member
  /broadcast <msg>     Send to all members
  /members             List members
  /tasks [status]      List tasks (optional: pending|in_progress|completed|blocked)
  /history [n]         Show last n received messages (default: 20)
  /help                Show this help
  /quit                Exit chat

  ${DIM}Plain text sends to the last /to target.${RESET}
`.trim();

// ---------------------------------------------------------------------------
// runChat — main entry point
// ---------------------------------------------------------------------------

export interface RunChatOptions {
  contextDir: string;
  memberId: string;
  pollMs: number;
}

export async function runChat(opts: RunChatOptions): Promise<void> {
  const { contextDir, memberId, pollMs } = opts;

  // 1. Validate agents context exists
  let team;
  try {
    team = await readTeam(contextDir);
  } catch {
    process.stdout.write(
      JSON.stringify({ ok: false, error: "Agents context not found. Run `roboppi agents init` first." }) + "\n",
    );
    process.exit(1);
  }

  // 2. Auto-register user as member
  const entry: MemberEntry = {
    member_id: memberId,
    name: memberId,
    role: "human",
  };
  await upsertMember(contextDir, entry);

  // 3. Ensure inbox directories exist
  const memberDirs = allDirs(contextDir, [memberId]);
  for (const dir of memberDirs) {
    await mkdir(dir, { recursive: true });
  }

  // 4. State
  const messageHistory: ReceivedMessage[] = [];
  const MAX_HISTORY = 1000;
  let lastTarget = "";
  let messagesReceived = 0;

  // 5. Welcome banner
  const { members } = await readMembers(contextDir);
  const memberList = members.map((m) => m.member_id).join(", ");
  process.stderr.write(
    `\n${BOLD}${GREEN}agents chat${RESET} — team ${BOLD}${team.name}${RESET} as ${BOLD}${MAGENTA}${memberId}${RESET}\n` +
    `${DIM}Members: ${memberList}${RESET}\n` +
    `${DIM}Type /help for commands, /quit to exit.${RESET}\n\n`,
  );

  // 6. Readline (stderr-based)
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `${GREEN}${memberId}${RESET}> `,
  });
  rl.prompt();

  // 7. Background poll loop
  const pollTimer = setInterval(async () => {
    try {
      const msgs = await recvMessages({
        contextDir,
        memberId,
        claim: true,
        max: 20,
      });

      for (const msg of msgs) {
        // Ack
        if (msg.claim) {
          await ackMessageByClaimToken(contextDir, memberId, msg.claim.token).catch(() => {});
        }

        // Store history
        messageHistory.push(msg);
        if (messageHistory.length > MAX_HISTORY) {
          messageHistory.splice(0, messageHistory.length - MAX_HISTORY);
        }
        messagesReceived++;

        // Display: clear line, show message, re-prompt
        const formatted = formatReceivedMessage(msg);
        process.stderr.write(`\r\x1b[K${formatted}\n`);
        rl.prompt(true);
      }
    } catch {
      // Silently ignore poll errors (context may be shutting down)
    }
  }, pollMs);

  // 8. REPL command handler
  const handleLine = async (line: string): Promise<void> => {
    const cmd = parseChatCommand(line);

    switch (cmd.type) {
      case "empty":
        rl.prompt();
        return;

      case "quit":
        rl.close();
        return;

      case "help":
        process.stderr.write(CHAT_HELP + "\n");
        rl.prompt();
        return;

      case "members": {
        const current = await readMembers(contextDir);
        process.stderr.write(`${BOLD}Members:${RESET}\n`);
        for (const m of current.members) {
          const roleTag = m.role ? ` ${DIM}(${m.role})${RESET}` : "";
          process.stderr.write(`  ${CYAN}${m.member_id}${RESET}${roleTag} — ${m.name}\n`);
        }
        rl.prompt();
        return;
      }

      case "tasks": {
        const tasks = await listTasks(
          contextDir,
          cmd.status as TaskStatus | undefined,
        );
        if (tasks.length === 0) {
          process.stderr.write(`${DIM}No tasks found.${RESET}\n`);
        } else {
          process.stderr.write(`${BOLD}Tasks:${RESET}\n`);
          for (const t of tasks) {
            const statusColor = t.status === "completed" ? GREEN : YELLOW;
            process.stderr.write(
              `  ${DIM}${t.task_id.slice(0, 8)}${RESET} ${statusColor}[${t.status}]${RESET} ${t.title}` +
              (t.assigned_to ? ` ${DIM}→ ${t.assigned_to}${RESET}` : "") +
              "\n",
            );
          }
        }
        rl.prompt();
        return;
      }

      case "history": {
        const slice = messageHistory.slice(-cmd.count);
        if (slice.length === 0) {
          process.stderr.write(`${DIM}No messages yet.${RESET}\n`);
        } else {
          for (const msg of slice) {
            process.stderr.write(formatReceivedMessage(msg) + "\n");
          }
        }
        rl.prompt();
        return;
      }

      case "to": {
        try {
          await validateMember(contextDir, cmd.target);
        } catch {
          process.stderr.write(`${YELLOW}Unknown member: ${cmd.target}${RESET}\n`);
          rl.prompt();
          return;
        }
        const teamNow = await readTeam(contextDir);
        await deliverMessage({
          contextDir,
          teamId: teamNow.team_id,
          fromMemberId: memberId,
          fromName: memberId,
          toMemberId: cmd.target,
          topic: "chat",
          body: cmd.body,
        });
        lastTarget = cmd.target;
        process.stderr.write(`${DIM}→ ${cmd.target}${RESET}\n`);
        rl.prompt();
        return;
      }

      case "broadcast": {
        const teamNow = await readTeam(contextDir);
        await broadcastMessage({
          contextDir,
          teamId: teamNow.team_id,
          fromMemberId: memberId,
          fromName: memberId,
          topic: "chat",
          body: cmd.body,
        });
        process.stderr.write(`${DIM}→ [broadcast]${RESET}\n`);
        rl.prompt();
        return;
      }

      case "repeat": {
        if (!lastTarget) {
          process.stderr.write(`${YELLOW}No previous target. Use /to <member> <msg> first.${RESET}\n`);
          rl.prompt();
          return;
        }
        const teamNow = await readTeam(contextDir);
        await deliverMessage({
          contextDir,
          teamId: teamNow.team_id,
          fromMemberId: memberId,
          fromName: memberId,
          toMemberId: lastTarget,
          topic: "chat",
          body: cmd.body,
        });
        process.stderr.write(`${DIM}→ ${lastTarget}${RESET}\n`);
        rl.prompt();
        return;
      }
    }
  };

  rl.on("line", (line: string) => {
    handleLine(line).catch((err) => {
      process.stderr.write(`${YELLOW}Error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
      rl.prompt();
    });
  });

  // 9. Cleanup on close
  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      clearInterval(pollTimer);
      resolve();
    });
  });

  // 10. Final JSON summary on stdout
  process.stdout.write(
    JSON.stringify({ ok: true, messages_received: messagesReceived }) + "\n",
  );
}
