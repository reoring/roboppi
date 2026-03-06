/**
 * Atomic JSON write helper for Agents.
 *
 * Writes to a temp file under a `tmp/` directory then `rename()`s into the
 * final location.  This ensures readers never see partial files.
 */
import { writeFile, rename, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Atomically write `data` as JSON to `destPath`.
 *
 * @param tmpDir  Directory for temp files (e.g. `_agents/mailbox/tmp/`).
 * @param destPath  Final destination path.
 * @param data  Serialisable value.
 */
export async function atomicJsonWrite(
  tmpDir: string,
  destPath: string,
  data: unknown,
): Promise<void> {
  await mkdir(tmpDir, { recursive: true });
  await mkdir(dirname(destPath), { recursive: true });

  const tmpPath = resolve(tmpDir, `${randomUUID()}.tmp`);
  const json = JSON.stringify(data, null, 2) + "\n";
  await writeFile(tmpPath, json, "utf-8");
  await rename(tmpPath, destPath);
}

/**
 * Atomically append a single JSON line to a JSONL file.
 *
 * Uses O_APPEND which is atomic for writes under the OS page size on all
 * major filesystems.  Each entry is well under 4 KB so this is safe for
 * concurrent appenders.
 */
export async function atomicJsonlAppend(
  filePath: string,
  entry: unknown,
): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  const line = JSON.stringify(entry) + "\n";
  await appendFile(filePath, line, "utf-8");
}
