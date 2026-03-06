import type { TuiRenderer } from "./opentui-platform.js";
import { PlainRenderer } from "./opentui-platform.js";
import type { TuiStateStore } from "./state-store.js";
import { isAgentStep, agentMemberId } from "./state-store.js";
import { renderHeader } from "./components/header.js";
import { renderStepList, buildLeftPaneEntries } from "./components/step-list.js";
import { renderDetailPane, resolveEffectiveTab } from "./components/detail-pane.js";
import { ansiFit, sanitizeForTui, stripAnsi } from "./ansi-utils.js";
import { copyToClipboard } from "./clipboard.js";
import {
  deliverMessage,
  readTeam,
  upsertMember,
  recvMessages,
  ackMessageByClaimToken,
} from "../agents/store.js";
import { allDirs } from "../agents/paths.js";
import { mkdir } from "node:fs/promises";

const CHAT_MEMBER_ID = "user";
const CHAT_POLL_INTERVAL_MS = 2000;

export class WorkflowTui {
  private renderer: TuiRenderer;
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private readonly abortController = new AbortController();
  private finished = false;
  private dismissResolve: (() => void) | null = null;
  private toast: { message: string; until: number } | null = null;
  private userRegistered = false;
  private chatPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: TuiStateStore,
    renderer?: TuiRenderer,
  ) {
    this.renderer = renderer ?? new PlainRenderer();
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  start(): void {
    this.renderer.start();

    // Handle key presses
    this.renderer.onKeypress((key) => this.handleKey(key));

    // Render loop at ~30fps, only when dirty
    this.renderTimer = setInterval(() => {
      if (this.toast && Date.now() > this.toast.until) {
        this.toast = null;
        this.store.dirty = true;
      }
      if (this.store.dirty) {
        this.store.dirty = false;
        this.renderFrame();
      }
    }, 33);

    // Initial render
    this.renderFrame();

    // Poll user inbox for incoming replies
    this.chatPollTimer = setInterval(() => {
      this.pollChatInbox().catch(() => {});
    }, CHAT_POLL_INTERVAL_MS);
  }

  /**
   * Mark workflow as finished and wait for user to dismiss (q / Ctrl+C).
   * The TUI stays open showing the final state. Resolves when user presses
   * a dismiss key, then cleans up the renderer.
   */
  async waitForDismiss(): Promise<void> {
    this.finished = true;
    // Force a final render so the user sees the completed state
    this.store.dirty = true;

    await new Promise<void>((resolve) => {
      this.dismissResolve = resolve;
    });

    this.stop();
  }

  stop(): void {
    if (this.chatPollTimer) {
      clearInterval(this.chatPollTimer);
      this.chatPollTimer = null;
    }
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    this.renderer.destroy();
  }

  private handleKey(key: string): void {
    const state = this.store.state;

    // Chat input mode: capture all keystrokes into the input buffer.
    if (state.chatInputActive) {
      this.handleChatInput(key);
      return;
    }

    // i - enter chat input mode (only on chat tab)
    if (key === "i" && state.selectedTab === "chat") {
      const memberId = state.selectedStepId
        ? agentMemberId(state.selectedStepId)
        : undefined;
      state.chatInputActive = true;
      state.chatInputTarget = memberId ?? state.chatInputTarget ?? "";
      state.chatInputBuffer = "";
      this.store.dirty = true;
      return;
    }

    // y - copy visible tab contents
    if (key === "y") {
      const text = this.getVisibleDetailText();
      const res = copyToClipboard(text);
      this.toast = {
        message: res.ok ? `Copied (${state.selectedTab})` : "Copy failed",
        until: Date.now() + 2000,
      };
      this.store.dirty = true;
      return;
    }

    // Ctrl+C
    if (key === "\x03") {
      if (this.finished) {
        this.dismissResolve?.();
        return;
      }
      this.abortController.abort();
      return;
    }

    // q - quit
    if (key === "q") {
      if (this.finished) {
        this.dismissResolve?.();
        return;
      }
      this.abortController.abort();
      return;
    }

    // j / down arrow - move selection down
    if (key === "j" || key === "\x1b[B") {
      this.moveSelection(1);
      return;
    }

    // k / up arrow - move selection up
    if (key === "k" || key === "\x1b[A") {
      this.moveSelection(-1);
      return;
    }

    // Tab numbers 1-8 for tab switching (context-dependent)
    if (key >= "1" && key <= "8") {
      const isAgent = state.selectedStepId ? isAgentStep(state.selectedStepId) : false;
      const tabs = isAgent
        ? ["chat", "agent_overview", "logs", "agents", "result", "core", "help"] as const
        : ["overview", "logs", "diffs", "result", "core", "agents", "chat", "help"] as const;
      const idx = parseInt(key) - 1;
      if (idx < tabs.length) {
        state.selectedTab = tabs[idx]!;
        this.store.dirty = true;
      }
      return;
    }

    // Enter - lock selection
    if (key === "\r" || key === "\n") {
      state.followMode = "selected";
      this.store.dirty = true;
      return;
    }

    // f - follow running step
    if (key === "f") {
      state.followMode = "running";
      this.store.dirty = true;
      return;
    }

    // space - toggle follow mode
    if (key === " ") {
      state.followMode = state.followMode === "running" ? "selected" : "running";
      this.store.dirty = true;
      return;
    }
  }

  // ----- Chat input mode -----

  private handleChatInput(key: string): void {
    const state = this.store.state;

    // Escape — exit input mode
    if (key === "\x1b") {
      state.chatInputActive = false;
      state.chatInputBuffer = "";
      this.store.dirty = true;
      return;
    }

    // Ctrl+C — exit input mode
    if (key === "\x03") {
      state.chatInputActive = false;
      state.chatInputBuffer = "";
      this.store.dirty = true;
      return;
    }

    // Enter — send message
    if (key === "\r" || key === "\n") {
      const buf = state.chatInputBuffer.trim();
      if (buf) {
        this.fireChatSend(buf);
      }
      state.chatInputActive = false;
      state.chatInputBuffer = "";
      this.store.dirty = true;
      return;
    }

    // Backspace
    if (key === "\x7f" || key === "\x08") {
      if (state.chatInputBuffer.length > 0) {
        state.chatInputBuffer = state.chatInputBuffer.slice(0, -1);
        this.store.dirty = true;
      }
      return;
    }

    // Printable characters
    if (key.length === 1 && key >= " ") {
      state.chatInputBuffer += key;
      this.store.dirty = true;
      return;
    }
  }

  private fireChatSend(body: string): void {
    this.doSendChatMessage(body).catch(() => {
      // silently ignore — agents context may not be available
    });
  }

  /** Ensure "user" member exists in members.json with role "human" and inbox dirs. */
  private async ensureUserRegistered(): Promise<void> {
    if (this.userRegistered) return;
    const contextDir = this.store.state.contextDir;
    if (!contextDir) return;

    try {
      await upsertMember(contextDir, {
        member_id: CHAT_MEMBER_ID,
        name: CHAT_MEMBER_ID,
        role: "human",
      });
      const dirs = allDirs(contextDir, [CHAT_MEMBER_ID]);
      for (const dir of dirs) {
        await mkdir(dir, { recursive: true });
      }
      this.userRegistered = true;
    } catch {
      // best-effort
    }
  }

  private async doSendChatMessage(body: string): Promise<void> {
    const state = this.store.state;
    const contextDir = state.contextDir;
    if (!contextDir) {
      this.showToast("No agents context");
      return;
    }

    const target = state.chatInputTarget;
    if (!target) {
      this.showToast("No target agent");
      return;
    }

    // Register user member (creates inbox dirs, adds to members.json with role:"human")
    await this.ensureUserRegistered();

    try {
      const team = await readTeam(contextDir);
      const { messageId } = await deliverMessage({
        contextDir,
        teamId: team.team_id,
        fromMemberId: CHAT_MEMBER_ID,
        fromName: CHAT_MEMBER_ID,
        toMemberId: target,
        topic: "chat",
        body,
      });

      // Add to chatMessages for immediate display (with messageId for dedup)
      state.chatMessages.push({
        ts: Date.now(),
        messageId,
        fromMemberId: CHAT_MEMBER_ID,
        fromName: CHAT_MEMBER_ID,
        toMemberId: target,
        kind: "text",
        body,
      });
      this.showToast(`Sent to ${target}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showToast(`Send failed: ${msg.slice(0, 40)}`);
    }
  }

  /** Poll "user" inbox for incoming replies and add to chatMessages. */
  private async pollChatInbox(): Promise<void> {
    if (!this.userRegistered) return;
    const contextDir = this.store.state.contextDir;
    if (!contextDir) return;

    const msgs = await recvMessages({
      contextDir,
      memberId: CHAT_MEMBER_ID,
      claim: true,
      max: 20,
    });

    for (const msg of msgs) {
      // Ack the message
      if (msg.claim) {
        await ackMessageByClaimToken(contextDir, CHAT_MEMBER_ID, msg.claim.token).catch(() => {});
      }

      // Deduplicate by messageId
      const msgId = msg.messageId;
      if (this.store.state.chatMessages.some((m) => m.messageId === msgId)) continue;

      this.store.state.chatMessages.push({
        ts: msg.message.ts,
        messageId: msgId,
        fromMemberId: msg.message.from.member_id,
        fromName: msg.message.from.name || msg.message.from.member_id,
        toMemberId: CHAT_MEMBER_ID,
        kind: msg.message.kind,
        body: msg.message.body,
      });
      this.store.dirty = true;
    }
  }

  private showToast(message: string): void {
    this.toast = { message, until: Date.now() + 2000 };
    this.store.dirty = true;
  }

  private moveSelection(delta: number): void {
    const state = this.store.state;
    const entries = buildLeftPaneEntries(state);
    const selectable = entries.filter((e) => e.kind !== "separator");
    if (selectable.length === 0) return;

    const currentIdx = state.selectedStepId
      ? selectable.findIndex((e) => e.stepId === state.selectedStepId)
      : -1;

    let newIdx = currentIdx + delta;
    if (newIdx < 0) newIdx = 0;
    if (newIdx >= selectable.length) newIdx = selectable.length - 1;

    const prev = state.selectedStepId;
    state.selectedStepId = selectable[newIdx]!.stepId;
    state.followMode = "selected";

    // When crossing step↔agent boundary, remap the tab
    if (prev && state.selectedStepId !== prev) {
      state.selectedTab = resolveEffectiveTab(state.selectedTab, state.selectedStepId);
    }

    this.store.dirty = true;
  }

  private renderFrame(): void {
    const state = this.store.state;

    // Auto-follow: update selected step to latest running step
    if (state.followMode === "running") {
      const runningStep = state.stepOrder.find((id) => {
        const s = state.steps.get(id);
        return s && (s.status === "RUNNING" || s.status === "CHECKING");
      });
      if (runningStep) {
        const prev = state.selectedStepId;
        state.selectedStepId = runningStep;
        if (prev && state.selectedStepId !== prev) {
          state.selectedTab = resolveEffectiveTab(state.selectedTab, state.selectedStepId);
        }
      }
    }

    // Default selection: first selectable entry
    if (!state.selectedStepId && state.stepOrder.length > 0) {
      const entries = buildLeftPaneEntries(state);
      const first = entries.find((e) => e.kind !== "separator");
      state.selectedStepId = first ? first.stepId : state.stepOrder[0];
    }

    try {
      const { columns = 80, rows = 24 } = process.stderr;
      const header = this.renderHeaderWithToast(state, columns);
      const contentHeight = Math.max(0, rows - header.split("\n").length);

      const sepWidth = 3; // space + separator + space
      const minRight = 16;
      let leftWidth = Math.min(Math.max(24, Math.floor(columns * 0.3)), 40);
      leftWidth = Math.min(leftWidth, Math.max(10, columns - sepWidth - minRight));
      const rightWidth = Math.max(10, columns - leftWidth - sepWidth);

      const stepList = renderStepList(state, leftWidth, contentHeight);
      const detail = renderDetailPane(state, rightWidth, contentHeight);

      // Combine left and right panes
      const leftLines = stepList.split("\n");
      const rightLines = detail.split("\n");
      const maxLines = Math.max(leftLines.length, rightLines.length, contentHeight);

      const bodyLines: string[] = [];
      for (let i = 0; i < maxLines; i++) {
        const leftRaw = sanitizeForTui(leftLines[i] ?? "");
        const rightRaw = sanitizeForTui(rightLines[i] ?? "");
        const left = ansiFit(leftRaw, leftWidth);
        const right = ansiFit(rightRaw, rightWidth);
        bodyLines.push(`${left} \x1b[90m\u2502\x1b[0m ${right}`);
      }

      const rawOut = header + "\n" + bodyLines.join("\n");
      this.renderer.render(fitFrame(rawOut, columns, rows));
    } catch {
      // Ignore render errors
    }
  }

  private renderHeaderWithToast(state: typeof this.store.state, columns: number): string {
    const base = renderHeader(state, columns);
    if (!this.toast) return base;

    const lines = base.split("\n");
    if (lines.length < 2) return base;

    const toast = `\x1b[32m${sanitizeForTui(this.toast.message)}\x1b[0m`;
    const l2 = (lines[1] ?? "").replace(/[ \t]+$/g, "");
    lines[1] = ansiFit(`${l2}  ${toast}`, Math.max(0, columns));
    return lines.join("\n");
  }

  private getVisibleDetailText(): string {
    const state = this.store.state;
    const { columns = 80, rows = 24 } = process.stderr;
    const header = this.renderHeaderWithToast(state, columns);
    const contentHeight = Math.max(0, rows - header.split("\n").length);

    const sepWidth = 3;
    const minRight = 16;
    let leftWidth = Math.min(Math.max(24, Math.floor(columns * 0.3)), 40);
    leftWidth = Math.min(leftWidth, Math.max(10, columns - sepWidth - minRight));
    const rightWidth = Math.max(10, columns - leftWidth - sepWidth);

    const detail = renderDetailPane(state, rightWidth, contentHeight);
    const plain = stripAnsi(detail);

    const normalized = plain
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/g, ""))
      .join("\n")
      .replace(/\n+$/g, "\n");

    return normalized;
  }
}

function fitFrame(frame: string, columns: number, rows: number): string {
  const cols = Math.max(0, Math.floor(columns));
  const r = Math.max(0, Math.floor(rows));
  const lines = frame.split("\n");
  const out: string[] = [];

  for (let i = 0; i < Math.min(lines.length, r); i++) {
    out.push(ansiFit(lines[i] ?? "", cols));
  }
  while (out.length < r) {
    out.push(" ".repeat(cols));
  }

  return out.join("\n");
}
