import { mkdir, rename, unlink } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import type { DaemonState, ExecutionRecord, TriggerState } from "./types.js";
import type { WorkflowState } from "../workflow/types.js";

export class DaemonStateStore {
  private readonly stateDir: string;
  private readonly maxHistory: number;

  constructor(stateDir: string, maxHistory = 100) {
    this.stateDir = stateDir;
    this.maxHistory = maxHistory;
  }

  // ---------------------------------------------------------------------------
  // Daemon-level state
  // ---------------------------------------------------------------------------

  async getDaemonState(): Promise<DaemonState | null> {
    return this.readJson<DaemonState>(this.daemonStatePath());
  }

  async saveDaemonState(state: DaemonState): Promise<void> {
    await this.writeJson(this.daemonStatePath(), state);
  }

  // ---------------------------------------------------------------------------
  // Per-trigger state
  // ---------------------------------------------------------------------------

  async getTriggerState(triggerId: string): Promise<TriggerState> {
    const existing = await this.readJson<TriggerState>(
      this.triggerStatePath(triggerId),
    );
    if (existing) return existing;
    return defaultTriggerState();
  }

  async saveTriggerState(
    triggerId: string,
    state: TriggerState,
  ): Promise<void> {
    await this.writeJson(this.triggerStatePath(triggerId), state);
  }

  // ---------------------------------------------------------------------------
  // Last result per trigger
  // ---------------------------------------------------------------------------

  async getLastResult(triggerId: string): Promise<WorkflowState | null> {
    return this.readJson<WorkflowState>(this.lastResultPath(triggerId));
  }

  async saveLastResult(
    triggerId: string,
    result: WorkflowState,
  ): Promise<void> {
    await this.writeJson(this.lastResultPath(triggerId), result);
  }

  // ---------------------------------------------------------------------------
  // Execution history
  // ---------------------------------------------------------------------------

  async recordExecution(record: ExecutionRecord): Promise<void> {
    const historyDir = this.historyDir(record.triggerId);
    const filePath = `${historyDir}/${record.completedAt}.json`;
    await this.writeJson(filePath, record);

    // Prune oldest entries if over maxHistory
    try {
      const files = await readdir(historyDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
      if (jsonFiles.length > this.maxHistory) {
        const toDelete = jsonFiles.slice(0, jsonFiles.length - this.maxHistory);
        for (const file of toDelete) {
          await unlink(`${historyDir}/${file}`).catch(() => {});
        }
      }
    } catch {
      // History dir may not exist yet or be inaccessible — ignore
    }
  }

  async getHistory(
    triggerId: string,
    limit: number,
  ): Promise<ExecutionRecord[]> {
    const dir = this.historyDir(triggerId);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }

    const jsonFiles = files
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, limit);

    const records: ExecutionRecord[] = [];
    for (const file of jsonFiles) {
      const record = await this.readJson<ExecutionRecord>(`${dir}/${file}`);
      if (record) records.push(record);
    }
    return records;
  }

  // ---------------------------------------------------------------------------
  // Path helpers
  // ---------------------------------------------------------------------------

  private daemonStatePath(): string {
    return `${this.stateDir}/daemon.json`;
  }

  private triggerDir(triggerId: string): string {
    return `${this.stateDir}/triggers/${triggerId}`;
  }

  private triggerStatePath(triggerId: string): string {
    return `${this.triggerDir(triggerId)}/state.json`;
  }

  private lastResultPath(triggerId: string): string {
    return `${this.triggerDir(triggerId)}/last-result.json`;
  }

  private historyDir(triggerId: string): string {
    return `${this.triggerDir(triggerId)}/history`;
  }

  // ---------------------------------------------------------------------------
  // File I/O helpers
  // ---------------------------------------------------------------------------

  private async readJson<T>(path: string): Promise<T | null> {
    try {
      const file = Bun.file(path);
      const text = await file.text();
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    // Atomic write: write to temp file, then rename for crash safety
    const tmpPath = filePath + ".tmp";
    const content = JSON.stringify(data, null, 2);
    await Bun.write(tmpPath, content);
    try {
      await rename(tmpPath, filePath);
    } catch {
      // Fallback to direct write if rename fails (e.g., cross-device or dir removed)
      await Bun.write(filePath, content);
    }
  }
}

export function defaultTriggerState(): TriggerState {
  return {
    enabled: true,
    lastFiredAt: null,
    cooldownUntil: null,
    executionCount: 0,
    consecutiveFailures: 0,
  };
}
