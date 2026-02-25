import { spawnSync } from "node:child_process";

export type ClipboardCopyResult = {
  ok: boolean;
  method?: string;
};

export function copyToClipboard(text: string): ClipboardCopyResult {
  const t = text;

  // Prefer system clipboard commands (doesn't interfere with TUI rendering).
  for (const cmd of selectClipboardCommands()) {
    const ok = tryCopyViaCommand(cmd.bin, cmd.args, t);
    if (ok) return { ok: true, method: cmd.bin };
  }

  // Fallback: OSC52 (supported by many terminals / SSH).
  if (tryCopyViaOsc52(t)) return { ok: true, method: "osc52" };

  return { ok: false };
}

function selectClipboardCommands(): Array<{ bin: string; args: string[] }> {
  const platform = process.platform;
  if (platform === "darwin") return [{ bin: "pbcopy", args: [] }];

  if (platform === "win32") {
    // Prefer PowerShell when available, fall back to clip.exe.
    return [
      { bin: "powershell.exe", args: ["-NoProfile", "-Command", "Set-Clipboard"] },
      { bin: "cmd.exe", args: ["/c", "clip"] },
    ];
  }

  // linux / others
  const isWayland = Boolean(process.env.WAYLAND_DISPLAY);
  const isX11 = Boolean(process.env.DISPLAY);

  const wl = { bin: "wl-copy", args: [] };
  const xclip = { bin: "xclip", args: ["-selection", "clipboard"] };
  const xsel = { bin: "xsel", args: ["--clipboard", "--input"] };

  if (isWayland) return [wl, xclip, xsel];
  if (isX11) return [xclip, xsel, wl];
  return [wl, xclip, xsel];
}

function tryCopyViaCommand(bin: string, args: string[], text: string): boolean {
  try {
    const res = spawnSync(bin, args, {
      input: text,
      stdio: ["pipe", "ignore", "ignore"],
      env: process.env,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

function tryCopyViaOsc52(text: string): boolean {
  if (!process.stderr.isTTY) return false;

  try {
    const b64 = Buffer.from(text, "utf8").toString("base64");
    // OSC 52: set clipboard (c)
    // Some terminals require BEL (\x07) to terminate.
    process.stderr.write(`\x1b]52;c;${b64}\x07`);
    return true;
  } catch {
    return false;
  }
}
