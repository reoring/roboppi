import path from "node:path";

let cachedProbe: Promise<boolean> | null = null;

function isBunExecutable(executablePath: string): boolean {
  const base = path.basename(executablePath).toLowerCase();
  return base === "bun" || base === "bun.exe";
}

export async function supportsChildBunStdinPipe(): Promise<boolean> {
  if (!isBunExecutable(process.execPath)) {
    // The known stdin pipe issue is Bun-runtime specific.
    return true;
  }

  if (cachedProbe) return cachedProbe;

  cachedProbe = new Promise<boolean>((resolve) => {
    const token = `probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const script =
      "process.stdin.setEncoding('utf8');" +
      "process.stdin.on('data', (chunk) => { process.stdout.write(String(chunk)); process.exit(0); });" +
      "process.stdin.resume();" +
      "setTimeout(() => process.exit(2), 1200);";

    // IMPORTANT: use Bun.spawn here to match the actual supervised runner,
    // which spawns the Core process via Bun.spawn (ProcessManager).
    // The stdin-pipe issue can differ between node:child_process.spawn and Bun.spawn.
    const bunAny = (globalThis as unknown as { Bun?: typeof Bun }).Bun;
    if (!bunAny) {
      resolve(false);
      return;
    }

    const child = bunAny.spawn({
      cmd: [process.execPath, "-e", script],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env },
    });

    let stdout = "";
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
      resolve(value);
    };

    // Read stdout until token observed or timeout.
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          stdout += decoder.decode(value, { stream: true });
          if (stdout.includes(token)) {
            finish(true);
            return;
          }
        }
      } catch {
        finish(false);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
      finish(stdout.includes(token));
    })();

    try {
      child.stdin.write(new TextEncoder().encode(`${token}\n`));
      child.stdin.flush();
      child.stdin.end();
    } catch {
      finish(false);
      return;
    }

    setTimeout(() => finish(stdout.includes(token)), 2000);
  });

  return cachedProbe;
}
