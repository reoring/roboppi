import type { LogEntry, LogSink } from "../core/observability.js";
import { RingBuffer } from "./ring-buffer.js";
import type { TuiRenderer } from "./opentui-platform.js";
import { PassiveAnsiRenderer } from "./passive-ansi-renderer.js";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "[unserializable]";
  }
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, max);
  return s.slice(0, max - 3) + "...";
}

function levelColor(level: string): string {
  switch (level) {
    case "debug":
      return "\x1b[90m";
    case "info":
      return "\x1b[36m";
    case "warn":
      return "\x1b[33m";
    case "error":
    case "fatal":
      return "\x1b[31m";
    default:
      return "";
  }
}

function formatLogLine(entry: LogEntry, width: number): string {
  const t = formatTime(entry.timestamp);
  const lvl = entry.level;
  const lvlColored = `${levelColor(lvl)}${lvl}\x1b[0m`;
  const base = `${t} ${lvlColored} ${entry.component}: ${entry.message}`;
  const data = entry.data !== undefined ? ` ${truncate(safeJson(entry.data), Math.max(0, width - base.length - 1))}` : "";
  return truncate(base + data, width);
}

export interface CoreServerTuiOptions {
  title?: string;
  renderer?: TuiRenderer;
}

export class CoreServerTui {
  private readonly renderer: TuiRenderer;
  private readonly title: string;

  private readonly startedAt = Date.now();
  private readonly logs = new RingBuffer<string>({ maxLines: 3000, maxBytes: 1024 * 1024 });
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = true;

  private transport: string = "stdio";

  constructor(opts: CoreServerTuiOptions = {}) {
    this.renderer = opts.renderer ?? new PassiveAnsiRenderer();
    this.title = opts.title ?? "roboppi core";
  }

  get logSink(): LogSink {
    return (entry) => {
      const width = (process.stderr.columns ?? 120);
      this.logs.push(formatLogLine(entry, width));

      // Best-effort: infer transport from the startup log.
      if (entry.message.includes("awaiting IPC messages")) {
        const data = entry.data;
        if (data && typeof data === "object") {
          const transport = (data as Record<string, unknown>).transport;
          if (typeof transport === "string") this.transport = transport;
        }
      }

      this.dirty = true;
    };
  }

  start(): void {
    this.renderer.start();

    this.renderTimer = setInterval(() => {
      if (!this.dirty) return;
      this.dirty = false;
      this.renderFrame();
    }, 100);

    this.renderFrame();
  }

  stop(): void {
    if (this.renderTimer) {
      clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
    this.renderer.destroy();
  }

  private renderFrame(): void {
    const columns = process.stderr.columns ?? 80;
    const rows = process.stderr.rows ?? 24;

    const uptimeS = Math.floor((Date.now() - this.startedAt) / 1000);
    const header1 = `\x1b[1m${this.title}\x1b[0m  transport=${this.transport}  uptime=${uptimeS}s`;
    const header2 = `stdin/stdout: JSONL IPC (server)  logs: TUI (stderr)  help: --help  stop: Ctrl+C  plain: --no-tui`;
    const sep = "-".repeat(Math.max(0, Math.min(columns, 120)));

    const headerLines = [truncate(header1, columns), truncate(header2, columns), sep];
    const bodyHeight = Math.max(0, rows - headerLines.length - 1);

    const lines = this.logs.lines();
    const visible = lines.slice(Math.max(0, lines.length - bodyHeight));
    const padded: string[] = [];
    for (const line of visible) padded.push(truncate(line, columns));
    while (padded.length < bodyHeight) padded.unshift("");

    const out = headerLines.join("\n") + "\n" + padded.join("\n") + "\n";
    this.renderer.render(out);
  }
}
