import type { TuiRenderer } from "./opentui-platform.js";

/**
 * Passive ANSI renderer for cases where stdin is reserved for IPC.
 * Uses stderr + alternate screen, but does not touch stdin.
 */
export class PassiveAnsiRenderer implements TuiRenderer {
  start(): void {
    // Switch to alternate screen buffer
    process.stderr.write("\x1b[?1049h");
    // Hide cursor
    process.stderr.write("\x1b[?25l");
  }

  render(content: string): void {
    // Clear screen and move to top-left
    process.stderr.write("\x1b[2J\x1b[H");
    process.stderr.write(content);
  }

  destroy(): void {
    // Show cursor
    process.stderr.write("\x1b[?25h");
    // Switch back from alternate screen
    process.stderr.write("\x1b[?1049l");
  }

  onKeypress(_handler: (key: string) => void): void {
    // No-op: stdin is reserved for IPC JSONL.
  }
}
