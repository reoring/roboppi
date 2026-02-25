import type { TuiRenderer } from "./opentui-platform.js";
import { PlainRenderer } from "./opentui-platform.js";
import type { TuiStateStore } from "./state-store.js";
import { renderHeader } from "./components/header.js";
import { renderStepList } from "./components/step-list.js";
import { renderDetailPane } from "./components/detail-pane.js";
import { ansiFit, sanitizeForTui, stripAnsi } from "./ansi-utils.js";
import { copyToClipboard } from "./clipboard.js";

export class WorkflowTui {
  private renderer: TuiRenderer;
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private readonly abortController = new AbortController();
  private finished = false;
  private dismissResolve: (() => void) | null = null;
  private toast: { message: string; until: number } | null = null;

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
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    this.renderer.destroy();
  }

  private handleKey(key: string): void {
    const state = this.store.state;

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

    // Tab numbers 1-6 for tab switching
    if (key >= "1" && key <= "6") {
      const tabs = ["overview", "logs", "diffs", "result", "core", "help"] as const;
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

  private moveSelection(delta: number): void {
    const state = this.store.state;
    const stepOrder = state.stepOrder;
    if (stepOrder.length === 0) return;

    const currentIdx = state.selectedStepId
      ? stepOrder.indexOf(state.selectedStepId)
      : -1;

    let newIdx = currentIdx + delta;
    if (newIdx < 0) newIdx = 0;
    if (newIdx >= stepOrder.length) newIdx = stepOrder.length - 1;

    state.selectedStepId = stepOrder[newIdx];
    state.followMode = "selected";
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
        state.selectedStepId = runningStep;
      }
    }

    // Default selection
    if (!state.selectedStepId && state.stepOrder.length > 0) {
      state.selectedStepId = state.stepOrder[0];
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
