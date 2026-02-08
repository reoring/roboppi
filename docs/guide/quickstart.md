# AgentCore クイックスタート

AgentCore は AI エージェント向けの実行制御ランタイムです。Permit（実行許可）による安全な実行制御、Circuit Breaker による障害遮断、Worker への作業委譲を提供します。

## 前提条件

ビルド時のみ:
- [Bun](https://bun.sh/) v1.0 以上

ビルド済みバイナリを使う場合、Bun は不要です。

Worker として使う場合（任意）:
- [OpenCode](https://opencode.ai/) — `bun install -g opencode`
- [Claude Code](https://claude.ai/code) — `npm install -g @anthropic-ai/claude-code`
- [Codex CLI](https://github.com/openai/codex) — `npm install -g @openai/codex`

## インストール

```bash
git clone <repository-url> agentcore
cd agentcore
bun install
```

## ビルド

```bash
make            # シングルバイナリをビルド → ./agentcore
```

動作確認:

```bash
./agentcore --version   # agentcore 0.1.0
./agentcore --help      # オプション一覧
```

その他の make ターゲット:

```bash
make test       # 全テスト（693）
make typecheck  # 型チェック
make clean      # バイナリ削除
make install    # /usr/local/bin にインストール
```

---

## 使い方 1: `agentcore run` でワンショット実行

`run` サブコマンドで、CLI 引数だけで Worker にタスクを委譲できます。

```bash
# OpenCode でファイル生成
./agentcore run --worker opencode --workspace /tmp/demo "hello.ts を作って"

# Claude Code でテスト修正
./agentcore run --worker claude-code --workspace ./my-project \
  --capabilities EDIT,RUN_TESTS "テストを修正して"

# Codex CLI でリファクタ
./agentcore run --worker codex --workspace ./src "この関数をリファクタして"

# タイムアウトやバジェットも指定可能
./agentcore run --worker opencode --workspace /tmp/demo \
  --timeout 60000 --concurrency 5 "README を書いて"
```

`run` モードのオプション:

| オプション | 説明 | デフォルト |
|-----------|------|----------|
| `--worker <kind>` | Worker 種別: `opencode`, `claude-code`, `codex` | (必須) |
| `--workspace <path>` | 作業ディレクトリ | (必須) |
| `--capabilities <csv>` | `READ,EDIT,RUN_TESTS,RUN_COMMANDS` | `EDIT` |
| `--timeout <ms>` | タスクのタイムアウト | `120000` |

内部では PermitGate → CircuitBreaker → ExecutionBudget の安全チェックを経てから Worker にタスクを委譲します。

---

## 使い方 2: IPC サーバーモード

サブコマンドなしで起動すると、IPC サーバーモードになります。Scheduler や独自ドライバから JSON Lines で通信できます。

```bash
# デフォルト設定で起動
./agentcore

# カスタム設定で起動
./agentcore --concurrency 20 --rps 100 --log-level debug
```

共有オプション（`run` モードでも使えます）:

| オプション | 説明 | デフォルト |
|-----------|------|----------|
| `--concurrency <n>` | 最大同時 Permit 数 | 10 |
| `--rps <n>` | 1秒あたりの最大リクエスト数 | 50 |
| `--max-cost <n>` | 累積コスト上限 | 無制限 |
| `--log-level <level>` | ログレベル (debug/info/warn/error/fatal) | info |
| `--cb-threshold <n>` | Circuit Breaker 失敗閾値 | 5 |
| `--cb-reset-ms <n>` | Circuit Breaker リセットタイムアウト (ms) | 30000 |
| `--cb-half-open <n>` | Circuit Breaker half-open 試行回数 | 3 |
| `--bp-reject <n>` | Backpressure 拒否閾値 | 100 |
| `--bp-defer <n>` | Backpressure 延期閾値 | 75 |
| `--bp-degrade <n>` | Backpressure 縮退閾値 | 50 |

### JSON Lines でジョブを投入する例

```bash
echo '{"type":"submit_job","requestId":"req-1","job":{"jobId":"job-001","type":"LLM","priority":{"value":1,"class":"INTERACTIVE"},"payload":{"prompt":"hello"},"limits":{"timeoutMs":5000,"maxAttempts":3},"context":{"traceId":"t-1","correlationId":"c-1"}}}' | ./agentcore 2>/dev/null
```

出力（stdout に JSON Lines で返る）:

```json
{"type":"ack","requestId":"req-1","jobId":"job-001"}
```

---

## 使い方 3: プログラムから使う

### 基本: Core コンポーネントを直接使う

```typescript
import { PermitGate } from "./src/core/permit-gate.js";
import { ExecutionBudget } from "./src/core/execution-budget.js";
import { CircuitBreakerRegistry } from "./src/core/circuit-breaker.js";
import { BackpressureController } from "./src/core/backpressure.js";
import { WorkerDelegationGateway } from "./src/worker/worker-gateway.js";
import { MockWorkerAdapter } from "./src/worker/adapters/mock-adapter.js";
import { WorkerKind, WorkerCapability } from "./src/types/index.js";
import type { WorkerTask, Permit, PermitRejection } from "./src/types/index.js";
import { generateId } from "./src/types/common.js";

// 1. Core コンポーネントを初期化
const budget = new ExecutionBudget({ maxConcurrency: 10, maxRps: 50 });
const cbRegistry = new CircuitBreakerRegistry();
const backpressure = new BackpressureController({
  rejectThreshold: 100,
  deferThreshold: 80,
  degradeThreshold: 50,
});
const permitGate = new PermitGate(budget, cbRegistry, backpressure);
const gateway = new WorkerDelegationGateway();

// 2. Worker アダプタを登録（ここでは Mock）
gateway.registerAdapter(
  WorkerKind.CLAUDE_CODE,
  new MockWorkerAdapter(WorkerKind.CLAUDE_CODE, { delayMs: 100 }),
);

// 3. ジョブを定義
const job = {
  jobId: generateId(),
  type: "WORKER_TASK" as any,
  priority: { value: 1, class: "INTERACTIVE" as any },
  payload: {},
  limits: { timeoutMs: 30000, maxAttempts: 3 },
  context: { traceId: generateId(), correlationId: generateId() },
};

// 4. Permit を要求（安全チェック: Budget, CB, Backpressure）
const result = permitGate.requestPermit(job, 0);
if (!("permitId" in result)) {
  console.error("Permit rejected:", result.reason);
  process.exit(1);
}
const permit = result;
console.log("Permit granted:", permit.permitId);

// 5. Worker にタスクを委譲
const task: WorkerTask = {
  workerTaskId: generateId(),
  workerKind: WorkerKind.CLAUDE_CODE,
  workspaceRef: "/tmp/my-workspace",
  instructions: "テストを実行してください",
  capabilities: [WorkerCapability.RUN_TESTS],
  outputMode: "BATCH" as any,
  budget: { deadlineAt: Date.now() + 30000 },
  abortSignal: permit.abortController.signal,
};

const workerResult = await gateway.delegateTask(task, permit);
console.log("Result:", workerResult.status);

// 6. Permit を完了
permitGate.completePermit(permit.permitId);

// クリーンアップ
permitGate.dispose();
cbRegistry.dispose();
```

このコードを `my-script.ts` として保存し:

```bash
bun run my-script.ts
```

---

## 使い方 4: OpenCode で実タスクを実行する（プログラム版）

OpenCode がインストールされていれば、実際にコードを書かせることができます。

```typescript
// opencode-example.ts
import { generateId, now } from "./src/types/common.js";
import { WorkerKind, WorkerCapability, WorkerStatus } from "./src/types/index.js";
import type { WorkerTask, WorkerResult } from "./src/types/index.js";
import { ProcessManager } from "./src/worker/process-manager.js";
import type { ManagedProcess } from "./src/worker/process-manager.js";
import type { WorkerAdapter, WorkerHandle, WorkerEvent } from "./src/worker/worker-adapter.js";
import { WorkerDelegationGateway } from "./src/worker/worker-gateway.js";
import { PermitGate } from "./src/core/permit-gate.js";
import { ExecutionBudget } from "./src/core/execution-budget.js";
import { CircuitBreakerRegistry } from "./src/core/circuit-breaker.js";
import { BackpressureController } from "./src/core/backpressure.js";

// OpenCode 用の軽量アダプタ
class OpenCodeWorker implements WorkerAdapter {
  readonly kind = WorkerKind.OPENCODE;
  private pm: ProcessManager;
  private procs = new Map<string, ManagedProcess>();
  private starts = new Map<string, number>();

  constructor(pm: ProcessManager) { this.pm = pm; }

  async startTask(task: WorkerTask): Promise<WorkerHandle> {
    const managed = this.pm.spawn({
      command: ["opencode", "run", "--format", "json", task.instructions],
      cwd: task.workspaceRef,
      abortSignal: task.abortSignal,
      timeoutMs: 120000,
    });
    const handle: WorkerHandle = {
      handleId: generateId(),
      workerKind: WorkerKind.OPENCODE,
      abortSignal: task.abortSignal,
    };
    this.procs.set(handle.handleId, managed);
    this.starts.set(handle.handleId, now());
    return handle;
  }

  async *streamEvents(): AsyncIterable<WorkerEvent> {}

  async cancel(handle: WorkerHandle) {
    const p = this.procs.get(handle.handleId);
    if (p) await this.pm.gracefulShutdown(p.pid, 5000);
    this.procs.delete(handle.handleId);
  }

  async awaitResult(handle: WorkerHandle): Promise<WorkerResult> {
    const managed = this.procs.get(handle.handleId)!;
    const exitCode = await managed.exitPromise;
    const wallTimeMs = now() - (this.starts.get(handle.handleId) ?? now());
    this.procs.delete(handle.handleId);
    this.starts.delete(handle.handleId);
    return {
      status: handle.abortSignal.aborted
        ? WorkerStatus.CANCELLED
        : exitCode === 0 ? WorkerStatus.SUCCEEDED : WorkerStatus.FAILED,
      artifacts: [],
      observations: [],
      cost: { wallTimeMs },
    };
  }
}

// --- ここから実行 ---

const pm = new ProcessManager();
const budget = new ExecutionBudget({ maxConcurrency: 5, maxRps: 10 });
const cbRegistry = new CircuitBreakerRegistry();
const bp = new BackpressureController({ rejectThreshold: 100, deferThreshold: 80, degradeThreshold: 50 });
const gate = new PermitGate(budget, cbRegistry, bp);
const gw = new WorkerDelegationGateway();

gw.registerAdapter(WorkerKind.OPENCODE, new OpenCodeWorker(pm));

// Permit 取得
const job = {
  jobId: generateId(),
  type: "WORKER_TASK" as any,
  priority: { value: 1, class: "INTERACTIVE" as any },
  payload: {},
  limits: { timeoutMs: 120000, maxAttempts: 1 },
  context: { traceId: generateId(), correlationId: generateId() },
};
const permit = gate.requestPermit(job, 0) as any;
console.log("Permit granted:", permit.permitId);

// タスク実行
const task: WorkerTask = {
  workerTaskId: generateId(),
  workerKind: WorkerKind.OPENCODE,
  workspaceRef: "/tmp/my-project",       // ← 作業ディレクトリ
  instructions: "FizzBuzz を TypeScript で実装して、1 から 30 まで出力するプログラムを作って",
  capabilities: [WorkerCapability.EDIT],
  outputMode: "BATCH" as any,
  budget: { deadlineAt: Date.now() + 120000 },
  abortSignal: permit.abortController.signal,
};

console.log("OpenCode にタスクを委譲中...");
const result = await gw.delegateTask(task, permit);
console.log("結果:", result.status, `(${(result.cost.wallTimeMs / 1000).toFixed(1)}秒)`);

gate.completePermit(permit.permitId);
gate.dispose();
cbRegistry.dispose();
process.exit(0);
```

実行:

```bash
mkdir -p /tmp/my-project
bun run opencode-example.ts
```

OpenCode がファイルを生成し、結果が `SUCCEEDED` で返ります。

---

## 使い方 5: Scheduler 付きで起動する（フル構成）

Scheduler は AgentCore を子プロセスとして起動・監督します。ジョブキュー、重複制御、リトライ、DLQ を含むフル構成です。

```typescript
import { Scheduler } from "./src/scheduler/index.js";
import { JobType, PriorityClass } from "./src/types/index.js";
import { generateId } from "./src/types/common.js";

const scheduler = new Scheduler({
  supervisor: { coreEntryPoint: "src/index.ts" },
  retry: { baseDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 3 },
});

// AgentCore を子プロセスとして起動
await scheduler.start();

// ジョブ投入
const result = scheduler.submitJob({
  jobId: generateId(),
  type: JobType.LLM,
  priority: { value: 1, class: PriorityClass.INTERACTIVE },
  key: "my-unique-key",  // 重複制御用 Idempotency Key
  payload: { prompt: "Hello!" },
  limits: { timeoutMs: 10000, maxAttempts: 3 },
  context: { traceId: generateId(), correlationId: generateId() },
});

console.log("Accepted:", result.accepted);

// しばらく処理を待つ
await new Promise((r) => setTimeout(r, 5000));

// シャットダウン
await scheduler.shutdown();
```

---

## 使い方 6: ワークフロー YAML で実行

複数のステップを YAML で定義し、順序通りに実行できます。

```yaml
# my-workflow.yaml
name: refactor-and-test
steps:
  - name: refactor
    worker: opencode
    workspace: ./src
    instructions: "この関数をリファクタして"
    capabilities: [EDIT]

  - name: test
    worker: opencode
    workspace: ./src
    instructions: "テストを実行して結果を報告して"
    capabilities: [RUN_TESTS]
```

実行:

```bash
./agentcore workflow run my-workflow.yaml
```

ステップごとに Permit 取得 → Worker 委譲 → 結果回収が行われ、途中で失敗した場合は中断されます。

詳細は [ワークフローガイド](./workflow.md) を参照してください。

---

## 使い方 7: Daemon で常駐実行

Daemon モードでは、イベント（cron、ファイル変更、webhook など）をトリガーにワークフローを自動実行できます。

```yaml
# daemon.yaml
workflows:
  auto-test:
    trigger:
      type: fs_watch
      paths: ["./src/**/*.ts"]
    steps:
      - name: run-tests
        worker: opencode
        workspace: ./
        instructions: "変更されたファイルに関連するテストを実行して"
        capabilities: [RUN_TESTS]

state_dir: ./.agentcore-state
```

起動:

```bash
./agentcore daemon daemon.yaml
# または
bun run src/daemon/cli.ts daemon.yaml --verbose
```

ファイル変更を検知すると自動的にワークフローが実行されます。cron スケジュール、webhook、手動コマンドもトリガーとして使えます。

詳細は [Daemon ガイド](./daemon.md) を参照してください。

---

## アーキテクチャ概要

```
┌─────────────────────────────────────────────┐
│  Scheduler（親プロセス）                      │
│  JobQueue / InFlightRegistry / RetryPolicy   │
│  ┌───────────────────────────────────────┐   │
│  │  AgentCore（子プロセス）               │   │
│  │  PermitGate / CircuitBreaker          │   │
│  │  Watchdog / EscalationManager         │   │
│  │  ┌─────────────────────────────────┐  │   │
│  │  │  Worker Delegation Gateway      │  │   │
│  │  │  OpenCode / Claude Code / Codex │  │   │
│  │  └─────────────────────────────────┘  │   │
│  └───────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

### 核心の考え方

- **Permit がなければ何も実行されない** — 安全性の不変条件
- **Core = mechanism（仕組み）** — 止める、制限する、観測する、隔離する
- **Scheduler = policy（判断）** — 順序、重複制御、リトライ。差し替え可能
- **Worker = 実作業** — プロセス分離で詰まりの伝搬を遮断

---

## テストを実行する

```bash
make test                   # 全テスト（693）
make test-unit              # 単体テストのみ
make test-integration       # 結合テストのみ
make typecheck              # 型チェック
```

---

## 次のステップ

- [アーキテクチャガイド](./architecture.md) --- 内部構造の詳細
- [ワークフローガイド](./workflow.md) --- YAML ワークフローの書き方
- [Daemon ガイド](./daemon.md) --- イベント駆動の常駐実行
- [設計書](../design.md) --- 設計の詳細と根拠
- Worker アダプタのカスタマイズ: `src/worker/adapters/` を参照
- 独自の Scheduler を実装: `src/scheduler/` を参考に
