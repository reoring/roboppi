import type { RGBA, StyledText, KeyEvent, CliRenderer, TextRenderable } from "@opentui/core";

export interface TuiRenderer {
  start(): void;
  render(content: string): void;
  destroy(): void;
  onKeypress(handler: (key: string) => void): void;
}

export async function createOpenTuiRenderer(): Promise<TuiRenderer> {
  await ensureOpenTuiPlatformBundled();

  const core = await import("@opentui/core");
  const renderer = await core.createCliRenderer({
    stdin: process.stdin,
    // Render to stderr so stdout stays usable for plain output.
    stdout: process.stderr,
    exitOnCtrlC: false,
    useAlternateScreen: true,
    useMouse: false,
    targetFps: 30,
  });

  const text = new core.TextRenderable(renderer, {
    id: "roboppi.workflow.tui",
    width: "100%",
    height: "100%",
    wrapMode: "none",
    selectable: false,
  });
  renderer.root.add(text);

  return new OpenTuiRenderer(
    renderer,
    text,
    core.StyledText,
    (color: string) => core.parseColor(color),
  );
}

async function ensureOpenTuiPlatformBundled(): Promise<void> {
  const key = `${process.platform}-${process.arch}`;

  // IMPORTANT:
  // - OpenTUI loads its native shared library via dynamic import of
  //   `@opentui/core-${platform}-${arch}/index.ts`.
  // - `bun build --compile` will not reliably include these optional
  //   platform packages unless we reference them explicitly.
  // - Wrap each import in try/catch so builds succeed even when other
  //   platform packages are not installed.
  const tryImports = async (): Promise<boolean> => {
    switch (key) {
      case "linux-x64":
        try {
          await import("@opentui/core-linux-x64/index.ts");
          return true;
        } catch {
          return false;
        }
      case "linux-arm64":
        try {
          await import("@opentui/core-linux-arm64/index.ts");
          return true;
        } catch {
          return false;
        }
      case "darwin-x64":
        try {
          await import("@opentui/core-darwin-x64/index.ts");
          return true;
        } catch {
          return false;
        }
      case "darwin-arm64":
        try {
          await import("@opentui/core-darwin-arm64/index.ts");
          return true;
        } catch {
          return false;
        }
      case "win32-x64":
        try {
          await import("@opentui/core-win32-x64/index.ts");
          return true;
        } catch {
          return false;
        }
      case "win32-arm64":
        try {
          await import("@opentui/core-win32-arm64/index.ts");
          return true;
        } catch {
          return false;
        }
      default:
        return false;
    }
  };

  if (await tryImports()) return;

  // Best-effort fallback: try any installed platform package.
  // This keeps the error message readable when `key` is unexpected.
  try {
    await import("@opentui/core-linux-x64/index.ts");
    return;
  } catch {
    // ignore
  }
  try {
    await import("@opentui/core-linux-arm64/index.ts");
    return;
  } catch {
    // ignore
  }
  try {
    await import("@opentui/core-darwin-x64/index.ts");
    return;
  } catch {
    // ignore
  }
  try {
    await import("@opentui/core-darwin-arm64/index.ts");
    return;
  } catch {
    // ignore
  }
  try {
    await import("@opentui/core-win32-x64/index.ts");
    return;
  } catch {
    // ignore
  }
  try {
    await import("@opentui/core-win32-arm64/index.ts");
    return;
  } catch {
    // ignore
  }

  throw new Error(
    `OpenTUI native platform package not available for ${key}. ` +
      `Ensure @opentui/core optionalDependencies installed (or install @opentui/core-${key}).`,
  );
}

class OpenTuiRenderer implements TuiRenderer {
  private started = false;
  private keypressHandler: ((key: string) => void) | null = null;
  private keyListener: ((event: KeyEvent) => void) | null = null;

  private readonly colorCache = new Map<string, RGBA>();

  constructor(
    private readonly renderer: CliRenderer,
    private readonly text: TextRenderable,
    private readonly StyledTextCtor: typeof StyledText,
    private readonly parseColor: (input: string) => RGBA,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.renderer.start();
  }

  render(content: string): void {
    this.text.content = this.ansiToStyledText(content);
  }

  destroy(): void {
    if (this.keyListener) {
      try {
        this.renderer.keyInput.removeListener("keypress", this.keyListener);
      } catch {
        // ignore
      }
      this.keyListener = null;
    }

    try {
      this.renderer.destroy();
    } catch {
      // ignore
    }
  }

  onKeypress(handler: (key: string) => void): void {
    this.keypressHandler = handler;

    if (this.keyListener) return;
    this.keyListener = (event: KeyEvent) => {
      const key = normalizeKeyEvent(event);
      if (!key) return;
      this.keypressHandler?.(key);
    };
    this.renderer.keyInput.on("keypress", this.keyListener);
  }

  private ansiToStyledText(input: string): StyledText | string {
    // Fast path: no ANSI SGR codes.
    if (!input.includes("\x1b[")) return input;

    type StyleState = {
      fg?: RGBA;
      bg?: RGBA;
      bold: boolean;
      dim: boolean;
      italic: boolean;
      underline: boolean;
      inverse: boolean;
      blink: boolean;
      hidden: boolean;
      strikethrough: boolean;
    };

    const style: StyleState = {
      bold: false,
      dim: false,
      italic: false,
      underline: false,
      inverse: false,
      blink: false,
      hidden: false,
      strikethrough: false,
    };

    const chunks: Array<{
      __isChunk: true;
      text: string;
      fg?: RGBA;
      bg?: RGBA;
      attributes?: number;
    }> = [];

    const pushChunk = (text: string): void => {
      if (!text) return;

      let attributes = 0;
      if (style.bold) attributes |= 1 << 0;
      if (style.dim) attributes |= 1 << 1;
      if (style.italic) attributes |= 1 << 2;
      if (style.underline) attributes |= 1 << 3;
      if (style.blink) attributes |= 1 << 4;
      if (style.inverse) attributes |= 1 << 5;
      if (style.hidden) attributes |= 1 << 6;
      if (style.strikethrough) attributes |= 1 << 7;

      const last = chunks.length > 0 ? chunks[chunks.length - 1] : undefined;
      if (
        last &&
        last.fg === style.fg &&
        last.bg === style.bg &&
        (last.attributes ?? 0) === attributes
      ) {
        last.text += text;
        return;
      }

      const chunk: {
        __isChunk: true;
        text: string;
        fg?: RGBA;
        bg?: RGBA;
        attributes?: number;
      } = {
        __isChunk: true,
        text,
      };
      if (style.fg) chunk.fg = style.fg;
      if (style.bg) chunk.bg = style.bg;
      if (attributes !== 0) chunk.attributes = attributes;
      chunks.push(chunk);
    };

    const setFg = (name: string | undefined): void => {
      if (!name) {
        style.fg = undefined;
        return;
      }
      const cached = this.colorCache.get(name);
      if (cached) {
        style.fg = cached;
        return;
      }
      const parsed = this.parseColor(name);
      this.colorCache.set(name, parsed);
      style.fg = parsed;
    };

    const setBg = (name: string | undefined): void => {
      if (!name) {
        style.bg = undefined;
        return;
      }
      const key = `bg:${name}`;
      const cached = this.colorCache.get(key);
      if (cached) {
        style.bg = cached;
        return;
      }
      const parsed = this.parseColor(name);
      this.colorCache.set(key, parsed);
      style.bg = parsed;
    };

    const reset = (): void => {
      style.fg = undefined;
      style.bg = undefined;
      style.bold = false;
      style.dim = false;
      style.italic = false;
      style.underline = false;
      style.inverse = false;
      style.blink = false;
      style.hidden = false;
      style.strikethrough = false;
    };

    const applySgr = (params: number[]): void => {
      const effective = params.length === 0 ? [0] : params;
      for (const p of effective) {
        if (p === 0) {
          reset();
          continue;
        }
        if (p === 1) {
          style.bold = true;
          continue;
        }
        if (p === 2) {
          style.dim = true;
          continue;
        }
        if (p === 3) {
          style.italic = true;
          continue;
        }
        if (p === 4) {
          style.underline = true;
          continue;
        }
        if (p === 5) {
          style.blink = true;
          continue;
        }
        if (p === 7) {
          style.inverse = true;
          continue;
        }
        if (p === 8) {
          style.hidden = true;
          continue;
        }
        if (p === 9) {
          style.strikethrough = true;
          continue;
        }
        if (p === 22) {
          style.bold = false;
          style.dim = false;
          continue;
        }
        if (p === 23) {
          style.italic = false;
          continue;
        }
        if (p === 24) {
          style.underline = false;
          continue;
        }
        if (p === 25) {
          style.blink = false;
          continue;
        }
        if (p === 27) {
          style.inverse = false;
          continue;
        }
        if (p === 28) {
          style.hidden = false;
          continue;
        }
        if (p === 29) {
          style.strikethrough = false;
          continue;
        }

        // Foreground colors
        if (p >= 30 && p <= 37) {
          setFg(sgrColorName(p, false));
          continue;
        }
        if (p === 39) {
          setFg(undefined);
          continue;
        }
        if (p >= 90 && p <= 97) {
          setFg(sgrColorName(p, false));
          continue;
        }

        // Background colors
        if (p >= 40 && p <= 47) {
          setBg(sgrColorName(p, true));
          continue;
        }
        if (p === 49) {
          setBg(undefined);
          continue;
        }
        if (p >= 100 && p <= 107) {
          setBg(sgrColorName(p, true));
          continue;
        }
      }
    };

    const sgrRe = /\x1b\[([0-9;]*)m/g;
    let lastIndex = 0;
    while (true) {
      const match = sgrRe.exec(input);
      if (!match) break;

      const idx = match.index;
      if (idx > lastIndex) {
        pushChunk(input.slice(lastIndex, idx));
      }

      const rawParams = match[1] ?? "";
      const params = rawParams.length === 0
        ? []
        : rawParams
            .split(";")
            .map((s) => Number(s))
            .filter((n) => Number.isFinite(n));
      applySgr(params);
      lastIndex = sgrRe.lastIndex;
    }

    if (lastIndex < input.length) {
      pushChunk(input.slice(lastIndex));
    }

    return new this.StyledTextCtor(chunks);
  }
}

function sgrColorName(code: number, isBg: boolean): string | undefined {
  const base: Record<number, string> = isBg
    ? {
        40: "black",
        41: "red",
        42: "green",
        43: "yellow",
        44: "blue",
        45: "magenta",
        46: "cyan",
        47: "white",
      }
    : {
        30: "black",
        31: "red",
        32: "green",
        33: "yellow",
        34: "blue",
        35: "magenta",
        36: "cyan",
        37: "white",
      };

  const bright: Record<number, string> = isBg
    ? {
        100: "brightBlack",
        101: "brightRed",
        102: "brightGreen",
        103: "brightYellow",
        104: "brightBlue",
        105: "brightMagenta",
        106: "brightCyan",
        107: "brightWhite",
      }
    : {
        90: "brightBlack",
        91: "brightRed",
        92: "brightGreen",
        93: "brightYellow",
        94: "brightBlue",
        95: "brightMagenta",
        96: "brightCyan",
        97: "brightWhite",
      };

  return base[code] ?? bright[code];
}

function normalizeKeyEvent(event: KeyEvent): string | null {
  // Ctrl+C
  if (event.ctrl && event.name === "c") return "\x03";

  // Arrows
  if (event.name === "up") return "\x1b[A";
  if (event.name === "down") return "\x1b[B";

  // Enter
  if (event.name === "return" || event.name === "linefeed") return "\r";

  // Space
  if (event.name === "space") return " ";

  // Letters/digits/punctuation
  if (typeof event.name === "string" && event.name.length === 1) {
    return event.name;
  }

  return null;
}

/**
 * Fallback plain-text renderer that writes to stderr using ANSI escape codes.
 * Uses alternate screen buffer for clean terminal management.
 */
export class PlainRenderer implements TuiRenderer {
  private keypressHandler: ((key: string) => void) | null = null;
  private stdinRawMode = false;
  private stdinDataListener: ((data: Buffer) => void) | null = null;

  start(): void {
    // Switch to alternate screen buffer
    process.stderr.write("\x1b[?1049h");
    // Hide cursor
    process.stderr.write("\x1b[?25l");
    // Set up stdin for keypress events
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      this.stdinRawMode = true;

      if (!this.stdinDataListener) {
        this.stdinDataListener = (data: Buffer) => {
          const key = data.toString();
          this.keypressHandler?.(key);
        };
        process.stdin.on("data", this.stdinDataListener);
      }
    }
  }

  render(content: string): void {
    // Clear screen and move to top-left
    process.stderr.write("\x1b[2J\x1b[H");
    process.stderr.write(content);
  }

  destroy(): void {
    if (this.stdinDataListener) {
      try {
        process.stdin.removeListener("data", this.stdinDataListener);
      } catch {
        // ignore
      }
      this.stdinDataListener = null;
    }
    if (this.stdinRawMode) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    // Show cursor
    process.stderr.write("\x1b[?25h");
    // Switch back from alternate screen
    process.stderr.write("\x1b[?1049l");
  }

  onKeypress(handler: (key: string) => void): void {
    this.keypressHandler = handler;
  }
}
