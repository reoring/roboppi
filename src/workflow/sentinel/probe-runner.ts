import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Probe output / result types
// ---------------------------------------------------------------------------

export interface ProbeOutput {
  class?: "progressing" | "stalled" | "terminal";
  digest?: string;
  fingerprints?: string[];
  reasons?: string[];
  summary?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProbeResult {
  success: boolean;
  output?: ProbeOutput;
  digest: string;
  error?: string;
  exitCode?: number;
  stderr?: string;
  ts: number;
}

// ---------------------------------------------------------------------------
// ProbeRunner — executes a probe command and parses its JSON output
// ---------------------------------------------------------------------------

const MAX_PROBE_OUTPUT_BYTES = 64 * 1024; // 64 KB
const MAX_PROBE_STDERR_BYTES = 4 * 1024; // 4 KB

export class ProbeRunner {
  private command: string;
  private timeoutMs: number;
  private cwd?: string;
  private requireZeroExit: boolean;
  private env?: Record<string, string>;

  constructor(command: string, timeoutMs: number, cwd?: string, requireZeroExit: boolean = false, env?: Record<string, string>) {
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.cwd = cwd;
    this.requireZeroExit = requireZeroExit;
    this.env = env;
  }

  async run(): Promise<ProbeResult> {
    const ts = Date.now();
    try {
      const proc = Bun.spawn(["sh", "-c", this.command], {
        cwd: this.cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...(this.env ?? {}) },
      });

      // Hard timeout: kill the probe if it exceeds the deadline.
      const timeoutId = setTimeout(() => proc.kill(), this.timeoutMs);

      // Read stdout and stderr concurrently to avoid deadlocks.
      // readBoundedDrain reads up to maxBytes into memory, then drains the
      // remainder without storing it.  This prevents pipe-full blocking when
      // the process emits more data than the limit.
      const [stdoutChunks, stderrText] = await Promise.all([
        this.readBoundedDrain(
          proc.stdout as ReadableStream<Uint8Array>,
          MAX_PROBE_OUTPUT_BYTES,
          proc,
        ),
        this.readBoundedStringDrain(
          proc.stderr as ReadableStream<Uint8Array>,
          MAX_PROBE_STDERR_BYTES,
          proc,
        ),
      ]);

      // Wait for process to exit and get exit code, then clear the timeout.
      // Clearing AFTER exit ensures the hard timeout stays active until the
      // process is fully reaped (avoids hanging on proc.exited).
      const exitCode = await proc.exited;
      clearTimeout(timeoutId);

      const bounded = new TextDecoder()
        .decode(Buffer.concat(stdoutChunks.chunks))
        .slice(0, MAX_PROBE_OUTPUT_BYTES);

      // Probe MUST emit valid JSON.
      let output: ProbeOutput;
      try {
        output = JSON.parse(bounded.trim());
      } catch {
        return {
          success: false,
          digest: "",
          error: "probe output is not valid JSON",
          exitCode,
          stderr: stderrText || undefined,
          ts,
        };
      }

      // Compute digest: prefer explicit `digest` field from the probe, fall
      // back to a hash of the normalised JSON.
      const digest = output.digest ?? this.computeDigest(output);

      // Check exit code when require_zero_exit is enabled
      if (this.requireZeroExit && exitCode !== 0) {
        return {
          success: false,
          output,  // Include parsed output for diagnostic purposes
          digest,
          error: `probe exited with non-zero code ${exitCode} (require_zero_exit is enabled)`,
          exitCode,
          stderr: stderrText || undefined,
          ts,
        };
      }

      return { success: true, output, digest, exitCode, ts };
    } catch (err) {
      return {
        success: false,
        digest: "",
        error: err instanceof Error ? err.message : String(err),
        ts,
      };
    }
  }

  /**
   * Read up to `maxBytes` from a stream into memory, then drain any remaining
   * data without storing it.  If the process is still writing after `maxBytes`,
   * it is killed to prevent unbounded pipe blocking.
   */
  private async readBoundedDrain(
    stream: ReadableStream<Uint8Array>,
    maxBytes: number,
    proc: { kill(): void },
  ): Promise<{ chunks: Uint8Array[]; totalBytes: number }> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      // Phase 1: collect up to maxBytes.
      while (totalBytes < maxBytes) {
        const { done, value } = await reader.read();
        if (done) return { chunks, totalBytes };
        chunks.push(value);
        totalBytes += value.byteLength;
      }
      // Phase 2: limit reached — kill the process and drain to EOF so the
      // pipe doesn't block the process exit.
      proc.kill();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
    return { chunks, totalBytes };
  }

  private async readBoundedStringDrain(
    stream: ReadableStream<Uint8Array>,
    maxBytes: number,
    proc: { kill(): void },
  ): Promise<string> {
    try {
      const { chunks } = await this.readBoundedDrain(stream, maxBytes, proc);
      if (chunks.length === 0) return "";
      return new TextDecoder()
        .decode(Buffer.concat(chunks))
        .slice(0, maxBytes);
    } catch {
      return "";
    }
  }

  /**
   * Compute a short digest by hashing the JSON object with sorted keys.
   * The sorted-key approach provides a basic canonicalization that is
   * sufficient when the probe output is a flat or shallow object.
   */
  private computeDigest(obj: ProbeOutput): string {
    const stable = JSON.stringify(obj, Object.keys(obj).sort());
    return createHash("sha256").update(stable).digest("hex").slice(0, 16);
  }
}
