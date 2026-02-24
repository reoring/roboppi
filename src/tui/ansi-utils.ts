type AnsiTruncateOptions = {
  ellipsis?: string;
};

export function ansiWrap(input: string, maxWidth: number): string[] {
  const width = Math.max(0, Math.floor(maxWidth));
  if (width <= 0) return [""];

  const rawLines = input.split("\n");
  const out: string[] = [];

  for (const raw of rawLines) {
    if (raw.length === 0) {
      out.push("");
      continue;
    }

    let line = "";
    let w = 0;

    for (let i = 0; i < raw.length; ) {
      const c = raw.charCodeAt(i);
      if (c === 27 /* ESC */ && raw[i + 1] === "[") {
        const end = scanCsi(raw, i);
        if (end === -1) break;
        line += raw.slice(i, end);
        i = end;
        continue;
      }

      const cp = raw.codePointAt(i)!;
      const cpStr = String.fromCodePoint(cp);
      const cpW = codePointWidth(cp, cpStr);

      // Keep combining marks attached to the prior cell.
      if (cpW > 0 && w + cpW > width) {
        out.push(line);
        line = "";
        w = 0;
      }

      line += cpStr;
      if (cpW > 0) {
        // If a single code point is wider than maxWidth, still render it.
        w += cpW;
      }

      i += cp > 0xffff ? 2 : 1;
    }

    out.push(line);
  }

  return out;
}

export function stripAnsi(input: string): string {
  // Remove all ANSI escape sequences (CSI/OSC/other). Keep visible text.
  let out = "";
  for (let i = 0; i < input.length; ) {
    const c = input.charCodeAt(i);

    if (c === 27 /* ESC */) {
      const next = input[i + 1];

      // CSI: ESC [ ... <final>
      if (next === "[") {
        let j = i + 2;
        while (j < input.length) {
          const cj = input.charCodeAt(j);
          if (cj >= 0x40 && cj <= 0x7e) break;
          j++;
        }
        if (j >= input.length) break;
        i = j + 1;
        continue;
      }

      // OSC: ESC ] ... BEL or ST (ESC \\)
      if (next === "]") {
        let j = i + 2;
        while (j < input.length) {
          const cj = input.charCodeAt(j);
          if (cj === 7 /* BEL */) {
            j++;
            break;
          }
          if (cj === 27 /* ESC */ && input[j + 1] === "\\") {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }

      // Other escapes: drop ESC and continue.
      i++;
      continue;
    }

    out += input[i]!;
    i++;
  }

  return out;
}

export function sanitizeForTui(input: string): string {
  // Make arbitrary text safe to embed in our own ANSI-rendered UI.
  // - Drop carriage returns (they reposition the cursor in real terminals)
  // - Drop non-SGR escape sequences (cursor moves, clears, etc.)
  // - Keep SGR sequences (\x1b[...m) so colored logs remain readable
  // - Drop other C0 control chars (except \n and \t)

  let out = "";
  for (let i = 0; i < input.length; ) {
    const c = input.charCodeAt(i);

    // \r
    if (c === 13) {
      i++;
      continue;
    }

    if (c === 27 /* ESC */) {
      const next = input[i + 1];

      // CSI: ESC [ ... <final>
      if (next === "[") {
        let j = i + 2;
        while (j < input.length) {
          const cj = input.charCodeAt(j);
          if (cj >= 0x40 && cj <= 0x7e) break;
          j++;
        }
        if (j >= input.length) {
          // Truncated escape sequence; drop the rest.
          break;
        }
        const finalByte = input[j]!;
        if (finalByte === "m") {
          out += input.slice(i, j + 1);
        }
        i = j + 1;
        continue;
      }

      // OSC: ESC ] ... BEL or ST (ESC \\)
      if (next === "]") {
        let j = i + 2;
        while (j < input.length) {
          const cj = input.charCodeAt(j);
          if (cj === 7 /* BEL */) {
            j++;
            break;
          }
          if (cj === 27 /* ESC */ && input[j + 1] === "\\") {
            j += 2;
            break;
          }
          j++;
        }
        i = j;
        continue;
      }

      // Other escapes: drop ESC and continue.
      i++;
      continue;
    }

    // Other C0 controls (keep \n, \t). ESC is handled above.
    if (c < 32 && c !== 10 && c !== 9) {
      i++;
      continue;
    }

    out += input[i]!;
    i++;
  }

  return out;
}

export function ansiWidth(input: string): number {
  let w = 0;
  forEachVisibleCodePoint(input, (_cp, cpWidth) => {
    w += cpWidth;
  });
  return w;
}

export function ansiTruncate(
  input: string,
  maxWidth: number,
  opts: AnsiTruncateOptions = {},
): string {
  if (maxWidth <= 0) return "";

  const ellipsis = opts.ellipsis ?? "...";
  const inputWidth = ansiWidth(input);
  if (inputWidth <= maxWidth) return input;

  const ellW = stringWidth(ellipsis);
  if (ellipsis && ellW > 0 && maxWidth <= ellW) {
    return ellipsis;
  }
  const target = ellW > 0 && maxWidth > ellW ? maxWidth - ellW : maxWidth;

  let out = "";
  let w = 0;
  let hasSgr = false;
  let i = 0;
  while (i < input.length && w < target) {
    const c = input.charCodeAt(i);
    if (c === 27 /* ESC */ && input[i + 1] === "[") {
      const end = scanCsi(input, i);
      if (end === -1) break;
      const seq = input.slice(i, end);
      if (seq.endsWith("m")) {
        out += seq;
        hasSgr = true;
      }
      i = end;
      continue;
    }

    const cp = input.codePointAt(i)!;
    const cpStr = String.fromCodePoint(cp);
    const cpW = codePointWidth(cp, cpStr);
    if (w + cpW > target) break;
    out += cpStr;
    w += cpW;
    i += cp > 0xffff ? 2 : 1;
  }

  if (ellipsis && ellW > 0 && ellW <= maxWidth) {
    out += ellipsis;
  }

  // Avoid style bleed in real terminals when we cut a line.
  if (hasSgr && !out.endsWith("\x1b[0m")) out += "\x1b[0m";
  return out;
}

export function ansiPadEnd(input: string, targetWidth: number): string {
  if (targetWidth <= 0) return "";
  const truncated = ansiTruncate(input, targetWidth, { ellipsis: "" });
  const w = ansiWidth(truncated);
  if (w >= targetWidth) return truncated;
  return truncated + " ".repeat(targetWidth - w);
}

export function ansiFit(input: string, width: number): string {
  return ansiPadEnd(input, width);
}

function scanCsi(input: string, start: number): number {
  // Returns index *after* the CSI sequence (ESC [ ... finalByte), or -1 if truncated.
  let j = start + 2;
  while (j < input.length) {
    const cj = input.charCodeAt(j);
    if (cj >= 0x40 && cj <= 0x7e) return j + 1;
    j++;
  }
  return -1;
}

function forEachVisibleCodePoint(
  input: string,
  cb: (cp: number, cpWidth: number) => void,
): void {
  for (let i = 0; i < input.length; ) {
    const c = input.charCodeAt(i);
    if (c === 27 /* ESC */ && input[i + 1] === "[") {
      const end = scanCsi(input, i);
      if (end === -1) return;
      i = end;
      continue;
    }

    const cp = input.codePointAt(i)!;
    const cpStr = String.fromCodePoint(cp);
    cb(cp, codePointWidth(cp, cpStr));
    i += cp > 0xffff ? 2 : 1;
  }
}

const MARK_RE = /\p{Mark}/u;

function codePointWidth(cp: number, cpStr: string): number {
  // Control characters
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return 0;
  // Combining marks
  if (MARK_RE.test(cpStr)) return 0;
  // Fullwidth / wide
  if (isFullwidthCodePoint(cp)) return 2;
  return 1;
}

function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    w += codePointWidth(cp, ch);
  }
  return w;
}

function isFullwidthCodePoint(codePoint: number): boolean {
  // Matches the common terminal fullwidth ranges.
  if (codePoint < 0x1100) return false;

  return (
    codePoint <= 0x115f ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
