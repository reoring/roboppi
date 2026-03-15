import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { globMatch } from "../daemon/events/fswatch-source.js";
import type {
  ExternalTaskRef,
  FileInboxTaskSourceConfig,
  TaskEnvelope,
  TaskPriority,
  TaskRepositoryRef,
  TaskSource,
  TaskSourceUpdate,
} from "./types.js";

interface FileInboxTaskDocument {
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  priority?: unknown;
  repository?: unknown;
  requested_action?: unknown;
  requested_by?: unknown;
  metadata?: unknown;
  timestamps?: unknown;
  url?: unknown;
}

export class FileInboxSource implements TaskSource {
  private readonly inboxPath: string;
  private readonly pattern: string;

  constructor(
    private readonly sourceId: string,
    config: FileInboxTaskSourceConfig,
    baseDir: string = process.cwd(),
  ) {
    this.inboxPath = path.isAbsolute(config.path)
      ? config.path
      : path.resolve(baseDir, config.path);
    this.pattern = config.pattern ?? "*.json";
  }

  async listCandidates(signal?: AbortSignal): Promise<ExternalTaskRef[]> {
    const files = await walkFiles(this.inboxPath, signal);
    const candidates: ExternalTaskRef[] = [];

    for (const filePath of files) {
      const relative = toPosixPath(path.relative(this.inboxPath, filePath));
      if (!globMatch(this.pattern, relative)) continue;
      const fileStat = await stat(filePath);
      candidates.push({
        source_id: this.sourceId,
        external_id: relative,
        revision: buildRevision(fileStat.mtimeMs, fileStat.size),
        url: `file://${filePath}`,
      });
    }

    candidates.sort((a, b) => a.external_id.localeCompare(b.external_id));
    return candidates;
  }

  async fetchEnvelope(
    ref: ExternalTaskRef,
    signal?: AbortSignal,
  ): Promise<TaskEnvelope> {
    throwIfAborted(signal);
    const relative = normalizeRelativeExternalId(ref.external_id);
    const filePath = path.join(this.inboxPath, relative);
    const raw = await Bun.file(filePath).text();
    throwIfAborted(signal);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Invalid JSON in file inbox task "${relative}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`File inbox task "${relative}" must be a JSON object`);
    }
    const doc = parsed as FileInboxTaskDocument;
    const fileStat = await stat(filePath);

    const title = asNonEmptyString(doc.title, `${relative}.title`);
    const body = typeof doc.body === "string" ? doc.body : "";
    const labels = asStringArray(doc.labels, `${relative}.labels`);
    const priority = asPriority(doc.priority, `${relative}.priority`);
    const repository = asRepository(doc.repository, `${relative}.repository`, path.dirname(filePath));
    const requestedAction =
      typeof doc.requested_action === "string" && doc.requested_action.trim() !== ""
        ? doc.requested_action
        : "implement";
    const timestamps = asTimestamps(
      doc.timestamps,
      `${relative}.timestamps`,
      fileStat.birthtimeMs || fileStat.mtimeMs,
      fileStat.mtimeMs,
    );

    return {
      version: "1",
      task_id: `file_inbox:${this.sourceId}:${relative}`,
      source: {
        kind: "file_inbox",
        system_id: "file_inbox",
        external_id: relative,
        url: typeof doc.url === "string" ? doc.url : ref.url,
        revision: ref.revision ?? buildRevision(fileStat.mtimeMs, fileStat.size),
      },
      title,
      body,
      labels,
      priority,
      repository,
      requested_action: requestedAction,
      requested_by:
        typeof doc.requested_by === "string" && doc.requested_by.trim() !== ""
          ? doc.requested_by
          : undefined,
      metadata:
        typeof doc.metadata === "object" &&
        doc.metadata !== null &&
        !Array.isArray(doc.metadata)
          ? (doc.metadata as Record<string, unknown>)
          : undefined,
      timestamps,
    };
  }

  async ack(update: TaskSourceUpdate, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    const ackFile = path.join(
      this.inboxPath,
      ".roboppi-acks",
      `${normalizeRelativeExternalId(update.task_id.replace(`file_inbox:${this.sourceId}:`, ""))}.ack.json`,
    );
    await mkdir(path.dirname(ackFile), { recursive: true });
    await Bun.write(
      ackFile,
      JSON.stringify(
        {
          ...update,
          acknowledged_at: Date.now(),
        },
        null,
        2,
      ) + "\n",
    );
  }
}

async function walkFiles(rootDir: string, signal?: AbortSignal): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(rootDir, { withFileTypes: true }).catch((err: unknown) => {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") return [];
    throw err;
  });

  for (const entry of entries) {
    throwIfAborted(signal);
    if (entry.name === ".roboppi-acks") continue;
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkFiles(fullPath, signal);
      results.push(...nested);
      continue;
    }
    if (entry.isFile()) {
      results.push(fullPath);
    }
  }

  return results;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${field}" must be a non-empty string`);
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`"${field}" must be an array of strings`);
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`"${field}" must contain only strings`);
    }
    items.push(item);
  }
  return items;
}

function asPriority(value: unknown, field: string): TaskPriority {
  if (value === undefined) return "normal";
  if (value === "low" || value === "normal" || value === "high" || value === "urgent") {
    return value;
  }
  throw new Error(`"${field}" must be one of: low, normal, high, urgent`);
}

function asRepository(
  value: unknown,
  field: string,
  baseDir: string,
): TaskRepositoryRef | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`"${field}" must be an object`);
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id.trim() === "") {
    throw new Error(`"${field}.id" must be a non-empty string`);
  }

  return {
    id: obj.id,
    default_branch:
      typeof obj.default_branch === "string" && obj.default_branch.trim() !== ""
        ? obj.default_branch
        : undefined,
    local_path:
      typeof obj.local_path === "string" && obj.local_path.trim() !== ""
        ? (path.isAbsolute(obj.local_path)
            ? obj.local_path
            : path.resolve(baseDir, obj.local_path))
        : undefined,
  };
}

function asTimestamps(
  value: unknown,
  field: string,
  defaultCreatedAt: number,
  defaultUpdatedAt: number,
): { created_at: number; updated_at: number } {
  if (value === undefined) {
    return {
      created_at: Math.floor(defaultCreatedAt),
      updated_at: Math.floor(defaultUpdatedAt),
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`"${field}" must be an object`);
  }
  const obj = value as Record<string, unknown>;
  const createdAt =
    typeof obj.created_at === "number" && Number.isFinite(obj.created_at)
      ? Math.floor(obj.created_at)
      : Math.floor(defaultCreatedAt);
  const updatedAt =
    typeof obj.updated_at === "number" && Number.isFinite(obj.updated_at)
      ? Math.floor(obj.updated_at)
      : Math.floor(defaultUpdatedAt);
  return {
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function buildRevision(mtimeMs: number, size: number): string {
  return `${Math.floor(mtimeMs)}:${size}`;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizeRelativeExternalId(value: string): string {
  const normalized = path.normalize(value);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid external task id path: ${value}`);
  }
  return normalized;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Aborted");
  }
}
