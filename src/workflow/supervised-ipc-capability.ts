import { spawn } from "node:child_process";
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

    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["pipe", "pipe", "ignore"],
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

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(token)) {
        finish(true);
      }
    });
    child.once("error", () => finish(false));
    child.once("exit", () => {
      finish(stdout.includes(token));
    });

    try {
      child.stdin.write(`${token}\n`);
    } catch {
      finish(false);
      return;
    }

    setTimeout(() => finish(stdout.includes(token)), 2000);
  });

  return cachedProbe;
}
