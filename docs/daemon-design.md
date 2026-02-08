# AgentCore Daemon 設計書

**イベント駆動型の常駐プロセスによるワークフロー自動実行**

---

## 1. 背景と目的

AgentCore は現在、ワークフロー YAML を指定して **1 回きりの実行** を行う構成になっている。
しかし現実のユースケースでは、エージェントは **常駐し、イベントに反応して自律的に動き続ける** 必要がある。

- 5 分ごとにリポジトリの状態をチェックし、問題があれば修正する
- ファイル変更を検知して自動テスト＋レビューを実行する
- Webhook で外部イベントを受け取り、対応するワークフローを起動する
- 前回のワークフロー結果を LLM が評価し、次のアクションを判断する

本設計では **Daemon（デーモン）** を定義する。Daemon は YAML 設定に基づいて常駐し、イベントソースを監視し、トリガー条件を満たしたときにワークフローを起動する。さらに、ワークフローの実行判断と結果分析を LLM Worker に委譲することで、**インテリジェントな自律実行** を実現する。

### 解決する課題

| 課題 | アプローチ |
|------|-----------|
| ワークフローの手動起動が必要 | イベントソース（cron / ファイル監視 / Webhook）で自動トリガー |
| 固定条件でしか起動できない | LLM による実行ゲート（evaluate）で動的判断 |
| 実行結果の人手レビューが必要 | LLM による結果分析（analyze）で自動評価・レポート |
| 単発実行で完結しない反復タスク | Daemon のイベントループで継続的に監視・実行 |
| 複数のイベントソースの統合管理 | 1 つの YAML で全イベントソース＋トリガーを宣言的に定義 |

---

## 2. アーキテクチャ概要

```
┌──────────────────────────────────────────────────────────────┐
│  Daemon Process                                              │
│                                                              │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │  Event Sources    │    │  Trigger Engine              │   │
│  │                   │    │                              │   │
│  │  ┌─────────────┐ │    │  Event                       │   │
│  │  │ CronSource  │─┼───▶│  ──▶ Filter                  │   │
│  │  ├─────────────┤ │    │  ──▶ Debounce                │   │
│  │  │ FSWatch     │─┼───▶│  ──▶ Evaluate (LLM Gate)     │   │
│  │  ├─────────────┤ │    │  ──▶ Run Workflow             │   │
│  │  │ Webhook     │─┼───▶│  ──▶ Analyze (LLM Result)    │   │
│  │  ├─────────────┤ │    │                              │   │
│  │  │ Custom      │─┼───▶│                              │   │
│  │  └─────────────┘ │    └──────────┬───────────────────┘   │
│  └──────────────────┘               │                        │
│                                     ▼                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Workflow Executor (既存)                             │   │
│  │  ┌─────────────┐  ┌──────────┐  ┌─────────────────┐ │   │
│  │  │ DAG Sched.  │  │ Context  │  │ Step Runners    │ │   │
│  │  └─────────────┘  └──────────┘  └─────────────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
│                                     │                        │
│                                     ▼                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  AgentCore (既存)                                     │   │
│  │  Permit Gate │ Circuit Breaker │ Watchdog │ Budget    │   │
│  └──────────────────────────────────────────────────────┘   │
│                                     │                        │
│                                     ▼                        │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Workers (Claude Code / Codex CLI / OpenCode)         │   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

### 設計原則

1. **Daemon = orchestration policy**: Daemon はいつ何を起動するかの判断レイヤー。既存の WorkflowExecutor と AgentCore の安全機構はそのまま利用する
2. **イベントソースはプラグイン**: CronSource / FSWatchSource / WebhookSource は共通インターフェースを実装し、新しいソースを追加可能
3. **LLM によるインテリジェントゲート**: ワークフロー実行の判断（evaluate）と結果評価（analyze）を Worker に委譲できる。固定条件だけでなく、文脈に応じた動的判断が可能
4. **1 YAML = 1 Daemon**: 設定ファイルが Daemon の全動作を宣言的に定義する

---

## 3. YAML スキーマ定義

### 3.1 トップレベル構造

```yaml
# daemon.yaml
name: string                    # Daemon 名（一意識別子）
version: "1"                    # スキーマバージョン
description?: string            # 説明

# Daemon 全体設定
workspace: string               # 作業ディレクトリ（全トリガー共通のデフォルト）
log_dir?: string                # ログ出力先（デフォルト: ./logs）
max_concurrent_workflows?: number  # 同時実行ワークフロー数上限（デフォルト: 1）

# Daemon の状態保存
state_dir?: string              # 実行履歴・状態の保存先（デフォルト: ./.daemon-state）

# イベントソース定義
events:
  <event_id>:                   # イベント ID（Daemon 内で一意）
    <EventSourceDef>

# トリガー定義（イベント → ワークフロー）
triggers:
  <trigger_id>:                 # トリガー ID（Daemon 内で一意）
    <TriggerDef>
```

### 3.2 EventSourceDef — イベントソース定義

#### Cron イベント

```yaml
events:
  every-5min:
    type: cron
    schedule: "*/5 * * * *"       # 標準 cron 式

  daily-morning:
    type: cron
    schedule: "0 9 * * *"         # 毎朝 9 時

  every-30s:
    type: interval
    every: "30s"                  # DurationString 形式（簡易指定）
```

#### ファイルシステム監視イベント

```yaml
events:
  src-change:
    type: fswatch
    paths:                        # 監視パス（glob 対応）
      - "src/**/*.ts"
      - "src/**/*.tsx"
    ignore:                       # 除外パス（任意）
      - "**/*.test.ts"
      - "**/node_modules/**"
    events:                       # 監視するイベント種別（任意、デフォルト: 全て）
      - create
      - modify
      - delete
```

#### Webhook イベント

```yaml
events:
  github-push:
    type: webhook
    path: "/hooks/github"         # エンドポイントパス
    port?: number                 # リッスンポート（Daemon 全体で 1 つの HTTP サーバーを共有）
    secret?: string               # HMAC 署名検証キー（環境変数参照可: ${GITHUB_WEBHOOK_SECRET}）
    method?: string               # HTTP メソッド（デフォルト: POST）
```

#### カスタムイベント（stdin / コマンド）

```yaml
events:
  manual-trigger:
    type: command
    command: "curl -s https://api.example.com/status"
    interval: "1m"                # コマンド実行間隔
    trigger_on: "change"          # change = 前回と出力が変わったとき / always = 毎回
```

### 3.3 TriggerDef — トリガー定義

```yaml
triggers:
  <trigger_id>:
    # ---- 基本設定 ----
    on: string                    # イベント ID（events セクションのキー）
    workflow: string              # ワークフロー YAML パス
    enabled?: boolean             # 有効/無効（デフォルト: true）

    # ---- フィルタリング ----
    filter?:                      # イベントペイロードに対するフィルタ（任意）
      <field>: <value>            # 単純一致
      <field>:
        pattern: string           # 正規表現マッチ
      <field>:
        in: [value1, value2]      # 値リスト一致

    # ---- レート制御 ----
    debounce?: DurationString     # 連続イベントの抑制（例: "10s"）
    cooldown?: DurationString     # 実行後のクールダウン期間（例: "5m"）
    max_queue?: number            # 未実行キューの上限（超過分は破棄、デフォルト: 10）

    # ---- 実行ゲート（LLM による判断） ----
    evaluate?:
      worker: WorkerKind          # CLAUDE_CODE | CODEX_CLI | OPENCODE | CUSTOM
      instructions: string        # LLM への指示（判断基準を記述）
      capabilities: Capability[]  # [READ, RUN_COMMANDS] など
      timeout?: DurationString    # ゲート判断のタイムアウト
      # Worker が exit 0 → 実行、exit 1 → スキップ
      # CUSTOM 以外: Worker 応答の "run" / "skip" で判定

    # ---- コンテキスト注入 ----
    context?:
      env?:                       # ワークフローに渡す環境変数
        <KEY>: <value>
      last_result?: boolean       # 前回実行結果をコンテキストに注入（デフォルト: false）
      event_payload?: boolean     # イベントペイロードをコンテキストに注入（デフォルト: false）

    # ---- 結果分析（LLM による評価） ----
    analyze?:
      worker: WorkerKind
      instructions: string        # 分析指示（結果を評価して何をするか）
      capabilities: Capability[]
      timeout?: DurationString
      outputs?:                   # 分析結果の保存先
        - name: string
          path: string
      # 分析 Worker はワークフローの context/ ディレクトリにアクセスできる

    # ---- 失敗ハンドリング ----
    on_workflow_failure?: "ignore" | "retry" | "pause_trigger"
                                  # ignore = 無視して次のイベントを待つ
                                  # retry = 再実行（max_retries 回まで）
                                  # pause_trigger = このトリガーを一時停止
    max_retries?: number          # retry 時の最大回数（デフォルト: 3）
```

### 3.4 完全な設定例

```yaml
# daemon.yaml — リポジトリ監視＋定期レビュー Daemon
name: repo-guardian
version: "1"
description: "リポジトリを監視し、変更時にテストを実行、定期的にコードレビューを行う"

workspace: "/home/user/my-project"
max_concurrent_workflows: 2
state_dir: "./.daemon-state"

events:
  code-change:
    type: fswatch
    paths:
      - "src/**/*.ts"
    ignore:
      - "**/*.test.ts"
      - "**/node_modules/**"

  every-5min:
    type: cron
    schedule: "*/5 * * * *"

  github-pr:
    type: webhook
    path: "/hooks/github"
    secret: "${GITHUB_WEBHOOK_SECRET}"

triggers:
  # --- ファイル変更時にテスト自動実行 ---
  auto-test:
    on: code-change
    workflow: ./workflows/test-suite.yaml
    debounce: "10s"
    on_workflow_failure: ignore

  # --- 5 分ごとのインテリジェントレビュー ---
  periodic-review:
    on: every-5min
    workflow: ./workflows/code-review.yaml

    # LLM がレビューすべきか判断
    evaluate:
      worker: CLAUDE_CODE
      instructions: |
        リポジトリの最新コミットを確認してください。
        前回のレビュー以降に新しいコミットがあれば "run" と出力してください。
        なければ "skip" と出力してください。

        前回レビュー結果: {{last_result}}
      capabilities: [READ, RUN_COMMANDS]
      timeout: "30s"

    context:
      last_result: true

    # ワークフロー完了後に LLM が結果を分析
    analyze:
      worker: CLAUDE_CODE
      instructions: |
        ワークフローの実行結果を分析してください。
        - コードレビューの指摘事項をまとめてください
        - 重大な問題があれば、次回のレビューで重点的に確認すべき点を記録してください
        - 結果を summary.md に出力してください
      capabilities: [READ, EDIT]
      timeout: "2m"
      outputs:
        - name: review-summary
          path: summary.md

  # --- PR Webhook で CI 実行 ---
  pr-check:
    on: github-pr
    workflow: ./workflows/ci-pipeline.yaml
    filter:
      action: "opened"
      pull_request.base.ref: "main"
    cooldown: "1m"
    on_workflow_failure: retry
    max_retries: 2
```

---

## 4. コンポーネント設計

### 4.1 EventSource インターフェース

```typescript
/** イベントソースの共通インターフェース */
interface EventSource {
  /** ソース ID（YAML の event_id） */
  readonly id: string;

  /** イベントの非同期イテレータ。Daemon の寿命と同じ。 */
  events(): AsyncIterable<DaemonEvent>;

  /** 停止 */
  stop(): Promise<void>;
}

/** Daemon が受け取るイベント */
interface DaemonEvent {
  sourceId: string;           // イベントソース ID
  timestamp: number;          // epoch ms
  payload: EventPayload;      // ソース固有のペイロード
}

type EventPayload =
  | CronPayload
  | FSWatchPayload
  | WebhookPayload
  | CommandPayload;

interface CronPayload {
  type: "cron";
  schedule: string;           // 発火したスケジュール式
  firedAt: number;
}

interface FSWatchPayload {
  type: "fswatch";
  changes: Array<{
    path: string;
    event: "create" | "modify" | "delete";
  }>;
}

interface WebhookPayload {
  type: "webhook";
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface CommandPayload {
  type: "command";
  stdout: string;
  exitCode: number;
  changed: boolean;           // 前回出力との差分有無
}
```

### 4.2 TriggerEngine

```typescript
/** トリガーの実行管理 */
class TriggerEngine {
  constructor(
    private readonly config: DaemonConfig,
    private readonly workflowRunner: WorkflowRunner,
    private readonly stateStore: DaemonStateStore,
  ) {}

  /**
   * イベントを受け取り、マッチするトリガーを評価・実行する。
   * 1 イベントが複数トリガーにマッチすることがある。
   */
  async handleEvent(event: DaemonEvent): Promise<void> {
    const matchingTriggers = this.findMatchingTriggers(event);

    for (const trigger of matchingTriggers) {
      if (!trigger.enabled) continue;
      if (this.isDebounced(trigger, event)) continue;
      if (this.isInCooldown(trigger)) continue;
      if (this.isQueueFull(trigger)) continue;

      this.enqueueTriggerExecution(trigger, event);
    }
  }

  /**
   * トリガー実行パイプライン
   * Filter → Debounce → Evaluate → Execute → Analyze
   */
  private async executeTrigger(
    trigger: TriggerDef,
    event: DaemonEvent,
  ): Promise<TriggerResult> {
    // 1. フィルタ
    if (!this.matchesFilter(trigger, event)) {
      return { action: "filtered" };
    }

    // 2. LLM ゲート（evaluate）
    if (trigger.evaluate) {
      const shouldRun = await this.runEvaluateGate(trigger, event);
      if (!shouldRun) {
        return { action: "skipped_by_evaluate" };
      }
    }

    // 3. コンテキスト準備
    const context = await this.prepareContext(trigger, event);

    // 4. ワークフロー実行
    const workflowResult = await this.workflowRunner.run(
      trigger.workflow,
      context,
    );

    // 5. 結果保存
    await this.stateStore.recordExecution(trigger.id, event, workflowResult);

    // 6. LLM 分析（analyze）
    if (trigger.analyze && workflowResult.status === "SUCCEEDED") {
      await this.runAnalysis(trigger, workflowResult);
    }

    // 7. 失敗ハンドリング
    if (workflowResult.status === "FAILED") {
      await this.handleWorkflowFailure(trigger, workflowResult);
    }

    return { action: "executed", result: workflowResult };
  }
}
```

### 4.3 DaemonStateStore — 状態永続化

```typescript
/**
 * Daemon の実行状態を永続化する。
 * state_dir 配下にファイルベースで保存。
 */
interface DaemonStateStore {
  /** 最後の実行結果を取得 */
  getLastResult(triggerId: string): Promise<WorkflowState | null>;

  /** 実行履歴を記録 */
  recordExecution(
    triggerId: string,
    event: DaemonEvent,
    result: WorkflowState,
  ): Promise<void>;

  /** トリガーの debounce/cooldown タイムスタンプを管理 */
  getLastFired(triggerId: string): Promise<number | null>;
  setLastFired(triggerId: string, timestamp: number): Promise<void>;

  /** トリガーの有効/無効を動的に切り替え */
  setTriggerEnabled(triggerId: string, enabled: boolean): Promise<void>;
  isTriggerEnabled(triggerId: string): Promise<boolean>;

  /** 実行履歴の取得（直近 N 件） */
  getHistory(triggerId: string, limit: number): Promise<ExecutionRecord[]>;
}

interface ExecutionRecord {
  triggerId: string;
  event: DaemonEvent;
  result: WorkflowState;
  startedAt: number;
  completedAt: number;
  evaluateResult?: "run" | "skip";
  analyzeResult?: unknown;
}
```

### 4.4 Evaluate Gate — LLM による実行判断

```typescript
/**
 * evaluate フィールドが定義されている場合、
 * ワークフロー実行前に LLM Worker に実行可否を問い合わせる。
 *
 * Worker 種別による判定方法:
 * - CUSTOM: exit 0 → run, exit 1 → skip
 * - CLAUDE_CODE / CODEX_CLI / OPENCODE:
 *   Worker 出力に "run" を含めば実行、"skip" を含めばスキップ
 */
class EvaluateGate {
  async shouldRun(
    evaluate: EvaluateDef,
    event: DaemonEvent,
    lastResult: WorkflowState | null,
    workspaceDir: string,
  ): Promise<boolean> {
    // 1. instructions 内のテンプレート変数を展開
    const instructions = this.expandTemplate(evaluate.instructions, {
      event: JSON.stringify(event.payload),
      last_result: lastResult ? JSON.stringify(lastResult) : "null",
      timestamp: new Date().toISOString(),
    });

    // 2. Worker 実行
    const result = await this.runWorker({
      worker: evaluate.worker,
      instructions,
      capabilities: evaluate.capabilities,
      timeout: evaluate.timeout ?? "30s",
      workspaceDir,
    });

    // 3. 判定
    if (evaluate.worker === "CUSTOM") {
      return result.exitCode === 0;
    }
    return this.parseDecision(result.output);
  }

  private parseDecision(output: string): boolean {
    const lower = output.toLowerCase().trim();
    // 最後の有効行を見る（LLM は説明の後に結論を書く傾向がある）
    const lines = lower.split("\n").filter((l) => l.trim().length > 0);
    const lastLine = lines[lines.length - 1] ?? "";
    if (lastLine.includes("run")) return true;
    if (lastLine.includes("skip")) return false;
    // フォールバック: 出力全体を見る
    if (lower.includes("run")) return true;
    return false; // デフォルトはスキップ（安全側）
  }
}
```

### 4.5 ResultAnalyzer — LLM による結果分析

```typescript
/**
 * analyze フィールドが定義されている場合、
 * ワークフロー完了後に LLM Worker に結果分析を依頼する。
 * Worker はワークフローの context/ ディレクトリにアクセスでき、
 * 分析結果をファイルとして出力する。
 */
class ResultAnalyzer {
  async analyze(
    analyzeDef: AnalyzeDef,
    workflowResult: WorkflowState,
    contextDir: string,
    workspaceDir: string,
  ): Promise<AnalyzeResult> {
    const instructions = this.expandTemplate(analyzeDef.instructions, {
      workflow_status: workflowResult.status,
      steps: JSON.stringify(workflowResult.steps),
      context_dir: contextDir,
    });

    const result = await this.runWorker({
      worker: analyzeDef.worker,
      instructions,
      capabilities: analyzeDef.capabilities,
      timeout: analyzeDef.timeout ?? "2m",
      workspaceDir,
    });

    return {
      output: result.output,
      artifacts: analyzeDef.outputs ?? [],
    };
  }
}
```

---

## 5. イベントソース実装

### 5.1 CronSource

```typescript
/**
 * cron 式に基づいて定期的にイベントを発火する。
 * 内部で cron-parser を使って次の発火時刻を計算し、setTimeout でスケジュール。
 */
class CronSource implements EventSource {
  readonly id: string;
  private timer: Timer | null = null;
  private abortController = new AbortController();

  constructor(
    id: string,
    private readonly schedule: string,
  ) {
    this.id = id;
  }

  async *events(): AsyncIterable<DaemonEvent> {
    while (!this.abortController.signal.aborted) {
      const nextFire = this.computeNext(this.schedule);
      const delay = nextFire - Date.now();

      if (delay > 0) {
        await this.sleep(delay);
      }

      if (this.abortController.signal.aborted) break;

      yield {
        sourceId: this.id,
        timestamp: Date.now(),
        payload: {
          type: "cron",
          schedule: this.schedule,
          firedAt: Date.now(),
        },
      };
    }
  }

  async stop(): Promise<void> {
    this.abortController.abort();
  }
}
```

#### IntervalSource（簡易版）

`type: interval` は DurationString を受け取り、固定間隔で発火する CronSource の簡易版。内部的には `setInterval` 相当。

### 5.2 FSWatchSource

```typescript
/**
 * ファイルシステムの変更を監視する。
 * Bun の fs.watch() または chokidar 相当の機能を使用。
 * glob パターンでフィルタリング、ignore パターンで除外。
 *
 * バッチング: 短時間に大量の変更が発生した場合、
 * 200ms のウィンドウで変更をバッチにまとめて 1 イベントとして発火。
 */
class FSWatchSource implements EventSource {
  private watcher: FSWatcher | null = null;
  private batchWindow = 200; // ms

  async *events(): AsyncIterable<DaemonEvent> {
    // Bun.file watcher or node:fs.watch with recursive option
    // バッチング: 200ms ウィンドウで変更をまとめる
    // glob マッチ + ignore フィルタを適用
  }
}
```

### 5.3 WebhookSource

```typescript
/**
 * HTTP サーバーを起動し、指定パスで Webhook を受け付ける。
 * Daemon 内の全 WebhookSource で 1 つの HTTP サーバーを共有する。
 *
 * HMAC 署名検証: secret が設定されている場合、
 * X-Hub-Signature-256 ヘッダーでリクエスト署名を検証する。
 */
class WebhookServer {
  private routes = new Map<string, WebhookHandler>();

  /** Bun.serve で HTTP サーバーを起動 */
  start(port: number): void {
    Bun.serve({
      port,
      fetch: (req) => this.handleRequest(req),
    });
  }
}

class WebhookSource implements EventSource {
  constructor(
    private readonly server: WebhookServer,
    private readonly config: WebhookConfig,
  ) {
    server.registerRoute(config.path, this);
  }
}
```

### 5.4 CommandSource

```typescript
/**
 * 定期的に外部コマンドを実行し、結果をイベントとして発火する。
 * trigger_on: "change" の場合、前回の stdout と差分があった場合のみ発火。
 * trigger_on: "always" の場合、毎回発火。
 */
class CommandSource implements EventSource {
  private lastOutput: string | null = null;

  async *events(): AsyncIterable<DaemonEvent> {
    while (!this.aborted) {
      const result = await this.runCommand(this.config.command);
      const changed = this.lastOutput !== null && result.stdout !== this.lastOutput;
      this.lastOutput = result.stdout;

      if (this.config.triggerOn === "always" || changed) {
        yield {
          sourceId: this.id,
          timestamp: Date.now(),
          payload: {
            type: "command",
            stdout: result.stdout,
            exitCode: result.exitCode,
            changed,
          },
        };
      }

      await this.sleep(this.intervalMs);
    }
  }
}
```

---

## 6. Daemon ライフサイクル

### 6.1 起動フロー

```
1. YAML 読み込み・バリデーション
2. state_dir 初期化（前回状態の復元）
3. EventSource インスタンス生成
4. WebhookServer 起動（Webhook ソースがある場合）
5. TriggerEngine 初期化
6. イベントループ開始
7. シグナルハンドラ登録（SIGTERM / SIGINT → graceful shutdown）
```

### 6.2 イベントループ

```typescript
class Daemon {
  async run(): Promise<void> {
    // 全 EventSource のイベントを 1 つのストリームに合流
    const merged = mergeAsyncIterables(
      ...this.sources.map((s) => s.events()),
    );

    for await (const event of merged) {
      if (this.shutdownRequested) break;
      await this.triggerEngine.handleEvent(event);
    }
  }
}
```

### 6.3 Graceful Shutdown

```
1. SIGTERM / SIGINT 受信
2. shutdownRequested = true に設定
3. 全 EventSource.stop() を呼び出し（新規イベント停止）
4. 実行中のワークフローに AbortSignal を送信
5. 実行中ワークフローの完了を待機（タイムアウト付き）
6. DaemonStateStore をフラッシュ
7. WebhookServer 停止
8. プロセス終了
```

### 6.4 ワークフロー同時実行管理

```typescript
/**
 * max_concurrent_workflows で同時実行数を制限。
 * 上限到達時、新しいトリガーはキューに入り、
 * 実行中のワークフローが完了次第デキューされる。
 * max_queue を超えた場合は最古のキュー項目を破棄。
 */
class WorkflowScheduler {
  private running = 0;
  private queue: QueuedTrigger[] = [];

  async submit(trigger: TriggerDef, event: DaemonEvent): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      this.execute(trigger, event).finally(() => {
        this.running--;
        this.dequeueNext();
      });
    } else {
      this.enqueue(trigger, event);
    }
  }
}
```

---

## 7. テンプレート変数

evaluate / analyze の `instructions` 内で使用可能なテンプレート変数:

| 変数 | 説明 | 使用可能箇所 |
|------|------|-------------|
| `{{event}}` | イベントペイロード（JSON） | evaluate, analyze |
| `{{event.type}}` | イベント種別 | evaluate, analyze |
| `{{last_result}}` | 前回実行結果（JSON）、`context.last_result: true` 時のみ | evaluate |
| `{{last_result.status}}` | 前回のステータス | evaluate |
| `{{timestamp}}` | 現在時刻（ISO 8601） | evaluate, analyze |
| `{{trigger_id}}` | トリガー ID | evaluate, analyze |
| `{{workflow_status}}` | ワークフロー実行結果ステータス | analyze |
| `{{steps}}` | 各ステップの実行結果（JSON） | analyze |
| `{{context_dir}}` | コンテキストディレクトリパス | analyze |
| `{{execution_count}}` | このトリガーの累計実行回数 | evaluate, analyze |

---

## 8. CLI インターフェース

```bash
# Daemon の起動
agentcore daemon start <daemon.yaml> [--verbose]

# Daemon のステータス確認（別ターミナルから）
agentcore daemon status [--state-dir <dir>]

# 手動トリガー（デバッグ用）
agentcore daemon trigger <trigger_id> [--state-dir <dir>]

# トリガーの一時停止/再開
agentcore daemon pause <trigger_id>
agentcore daemon resume <trigger_id>

# 実行履歴の確認
agentcore daemon history [--trigger <trigger_id>] [--limit 10]

# Daemon の停止
agentcore daemon stop [--state-dir <dir>]
```

---

## 9. 状態ディレクトリ構造

```
.daemon-state/
├── daemon.json                 # Daemon メタ情報（PID, 起動時刻, 状態）
├── triggers/
│   ├── auto-test/
│   │   ├── state.json          # enabled, lastFired, cooldownUntil
│   │   └── history/
│   │       ├── 2024-01-15T09-30-00.json
│   │       └── 2024-01-15T09-35-00.json
│   └── periodic-review/
│       ├── state.json
│       ├── last-result.json    # 前回のワークフロー実行結果
│       ├── last-analyze.json   # 前回の LLM 分析結果
│       └── history/
│           └── ...
└── webhook-server.json         # Webhook サーバー情報（ポート等）
```

---

## 10. 既存コンポーネントとの統合

### 10.1 WorkflowExecutor との関係

Daemon の TriggerEngine は既存の `WorkflowExecutor` をそのまま使用する。違いは **誰がいつ WorkflowExecutor を起動するか** だけ:

- **現在**: CLI → `run.ts` → `WorkflowExecutor.execute()`
- **Daemon**: `TriggerEngine` → `WorkflowRunner` → `WorkflowExecutor.execute()`

### 10.2 AgentCore / Scheduler との関係

Daemon は将来的に AgentCore の Permit Gate / Circuit Breaker / Watchdog を活用できる。ただし初期実装では WorkflowExecutor を直接使用し、AgentCore との統合は段階的に行う:

**Phase 1（初期）**: Daemon → WorkflowExecutor → ShellStepRunner（現在の構成をそのまま利用）

**Phase 2（統合）**: Daemon → WorkflowExecutor → AgentCore → Workers（安全機構をフル活用）

### 10.3 Worker の利用

evaluate / analyze で使用する Worker は、WorkflowExecutor のステップと同じ Worker 基盤を使用する:
- `CUSTOM`: シェルスクリプト実行（ShellStepRunner）
- `CLAUDE_CODE` / `CODEX_CLI` / `OPENCODE`: AI Worker（Worker Delegation Gateway 経由）

---

## 11. 設計上の考慮事項

### 11.1 冪等性

Daemon はクラッシュ後の再起動でも安全に動作する必要がある:
- `state_dir` に実行状態を永続化し、起動時に復元
- cron の「前回発火時刻」を記録し、起動直後に過去分を一気に発火しない
- ワークフロー実行中にクラッシュした場合、再起動時に「実行中」状態を検出し、ユーザーに通知（自動リトライはしない）

### 11.2 メモリ管理

- 実行履歴は state_dir にファイルとして永続化し、メモリに保持しない
- FSWatch のバッチングウィンドウ（200ms）で大量の変更イベントを集約
- WebhookSource は body サイズ上限（デフォルト 1MB）を設ける

### 11.3 セキュリティ

- Webhook の secret は環境変数参照（`${ENV_VAR}`）で指定し、YAML に直接書かない
- HMAC-SHA256 署名検証を必須にする（secret 指定時）
- ワークフローの workspace は Daemon の workspace 配下に限定

### 11.4 可観測性

```typescript
interface DaemonMetrics {
  eventsReceived: Record<string, number>;    // イベントソース別受信数
  triggersEvaluated: Record<string, number>; // トリガー別評価数
  triggersExecuted: Record<string, number>;  // トリガー別実行数
  triggersSkipped: Record<string, number>;   // evaluate でスキップされた数
  workflowsSucceeded: number;
  workflowsFailed: number;
  activeWorkflows: number;
  uptime: number;
}
```

ログ出力:
- `[daemon:event]` — イベント受信ログ
- `[daemon:trigger]` — トリガー評価・実行ログ
- `[daemon:evaluate]` — LLM ゲート判断ログ
- `[daemon:analyze]` — LLM 結果分析ログ
- `[daemon:workflow]` — ワークフロー開始・完了ログ

---

## 12. 実装計画

### Phase 1: コア基盤
- [ ] YAML パーサー + バリデーション（DaemonConfig 型）
- [ ] EventSource インターフェース + CronSource + IntervalSource
- [ ] TriggerEngine（フィルタ + debounce + cooldown）
- [ ] DaemonStateStore（ファイルベース永続化）
- [ ] Daemon クラス（イベントループ + graceful shutdown）
- [ ] CLI: `agentcore daemon start`

### Phase 2: イベントソース拡充
- [ ] FSWatchSource（glob / ignore / バッチング）
- [ ] WebhookSource + WebhookServer（HMAC 検証）
- [ ] CommandSource（差分検知）

### Phase 3: インテリジェントレイヤー
- [ ] EvaluateGate（CUSTOM + LLM Worker 対応）
- [ ] ResultAnalyzer（context/ アクセス + 出力保存）
- [ ] テンプレート変数展開
- [ ] context 注入（last_result, event_payload）

### Phase 4: 運用機能
- [ ] CLI: status / trigger / pause / resume / history / stop
- [ ] 可観測性（メトリクス + 構造化ログ）
- [ ] ワークフロー同時実行管理（max_concurrent_workflows）

### Phase 5: AgentCore 統合
- [ ] WorkflowExecutor → AgentCore → Worker パス
- [ ] Circuit Breaker / Permit Gate の Daemon レベル適用
