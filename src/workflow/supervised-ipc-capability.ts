import path from "node:path";

const cachedProbes = new Map<string, Promise<boolean>>();

const BUN_SCRIPT_EXTENSIONS = new Set([".ts", ".js", ".tsx", ".jsx"]);

function isBunExecutable(executablePath: string): boolean {
  const base = path.basename(executablePath).toLowerCase();
  return base === "bun" || base === "bun.exe";
}

type RuntimeVersions = NodeJS.ProcessVersions & { bun?: string };

function isBunScriptEntryPoint(childEntryPoint: string | undefined): boolean {
  if (!childEntryPoint) return false;
  return BUN_SCRIPT_EXTENSIONS.has(path.extname(childEntryPoint).toLowerCase());
}

export function isBunRuntime(
  executablePath: string = process.execPath,
  versions: RuntimeVersions = process.versions,
): boolean {
  return typeof versions.bun === "string" && versions.bun.trim() !== ""
    ? true
    : isBunExecutable(executablePath);
}

export function usesBunChildRuntime(
  childEntryPoint: string | undefined,
  executablePath: string = process.execPath,
  versions: RuntimeVersions = process.versions,
): boolean {
  return isBunScriptEntryPoint(childEntryPoint) || isBunRuntime(executablePath, versions);
}

function resolveProbeCommand(
  childEntryPoint: string | undefined,
  executablePath: string = process.execPath,
  versions: RuntimeVersions = process.versions,
): string[] | null {
  if (isBunScriptEntryPoint(childEntryPoint)) {
    return ["bun", "-e"];
  }
  if (isBunExecutable(executablePath)) {
    return [executablePath, "-e"];
  }
  if (typeof versions.bun === "string" && versions.bun.trim() !== "") {
    // Bun-compiled binaries spawn as executables, but they do not support `-e`.
    // Prefer the safer socket transport instead of probing with a mismatched command.
    return null;
  }
  return null;
}

export async function supportsChildBunStdinPipe(
  childEntryPoint?: string,
  executablePath: string = process.execPath,
  versions: RuntimeVersions = process.versions,
): Promise<boolean> {
  if (!usesBunChildRuntime(childEntryPoint, executablePath, versions)) {
    // The known stdin pipe issue is Bun-runtime specific.
    return true;
  }

  const probeCommand = resolveProbeCommand(childEntryPoint, executablePath, versions);
  if (!probeCommand) {
    return false;
  }

  const cacheKey = probeCommand.join("\0");
  const cached = cachedProbes.get(cacheKey);
  if (cached) return cached;

  const probe = new Promise<boolean>((resolve) => {
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
      cmd: [...probeCommand, script],
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

  cachedProbes.set(cacheKey, probe);
  return probe;
}
