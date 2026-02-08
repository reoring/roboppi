# AgentCore アーキテクチャガイド

このガイドでは AgentCore の内部アーキテクチャを詳しく解説します。設計思想、各レイヤーの責務、データの流れを理解することで、AgentCore の動作原理を把握できます。

---

## 1. 全体構成 --- 3 レイヤーアーキテクチャ

AgentCore は 3 つのレイヤーで構成されています。

```
┌─────────────────────────────────────────────────┐
│  Scheduler（親プロセス / Supervisor）              │
│  JobQueue / InFlightRegistry / RetryPolicy / DLQ │
│  ┌───────────────────────────────────────────┐   │
│  │  AgentCore（子プロセス / Runtime）          │   │
│  │  PermitGate / ExecutionBudget             │   │
│  │  CircuitBreaker / Watchdog                │   │
│  │  EscalationManager / BackpressureCtrl     │   │
│  │  ┌─────────────────────────────────────┐  │   │
│  │  │  Worker Delegation Gateway          │  │   │
│  │  │  Codex CLI / Claude Code / OpenCode │  │   │
│  │  └─────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

| レイヤー | 役割 | プロセス |
|---------|------|---------|
| **Scheduler** | ジョブ管理、重複制御、リトライ、AgentCore の起動監督 | 親プロセス |
| **Core (AgentCore)** | 安全性の不変条件を強制（Permit、遮断、監視、中断） | 子プロセス |
| **Worker** | 実作業（コード編集、テスト実行、コマンド実行） | 外部プロセス |

---

## 2. 設計原則

### 2.1 mechanism と policy の分離

この設計の根幹は「仕組み（mechanism）」と「判断（policy）」の分離にあります。

- **Core = mechanism** --- 「止める」「制限する」「観測する」「隔離する」といった安全性の不変条件を提供します。どんなポリシーに差し替えても、Core が守る制約は破れません。
- **Scheduler = policy** --- 「どの順番で実行するか」「重複をどう扱うか」「リトライをどう判断するか」といった意思決定を担います。運用方針に合わせて差し替え可能です。

### 2.2 delegation-first（実行を抱えない）

AgentCore は **計画・許可・中断・観測** に専念します。コード編集、コマンド実行、テスト実行などの実作業はすべて **Worker（外部プロセス）** に委譲します。

プロセス境界で分離することで:

- Worker の CPU / メモリ枯渇が AgentCore に波及しない
- ハングした Worker を OS レベルで強制停止できる
- 同時実行数を Permit で精密に制御できる

### 2.3 Permit なしでは何も走らない

AgentCore における最も重要な不変条件です。すべてのジョブ実行、Worker 委譲は **Permit（実行許可）** の取得が前提です。Permit 発行時に Budget、Circuit Breaker、Backpressure がチェックされ、安全でない場合は拒否されます。

### 2.4 中断伝搬の一貫性

中断がシステム全体を貫通します:

```
Job 中断
  ↓
Permit.abortController.abort() が発火
  ↓
Core が WorkerAdapter.cancel() を呼び出す
  ↓
Worker プロセスを安全停止（不可なら強制 kill）
```

---

## 3. Core レイヤー（AgentCore）

Core は安全性の不変条件を強制するレイヤーです。以下のコンポーネントで構成されます。

### 3.1 PermitGate --- 実行許可の門番

**ソース:** `src/core/permit-gate.ts`

PermitGate はすべてのジョブ実行に対して Permit（実行許可）を発行するゲートキーパーです。

```typescript
class PermitGate {
  requestPermit(job: Job, attemptIndex: number): Permit | PermitRejection;
  completePermit(permitId: UUID): void;
  cancelPermit(permitId: UUID): void;
  dispose(): void;
}
```

`requestPermit()` は以下の順にチェックを実行します:

1. **Backpressure** --- システムの負荷状態を確認（REJECT なら即拒否）
2. **Circuit Breaker** --- 全 CB の状態を確認（OPEN があれば拒否）
3. **ExecutionBudget** --- 同時実行数・RPS・コスト・試行回数を確認

すべてのチェックを通過した場合のみ `Permit` を返します。Permit には `abortController` が含まれ、中断伝搬のルートになります。

**Permit の構造:**

```typescript
interface Permit {
  permitId: UUID;
  jobId: UUID;
  deadlineAt: Timestamp;           // タイムアウト時刻
  attemptIndex: number;            // 何回目の試行か
  abortController: AbortController; // 中断制御
  tokensGranted: PermitTokens;     // 付与されたリソース枠
  circuitStateSnapshot: Record<string, CircuitState>; // 発行時の CB 状態
}
```

**拒否理由:**

| 理由 | 説明 |
|------|------|
| `GLOBAL_SHED` | Backpressure によるシステム過負荷 |
| `CIRCUIT_OPEN` | Circuit Breaker が OPEN |
| `RATE_LIMIT` | RPS 制限超過 |
| `BUDGET_EXHAUSTED` | コスト上限到達 |
| `CONCURRENCY_LIMIT` | 同時実行数の上限 |
| `FATAL_MODE` | システムが FATAL 状態 |

### 3.2 ExecutionBudget --- リソース制限の強制

**ソース:** `src/core/execution-budget.ts`

ExecutionBudget はリソース消費の上限を強制します。

```typescript
class ExecutionBudget {
  constructor(config: {
    maxConcurrency: number;  // 最大同時 Permit 数
    maxRps: number;          // 1秒あたりの最大リクエスト数
    maxCostBudget?: number;  // 累積コスト上限（任意）
  });

  checkAttempts(jobId: string, attemptIndex: number, maxAttempts: number): boolean;
  tryAcquireSlot(): boolean;
  releaseSlot(): void;
  checkRps(): boolean;
  addCost(amount: number): boolean;
}
```

| 制約 | 説明 |
|------|------|
| `maxConcurrency` | アクティブな Permit の同時実行数上限 |
| `maxRps` | スライディングウィンドウによる RPS 制限 |
| `maxCostBudget` | 累積コストの上限（LLM トークンコスト等） |
| `maxAttempts` | ジョブごとの最大試行回数 |

これらの制約は **Core が強制する不変条件** であり、Scheduler のポリシーでは緩和できません。

### 3.3 CircuitBreakerRegistry --- 連鎖障害の遮断

**ソース:** `src/core/circuit-breaker.ts`

CircuitBreakerRegistry は複数の Circuit Breaker を管理し、外部依存の障害がシステム全体に波及するのを防ぎます。

```typescript
class CircuitBreaker {
  recordSuccess(): void;
  recordFailure(): void;
  isCallPermitted(): boolean;
  getState(): CircuitState;  // CLOSED | HALF_OPEN | OPEN
}

class CircuitBreakerRegistry {
  getOrCreate(key: string, config?: CircuitBreakerConfig): CircuitBreaker;
  getSnapshot(): Record<string, CircuitState>;
  dispose(): void;
}
```

**状態遷移:**

```
CLOSED ---[失敗が failureThreshold に到達]---> OPEN
OPEN   ---[resetTimeoutMs 経過]--------------> HALF_OPEN
HALF_OPEN ---[成功]-------------------------> CLOSED
HALF_OPEN ---[失敗]-------------------------> OPEN
```

**グローバル安全弁:** CircuitBreakerRegistry は **いずれかの CB が OPEN** になると、全ての Permit 要求を拒否します。これにより、1 つの外部依存の障害がシステム全体の安全停止を引き起こす設計です。

**CB の対象:**

| 対象 | 例 |
|------|---|
| LLM Provider | 特定モデルの応答エラー集中 |
| Worker Provider | Codex CLI の頻繁なクラッシュ、Claude Code の応答遅延 |

### 3.4 Watchdog --- 詰まり・遅延の検知

**ソース:** `src/core/watchdog.ts`

Watchdog はシステムの健全性を定期的に監視し、異常を検知すると段階的に防御を発動します。

```typescript
class Watchdog {
  constructor(config: WatchdogConfig);
  registerSource(source: MetricSource): void;
  start(): void;
  stop(): void;
  getDefenseLevel(): DefenseLevel;
}
```

**観測指標:**

| 指標 | 何を監視しているか |
|------|------------------|
| `worker_inflight_count` | 実行中の Worker タスク数 |
| `worker_queue_lag_ms` | Worker キューの遅延 |
| `worker_timeout_rate` | Worker タスクのタイムアウト率 |
| `worker_cancel_latency_ms` | 中断指示が効くまでの時間 |
| `workspace_lock_wait_ms` | workspace 競合の待ち時間 |

**防御レベル（段階的にエスカレーション）:**

```
normal → shed → throttle → circuit_open → escalation
```

### 3.5 EscalationManager --- 致命的障害への段階的対応

**ソース:** `src/core/escalation-manager.ts`

EscalationManager は致命的な障害を検知し、スコープに応じた対応を実行します。

```typescript
class EscalationManager {
  constructor(config?: {
    crashThreshold: number;      // N回/分でFATAL判定
    cancelTimeoutMs: number;     // キャンセル応答の制限時間
    latestWinsThreshold: number; // 同一workspaceのlatest-wins上限
  });
  reportWorkerCrash(workerKind: string): void;
  reportCancelTimeout(handleId: string): void;
  reportLatestWins(workspaceRef: string): void;
}
```

**FATAL 条件:**

- Worker が短時間に連続クラッシュ（`crashThreshold` 回/分）
- キャンセルが効かず「幽霊プロセス」が残留（`cancelTimeoutMs` 超過）
- 同一 workspace への latest-wins が過多（変更が収束しない）

**エスカレーションのスコープとアクション:**

| スコープ | アクション | 説明 |
|---------|-----------|------|
| `WORKER_KIND` | `ISOLATE` / `STOP` | 特定 Worker 種別の停止 |
| `WORKSPACE` | `ISOLATE` | 対象 workspace のロック |
| `GLOBAL` | `STOP` / `NOTIFY` | システム全体の安全停止 |

### 3.6 BackpressureController --- 過負荷時の対応

**ソース:** `src/core/backpressure.ts`

BackpressureController はシステムの負荷状態を監視し、過負荷時に適切な応答を返します。

```typescript
class BackpressureController {
  constructor(thresholds: {
    rejectThreshold: number;   // 拒否閾値
    deferThreshold: number;    // 延期閾値
    degradeThreshold: number;  // 縮退閾値
  });
  check(): BackpressureResponse;  // ACCEPT | REJECT | DEFER | DEGRADE
  updateMetrics(metrics: BackpressureMetrics): void;
}
```

**応答:**

| 応答 | 説明 | 負荷レベル |
|------|------|----------|
| `ACCEPT` | 通常処理 | 低 |
| `DEGRADE` | 機能を縮退して処理 | 中 |
| `DEFER` | 処理を延期 | 高 |
| `REJECT` | 処理を拒否 | 超高 |

---

## 4. Worker レイヤー

Worker レイヤーは実作業（コード編集、テスト実行、コマンド実行）を担当します。Worker は外部プロセスとして実行され、AgentCore からプロセス境界で隔離されています。

### 4.1 WorkerDelegationGateway --- アダプタレジストリと委譲

**ソース:** `src/worker/worker-gateway.ts`

WorkerDelegationGateway はタスクを適切な Worker アダプタにルーティングし、中断伝搬を管理します。

```typescript
class WorkerDelegationGateway {
  registerAdapter(kind: WorkerKind, adapter: WorkerAdapter): void;
  delegateTask(task: WorkerTask, permit: Permit): Promise<WorkerResult>;
  cancelTask(handleId: string): Promise<void>;
}
```

`delegateTask()` の内部動作:

1. `task.workerKind` に対応するアダプタを取得
2. `adapter.startTask(task)` で Worker プロセスを起動
3. `permit.abortController.signal` に `abort` リスナーを登録（中断伝搬）
4. `adapter.awaitResult(handle)` で結果を待機
5. リスナーをクリーンアップし、ハンドルを除去

### 4.2 WorkerAdapter インタフェース

**ソース:** `src/worker/worker-adapter.ts`

WorkerAdapter は各 Worker 種別の差異を吸収する統一インタフェースです。

```typescript
interface WorkerAdapter {
  readonly kind: WorkerKind;
  startTask(task: WorkerTask): Promise<WorkerHandle>;
  streamEvents(handle: WorkerHandle): AsyncIterable<WorkerEvent>;
  cancel(handle: WorkerHandle): Promise<void>;
  awaitResult(handle: WorkerHandle): Promise<WorkerResult>;
}
```

**WorkerHandle:**

```typescript
interface WorkerHandle {
  handleId: UUID;
  workerKind: WorkerKind;
  abortSignal: AbortSignal;
}
```

**WorkerEvent（ストリーム）:**

| type | 内容 |
|------|------|
| `stdout` | 標準出力 |
| `stderr` | 標準エラー出力 |
| `progress` | 進捗報告（メッセージ、パーセント） |
| `patch` | ファイル変更（パス、差分） |

### 4.3 具体的なアダプタ実装

**ソース:** `src/worker/adapters/`

| アダプタ | ファイル | 用途 |
|---------|---------|------|
| `MockWorkerAdapter` | `mock-adapter.ts` | テスト用のモックアダプタ |
| `ClaudeCodeAdapter` | `claude-code-adapter.ts` | Claude Code CLI の呼び出し |
| `CodexCliAdapter` | `codex-cli-adapter.ts` | Codex CLI の呼び出し |
| `OpenCodeAdapter` | `opencode-adapter.ts` | OpenCode CLI の呼び出し |

各アダプタは `ProcessManager` を使って外部プロセスを起動し、Worker の stdout/stderr をストリームとして観測します。

### 4.4 ProcessManager --- プロセスライフサイクル管理

**ソース:** `src/worker/process-manager.ts`

ProcessManager は Worker プロセスの起動、タイムアウト、安全停止を管理します。

```typescript
class ProcessManager {
  spawn(options: SpawnOptions): ManagedProcess;
  gracefulShutdown(pid: number, gracePeriodMs: number): Promise<void>;
  killAll(): Promise<void>;
}
```

**SpawnOptions:**

```typescript
interface SpawnOptions {
  command: string[];       // 実行コマンド
  cwd?: string;           // 作業ディレクトリ
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}
```

安全停止の流れ: SIGTERM 送信 → 猶予期間待機 → 応答なしなら SIGKILL

### 4.5 WorkspaceLock --- 同時編集の防止

**ソース:** `src/worker/workspace-lock.ts`

WorkspaceLock は同一 workspace（ディレクトリ）への同時編集を防止します。

```typescript
class WorkspaceLock {
  acquire(workspaceRef: string, taskId: UUID): boolean;
  release(workspaceRef: string, taskId: UUID): boolean;
}
```

workspace 単位のロックにより、複数の Worker が同じリポジトリを同時に編集してコンフリクトが発生するのを防ぎます。

---

## 5. Scheduler レイヤー

Scheduler は AgentCore を子プロセスとして起動・監督するレイヤーです。ポリシー（判断）を担い、差し替え可能です。

**ソース:** `src/scheduler/index.ts`

### 5.1 Supervisor --- 子プロセスの起動と監督

**ソース:** `src/scheduler/supervisor.ts`

Supervisor は AgentCore を子プロセスとして `spawn` し、stdin/stdout で IPC 接続します。

```typescript
class Supervisor {
  constructor(config?: {
    coreEntryPoint: string;  // AgentCore のエントリポイント
    healthCheck?: HealthCheckerConfig;
    ipc?: IpcProtocolOptions;
  });
  start(): Promise<IpcProtocol>;
  shutdown(): Promise<void>;
  onCrash(callback: (exitCode: number | null) => void): void;
  onHang(callback: () => void): void;
}
```

**障害時の対応:**

| 状況 | 対応 |
|------|------|
| 子プロセスが落ちた | 未完了ジョブを失敗扱い → 再投入 or DLQ |
| 子がハングした | SIGTERM → 猶予期間 → SIGKILL |
| 連続クラッシュ | インスタンス自体を隔離 |

### 5.2 JobQueue --- 優先度キュー

**ソース:** `src/scheduler/job-queue.ts`

JobQueue は優先度付きキューで、INTERACTIVE ジョブが BATCH より先に処理されます。同一クラス内では `priority.value` が高いものが先に出ます。

```typescript
class JobQueue {
  enqueue(job: Job): void;
  dequeue(): Job | undefined;
  peek(): Job | undefined;
  size(): number;
}
```

**優先度クラス:**

| クラス | 用途 |
|--------|------|
| `INTERACTIVE` | ユーザー対話（高優先） |
| `BATCH` | バックグラウンド処理（低優先） |

### 5.3 InFlightRegistry --- 重複制御

**ソース:** `src/scheduler/inflight-registry.ts`

InFlightRegistry は Idempotency Key を使って同一リクエストの重複を制御します。

```typescript
class InFlightRegistry {
  register(key: string, jobId: UUID, policy: DeduplicationPolicy): RegisterResult;
  complete(key: string): void;
}
```

**重複制御ポリシー:**

| ポリシー | 動作 |
|---------|------|
| `COALESCE` | 既存のジョブに合流（結果を共有） |
| `LATEST_WINS` | 既存のジョブをキャンセルし、新しいジョブを実行 |
| `REJECT` | 重複を拒否 |

### 5.4 RetryPolicy --- リトライ判断

**ソース:** `src/scheduler/retry-policy.ts`

RetryPolicy はエラー分類に基づいてリトライの可否と遅延を判断します。

```typescript
class RetryPolicy {
  constructor(config?: {
    baseDelayMs: number;   // 基本遅延（デフォルト: 1000ms）
    maxDelayMs: number;    // 最大遅延（デフォルト: 30000ms）
    maxAttempts: number;   // 最大試行回数（デフォルト: 3）
  });
  shouldRetry(errorClass: ErrorClass, attemptIndex: number): RetryDecision;
}
```

**エラー分類とリトライ可否:**

| ErrorClass | リトライ | 例 |
|-----------|---------|---|
| `RETRYABLE_TRANSIENT` | する | 5xx エラー、ネットワーク障害 |
| `RETRYABLE_RATE_LIMIT` | する | 429 レートリミット |
| `NON_RETRYABLE` | しない | 4xx クライアントエラー |
| `FATAL` | しない | システム障害 |

バックオフ戦略は **exponential backoff + full jitter** を採用しています。

### 5.5 DeadLetterQueue (DLQ) --- 失敗ジョブの保存

**ソース:** `src/scheduler/dlq.ts`

DLQ はリトライ上限に達した、または回復不能と判断されたジョブを保存します。

```typescript
class DeadLetterQueue {
  push(job: Job, reason: string, errorClass?: ErrorClass, attemptCount?: number): void;
  peek(): DlqEntry | undefined;
  pop(): DlqEntry | undefined;
  drain(): DlqEntry[];
  size(): number;
}
```

---

## 6. IPC レイヤー --- プロセス間通信

Scheduler と AgentCore は **stdin/stdout JSON Lines** プロトコルで通信します。

**ソース:** `src/ipc/protocol.ts`, `src/ipc/json-lines-transport.ts`

### 6.1 トランスポート

`JsonLinesTransport` は ReadableStream / WritableStream 上で JSON Lines（1 行 1 JSON オブジェクト）の送受信を行います。最大行サイズは 10 MB です。

### 6.2 メッセージ型

**Scheduler → AgentCore（Inbound）:**

| メッセージ | 用途 |
|-----------|------|
| `submit_job` | ジョブの投入 |
| `cancel_job` | ジョブのキャンセル要求 |
| `request_permit` | 実行許可の要求 |
| `report_queue_metrics` | キューメトリクスの報告 |

**AgentCore → Scheduler（Outbound）:**

| メッセージ | 用途 |
|-----------|------|
| `ack` | ジョブ受理の確認 |
| `permit_granted` | Permit 発行 |
| `permit_rejected` | Permit 拒否（理由付き） |
| `job_completed` | ジョブ完了通知（succeeded / failed / cancelled） |
| `job_cancelled` | ジョブキャンセル通知 |
| `escalation` | エスカレーションイベント |
| `heartbeat` | ヘルスチェック応答 |
| `error` | エラー通知 |

### 6.3 将来の拡張

IPC プロトコルは JSON Lines を基本としていますが、gRPC / HTTP に差し替え可能な設計です。`IpcProtocol` クラスがプロトコルの詳細を抽象化しています。

---

## 7. データフロー --- ジョブ投入から結果回収まで

以下はジョブが投入されてから Worker の結果が返るまでの一連の流れです。

```
  Scheduler                   AgentCore (Core)              Worker
     │                              │                         │
     │  submit_job(job)             │                         │
     │ ─────────────────────────>   │                         │
     │                              │                         │
     │  ack(jobId)                  │                         │
     │ <─────────────────────────   │                         │
     │                              │                         │
     │  request_permit(job, 0)      │                         │
     │ ─────────────────────────>   │                         │
     │                              │                         │
     │  [Backpressure チェック]      │                         │
     │  [CircuitBreaker チェック]    │                         │
     │  [ExecutionBudget チェック]   │                         │
     │                              │                         │
     │  permit_granted(permit)      │                         │
     │ <─────────────────────────   │                         │
     │                              │                         │
     │         ┌────────────────────│                         │
     │         │ WorkerDelegation   │                         │
     │         │ Gateway            │                         │
     │         │                    │  startTask(workerTask)  │
     │         │                    │ ──────────────────────> │
     │         │                    │                         │
     │         │                    │  [Worker がタスク実行]   │
     │         │                    │                         │
     │         │                    │  WorkerResult           │
     │         │                    │ <────────────────────── │
     │         └────────────────────│                         │
     │                              │                         │
     │  job_completed(result)       │                         │
     │ <─────────────────────────   │                         │
     │                              │                         │
```

### 中断時のフロー

```
  Scheduler                   AgentCore (Core)              Worker
     │                              │                         │
     │  cancel_job(jobId)           │                         │
     │ ─────────────────────────>   │                         │
     │                              │                         │
     │         ┌────────────────────│                         │
     │         │ permit.abort()     │                         │
     │         │                    │  cancel(handle)         │
     │         │                    │ ──────────────────────> │
     │         │                    │                         │
     │         │                    │  [SIGTERM → 猶予 → SIGKILL]
     │         │                    │                         │
     │         │                    │  WorkerResult(CANCELLED)│
     │         │                    │ <────────────────────── │
     │         └────────────────────│                         │
     │                              │                         │
     │  job_cancelled(reason)       │                         │
     │ <─────────────────────────   │                         │
```

---

## 8. データモデル

### 8.1 Job --- 作業の単位

```typescript
interface Job {
  jobId: UUID;           // 一意識別子
  type: JobType;         // LLM | TOOL | WORKER_TASK | PLUGIN_EVENT | MAINTENANCE
  priority: Priority;    // { value: number, class: INTERACTIVE | BATCH }
  key?: string;          // Idempotency Key（重複制御用）
  payload: unknown;      // 入力データ
  limits: BudgetLimits;  // { timeoutMs, maxAttempts, costHint? }
  context: TraceContext;  // { traceId, correlationId, userId?, sessionId? }
}
```

### 8.2 Permit --- 実行許可証

```typescript
interface Permit {
  permitId: UUID;
  jobId: UUID;
  deadlineAt: Timestamp;
  attemptIndex: number;
  abortController: AbortController;
  tokensGranted: PermitTokens;  // { concurrency, rps, costBudget? }
  circuitStateSnapshot: Record<string, CircuitState>;
}
```

### 8.3 WorkerTask --- Worker への指示書

```typescript
interface WorkerTask {
  workerTaskId: UUID;
  workerKind: WorkerKind;              // CODEX_CLI | CLAUDE_CODE | OPENCODE | CUSTOM
  workspaceRef: string;                // 作業ディレクトリ
  instructions: string;                // 実行指示（自然言語）
  capabilities: WorkerCapability[];    // READ | EDIT | RUN_TESTS | RUN_COMMANDS
  outputMode: OutputMode;              // STREAM | BATCH
  budget: WorkerBudget;               // { deadlineAt, maxSteps?, maxCommandTimeMs? }
  abortSignal: AbortSignal;           // Permit 由来の中断シグナル
}
```

### 8.4 WorkerResult --- 実行結果

```typescript
interface WorkerResult {
  status: WorkerStatus;      // SUCCEEDED | FAILED | CANCELLED
  artifacts: Artifact[];     // パッチ、差分、生成物
  observations: Observation[]; // 実行コマンド、変更ファイル一覧
  cost: WorkerCost;          // { estimatedTokens?, wallTimeMs }
  errorClass?: ErrorClass;   // リトライ判断に使う分類
}
```

---

## 9. まとめ --- 設計上の安全保証

AgentCore の設計は以下の安全保証を提供します:

| 保証 | 実現手段 |
|------|---------|
| **重複実行の防止** | Idempotency Key + InFlightRegistry |
| **無限リトライの防止** | ExecutionBudget (maxAttempts, retryBudget) |
| **連鎖障害の遮断** | CircuitBreakerRegistry + グローバル安全弁 |
| **過負荷の抑制** | BackpressureController + ExecutionBudget (RPS) |
| **詰まりの検知** | Watchdog による定期監視 |
| **段階的な障害対応** | EscalationManager (ISOLATE / STOP / NOTIFY) |
| **実行の隔離** | Worker のプロセス分離 |
| **確実な中断** | AbortController の一貫した伝搬 |
| **Permit なしでは何も走らない** | PermitGate の不変条件 |

---

## 関連ドキュメント

- [クイックスタート](./quickstart.md) --- インストールと基本的な使い方
- [ワークフローガイド](./workflow.md) --- YAML ワークフローの書き方
- [Daemon ガイド](./daemon.md) --- イベント駆動の常駐実行
- [設計書](../design.md) --- 設計の詳細と根拠
