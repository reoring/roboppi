# Workflow YAML 設計書

**複数 AgentCore ステップの DAG ワークフロー定義**

---

## 1. 背景と目的

AgentCore は現在、1 つの Scheduler が 1 つの AgentCore を管理する構成で動作する。
しかし現実のタスクは「実装 → レビュー → 修正 → テスト」のように複数ステップの連携を必要とする。

本設計では **YAML でワークフローを宣言的に定義** し、ステップ間の依存関係（DAG）とコンテキスト受け渡し（ファイルベース）を可能にする。

### 解決する課題

| 課題 | アプローチ |
|------|-----------|
| 複数ステップの手動オーケストレーション | YAML でワークフローを宣言、Scheduler が自動実行 |
| ステップ間のコンテキスト断絶 | `context/` ディレクトリでファイルベースの受け渡し |
| 逐次実行しかできない | `depends_on` による DAG 表現で並列実行・合流 |
| ステップ失敗時の手動復旧 | `on_failure` ポリシーで自動リトライ・スキップ・中断 |

---

## 2. YAML スキーマ定義

### 2.1 トップレベル構造

```yaml
# workflow.yaml
name: string                    # ワークフロー名（一意識別子）
version: "1"                    # スキーマバージョン
description?: string            # 説明（任意）

timeout: string                 # ワークフロー全体のタイムアウト（例: "30m", "2h"）
concurrency?: number            # ステップの最大同時実行数（デフォルト: 制限なし）

context_dir?: string            # コンテキストディレクトリ（デフォルト: "./context"）

steps:
  <step_id>:                    # ステップ ID（YAML キー、ワークフロー内で一意）
    <StepDefinition>
```

### 2.2 StepDefinition

```yaml
steps:
  <step_id>:
    description?: string                    # ステップの説明

    # ---- Worker 設定 ----
    worker: enum                            # CODEX_CLI | CLAUDE_CODE | OPENCODE | CUSTOM
    workspace?: string                      # 作業ディレクトリ（デフォルト: "."）
    instructions: string                    # Worker に渡す指示テキスト
    capabilities:                           # Worker に許可する操作
      - enum                                # READ | EDIT | RUN_TESTS | RUN_COMMANDS

    # ---- DAG 依存 ----
    depends_on?: string[]                   # 先行ステップ ID のリスト

    # ---- コンテキスト入出力 ----
    inputs?: InputRef[]                     # 先行ステップの成果物参照
    outputs?: OutputDef[]                   # このステップの出力定義

    # ---- 制約 ----
    timeout?: string                        # ステップのタイムアウト（例: "5m"）
    max_retries?: number                    # 最大リトライ回数（デフォルト: 0）
    max_steps?: number                      # Worker の最大ステップ数
    max_command_time?: string               # Worker のコマンド実行タイムアウト

    # ---- 完了チェック（ループ） ----
    completion_check?: CompletionCheckDef   # Worker 成功後の完了判定（未完了なら再実行）
    max_iterations?: number                 # completion_check ループの上限（デフォルト: 1 = ループなし）
    on_iterations_exhausted?: enum          # 上限到達時: abort | continue（デフォルト: abort）

    # ---- 失敗ハンドリング ----
    on_failure?: enum                       # retry | continue | abort（デフォルト: abort）
```

### 2.3 InputRef — コンテキスト入力参照

```yaml
inputs:
  - from: string                # 参照元ステップ ID
    artifact: string            # アーティファクト名（出力で定義した名前）
    as?: string                 # ローカルでの参照名（省略時は artifact と同じ）
```

### 2.4 OutputDef — コンテキスト出力定義

```yaml
outputs:
  - name: string                # アーティファクト名（後段ステップから参照するキー）
    path: string                # context_dir 内の相対パス
    type?: string               # ファイルタイプのヒント（例: "code", "review", "test-report"）
```

### 2.5 CompletionCheckDef — 完了チェック定義

```yaml
completion_check:
  worker: enum                  # チェックに使用する Worker（CLAUDE_CODE 等）
  instructions: string          # チェック内容の指示
  capabilities:                 # チェッカー Worker の権限（通常は READ のみ）
    - enum
  timeout?: string              # チェック 1 回あたりのタイムアウト（デフォルト: ステップ timeout の 1/4）
```

チェッカー Worker は成果物の状態を評価し、**完了 / 未完了** を返す。
未完了の場合、メイン Worker が再実行される（`max_iterations` まで）。

チェッカーとメイン Worker は同一 `workspace` 上で動作するため、ファイルの状態は自然に引き継がれる。

### 2.6 完全な型定義（TypeScript 表現）

```typescript
interface WorkflowDefinition {
  name: string;
  version: "1";
  description?: string;
  timeout: DurationString;        // "30m", "2h" など
  concurrency?: number;
  context_dir?: string;
  steps: Record<string, StepDefinition>;
}

interface StepDefinition {
  description?: string;
  worker: "CODEX_CLI" | "CLAUDE_CODE" | "OPENCODE" | "CUSTOM";
  workspace?: string;
  instructions: string;
  capabilities: ("READ" | "EDIT" | "RUN_TESTS" | "RUN_COMMANDS")[];
  depends_on?: string[];
  inputs?: InputRef[];
  outputs?: OutputDef[];
  timeout?: DurationString;
  max_retries?: number;
  max_steps?: number;
  max_command_time?: DurationString;
  completion_check?: CompletionCheckDef;
  max_iterations?: number;              // デフォルト: 1（ループなし）
  on_iterations_exhausted?: "abort" | "continue";
  on_failure?: "retry" | "continue" | "abort";
}

interface CompletionCheckDef {
  worker: "CODEX_CLI" | "CLAUDE_CODE" | "OPENCODE" | "CUSTOM";
  instructions: string;
  capabilities: ("READ" | "EDIT" | "RUN_TESTS" | "RUN_COMMANDS")[];
  timeout?: DurationString;
}

interface InputRef {
  from: string;
  artifact: string;
  as?: string;
}

interface OutputDef {
  name: string;
  path: string;
  type?: string;
}

type DurationString = string;   // "5m", "30s", "2h" など
```

---

## 3. 具体例

### 3.1 実装 → レビュー → 修正 ワークフロー

```yaml
name: implement-review-fix
version: "1"
description: "機能実装後にレビューし、指摘を修正する"
timeout: "1h"
concurrency: 2

steps:
  implement:
    description: "機能の初期実装を行う"
    worker: CODEX_CLI
    instructions: |
      src/feature.ts に新しいユーティリティ関数を追加してください。
      仕様は instructions.md を参照。
    capabilities: [READ, EDIT]
    timeout: "15m"
    max_retries: 1
    on_failure: retry
    outputs:
      - name: implementation
        path: "src/feature.ts"
        type: code

  test:
    description: "実装のテストを実行する"
    worker: CODEX_CLI
    depends_on: [implement]
    instructions: |
      テストスイートを実行し、結果を報告してください。
    capabilities: [READ, RUN_TESTS]
    inputs:
      - from: implement
        artifact: implementation
    timeout: "10m"
    on_failure: continue
    outputs:
      - name: test-report
        path: "test-results.txt"
        type: test-report

  review:
    description: "実装コードをレビューする"
    worker: CLAUDE_CODE
    depends_on: [implement]
    instructions: |
      src/feature.ts のコードレビューを行ってください。
      コード品質、エラーハンドリング、テストの観点で指摘をまとめてください。
    capabilities: [READ]
    inputs:
      - from: implement
        artifact: implementation
    timeout: "10m"
    on_failure: abort
    outputs:
      - name: review-comments
        path: "review.md"
        type: review

  fix:
    description: "レビュー指摘とテスト結果に基づき修正する"
    worker: CODEX_CLI
    depends_on: [review, test]
    instructions: |
      review.md の指摘事項を反映してください。
      テストが失敗していた場合はそれも修正してください。
    capabilities: [READ, EDIT, RUN_TESTS]
    inputs:
      - from: review
        artifact: review-comments
      - from: test
        artifact: test-report
    timeout: "15m"
    max_retries: 2
    on_failure: retry
    outputs:
      - name: fixed-code
        path: "src/feature.ts"
        type: code
```

このワークフローの DAG 構造:

```
implement
  ├── test ──┐
  └── review ┴── fix
```

`test` と `review` は `implement` 完了後に **並列実行** される。
`fix` は `test` と `review` の **両方が完了**してから実行される。

### 3.2 並列マルチリポジトリ適用

```yaml
name: multi-repo-migration
version: "1"
description: "複数リポジトリに同じリファクタリングを適用"
timeout: "2h"
concurrency: 3

steps:
  plan:
    description: "移行計画を作成"
    worker: CLAUDE_CODE
    instructions: "リファクタリング計画を migration-plan.md に出力"
    capabilities: [READ]
    timeout: "10m"
    outputs:
      - name: plan
        path: "migration-plan.md"
        type: review

  apply-repo-a:
    description: "リポジトリ A に適用"
    worker: CODEX_CLI
    workspace: "../repo-a"
    depends_on: [plan]
    instructions: "migration-plan.md の計画に従ってリファクタリングを実行"
    capabilities: [READ, EDIT, RUN_TESTS]
    inputs:
      - from: plan
        artifact: plan
    timeout: "20m"
    max_retries: 1
    on_failure: retry

  apply-repo-b:
    description: "リポジトリ B に適用"
    worker: CODEX_CLI
    workspace: "../repo-b"
    depends_on: [plan]
    instructions: "migration-plan.md の計画に従ってリファクタリングを実行"
    capabilities: [READ, EDIT, RUN_TESTS]
    inputs:
      - from: plan
        artifact: plan
    timeout: "20m"
    max_retries: 1
    on_failure: continue

  verify:
    description: "全リポジトリの整合性を確認"
    worker: CLAUDE_CODE
    depends_on: [apply-repo-a, apply-repo-b]
    instructions: "各リポジトリの変更差分を確認し、整合性レポートを作成"
    capabilities: [READ]
    timeout: "10m"
```

### 3.3 completion_check によるループ実行

```yaml
name: implement-from-todo
version: "1"
description: "todo.md のタスクをすべて完了するまで繰り返し実装する"
timeout: "2h"

steps:
  implement-all:
    description: "todo.md の未完了タスクをすべて実装する"
    worker: CODEX_CLI
    instructions: |
      todo.md を読み、- [ ] でマークされた未完了タスクを1つ選んで実装してください。
      実装が完了したら、該当行を - [x] に更新してください。
    capabilities: [READ, EDIT, RUN_TESTS]
    timeout: "10m"
    max_retries: 1
    on_failure: retry

    completion_check:
      worker: CLAUDE_CODE
      instructions: |
        todo.md を確認してください。
        - [ ] が1つでも残っていれば「未完了」と判定してください。
        すべて - [x] であれば「完了」と判定してください。
      capabilities: [READ]
      timeout: "2m"

    max_iterations: 20
    on_iterations_exhausted: abort

    outputs:
      - name: completed-code
        path: "src/"
        type: code
      - name: final-todo
        path: "todo.md"
        type: review

  verify:
    description: "全タスク完了後にテストを実行"
    worker: CODEX_CLI
    depends_on: [implement-all]
    instructions: "全テストスイートを実行し、結果を報告してください"
    capabilities: [READ, RUN_TESTS]
    inputs:
      - from: implement-all
        artifact: completed-code
    timeout: "10m"
    on_failure: abort
```

実行フロー:

```
implement-all ステップ
  │
  │  iteration 1
  ├─→ Worker 実行 (CODEX_CLI): todo の1項目を実装
  │     ↓ SUCCEEDED
  ├─→ completion_check (CLAUDE_CODE): "- [ ] が3個残っています → 未完了"
  │     ↓ 未完了 → 再実行
  │
  │  iteration 2
  ├─→ Worker 実行 (CODEX_CLI): 次の1項目を実装
  │     ↓ SUCCEEDED
  ├─→ completion_check (CLAUDE_CODE): "- [ ] が2個残っています → 未完了"
  │     ↓ 未完了 → 再実行
  │
  │  ... (繰り返し)
  │
  │  iteration N
  ├─→ Worker 実行 (CODEX_CLI): 最後の1項目を実装
  │     ↓ SUCCEEDED
  ├─→ completion_check (CLAUDE_CODE): "すべて - [x] です → 完了"
  │     ↓ 完了
  │
  └─→ ステップ SUCCEEDED → verify へ
```

---

## 4. コンテキスト受け渡しフロー

### 4.1 ディレクトリ構造

ワークフロー実行時、Scheduler は以下のディレクトリ構造を作成する:

```
<workspace>/
├── context/                          # context_dir（デフォルト）
│   ├── _workflow.json                # ワークフロー実行メタデータ
│   ├── implement/                    # ステップ ID ごとのサブディレクトリ
│   │   ├── _meta.json               # ステップ実行メタ（status, timing, etc.）
│   │   └── implementation/           # outputs で定義した成果物
│   │       └── src/feature.ts
│   ├── review/
│   │   ├── _meta.json
│   │   └── review-comments/
│   │       └── review.md
│   └── test/
│       ├── _meta.json
│       └── test-report/
│           └── test-results.txt
```

### 4.2 コンテキストのライフサイクル

```
 ┌──────────────────────────────────────────────────────────┐
 │  ステップ A 実行                                          │
 │                                                          │
 │  1. Scheduler が context/<step_id>/ を作成                │
 │  2. inputs で指定された先行成果物を                        │
 │     Worker の作業ディレクトリにコピー/シンボリックリンク      │
 │  3. Worker が実行                                         │
 │  4. Worker 完了後、outputs で指定されたパスのファイルを       │
 │     context/<step_id>/<artifact_name>/ に収集              │
 │  5. _meta.json にステップ結果を記録                        │
 │                                                          │
 │  → 後続ステップの inputs が解決可能に                       │
 └──────────────────────────────────────────────────────────┘
```

### 4.3 `_meta.json` の構造

```json
{
  "stepId": "implement",
  "status": "SUCCEEDED",
  "startedAt": 1700000000000,
  "completedAt": 1700000900000,
  "wallTimeMs": 900000,
  "attempts": 1,
  "workerKind": "CODEX_CLI",
  "artifacts": [
    {
      "name": "implementation",
      "path": "implementation/src/feature.ts",
      "type": "code"
    }
  ],
  "workerResult": {
    "status": "SUCCEEDED",
    "artifacts": [],
    "observations": [
      { "filesChanged": ["src/feature.ts"], "summary": "Added utility function" }
    ],
    "cost": { "estimatedTokens": 5000, "wallTimeMs": 120000 }
  }
}
```

### 4.4 既存型との対応

コンテキスト受け渡しは既存の `WorkerResult.artifacts` を拡張する形で実現する:

| YAML 定義 | 実行時の内部表現 |
|-----------|----------------|
| `outputs[].name` | `Artifact.type`（アーティファクト名として使用） |
| `outputs[].path` | `Artifact.ref`（ファイルパス参照） |
| `outputs[].type` | `Artifact.content`（メタデータとして格納、またはフィールド追加） |
| `inputs[].from` + `inputs[].artifact` | Scheduler がステップ開始前に `context/<from>/<artifact>/` から解決 |

---

## 5. 既存コードとの対応マッピング

### 5.1 型の対応

| YAML 概念 | 既存の型/コード | 備考 |
|-----------|---------------|------|
| `step.worker` | `WorkerKind` enum | `CODEX_CLI`, `CLAUDE_CODE`, `OPENCODE`, `CUSTOM` |
| `step.capabilities` | `WorkerCapability` enum | `READ`, `EDIT`, `RUN_TESTS`, `RUN_COMMANDS` |
| `step.timeout` | `WorkerBudget.deadlineAt`, `BudgetLimits.timeoutMs` | DurationString → ms に変換して設定 |
| `step.max_retries` | `RetryPolicyConfig.maxAttempts` | ステップレベルで RetryPolicy を個別生成 |
| `step.max_steps` | `WorkerBudget.maxSteps` | そのまま対応 |
| `step.max_command_time` | `WorkerBudget.maxCommandTimeMs` | DurationString → ms に変換 |
| `step.on_failure` | `ErrorClass` → リトライ/DLQ 判定 | Scheduler の `handleJobCompleted` ロジックを拡張 |
| `workflow.concurrency` | `ExecutionBudgetConfig.maxConcurrency` | ワークフロー全体の同時実行制御 |
| context artifacts | `WorkerResult.artifacts` (`Artifact` 型) | `type` + `ref` + `content` |
| `completion_check` | **新規** | ステップ内ループ。Worker 成功後に別 Worker で完了判定 |
| `max_iterations` | `RetryPolicyConfig.maxAttempts` と同パターン | ループの安全弁。`maxAttempts` はエラーリトライ、`max_iterations` は完了ループ |
| `depends_on` | **新規** | Scheduler の `processNext()` を DAG 対応に拡張 |

### 5.2 Scheduler 拡張の概要

現在の Scheduler は単一キューからジョブを取り出して逐次的に処理する（`processNext()`）。
ワークフロー対応では以下の拡張が必要:

1. **WorkflowExecutor**: YAML をパースし、DAG を構築。各ステップを `Job` に変換
2. **DAG スケジューラ**: `depends_on` の解決状態を追跡。依存が全て完了したステップをキューに投入
3. **コンテキストマネージャ**: `context/` ディレクトリの作成、成果物の収集・配布
4. **ワークフロー状態管理**: ステップごとの `on_failure` ポリシーに基づく制御フロー判定

```
既存: Scheduler.processNext()
  └── JobQueue.dequeue() → 1つの Job を処理

拡張: Scheduler.processNext()
  └── WorkflowExecutor.getReadySteps()     # 依存解決済みステップを取得
      └── DAG の depends_on をチェック
      └── 並列実行可能なステップを複数キューイング
  └── JobQueue.dequeue() → Job を処理        # 既存ロジックは変更なし
```

---

## 6. エラーハンドリング仕様

### 6.1 ステップレベルの失敗ポリシー

`on_failure` フィールドで各ステップの失敗時動作を制御する:

| ポリシー | 動作 |
|---------|------|
| `retry` | `max_retries` 回までリトライ。既存の `RetryPolicy`（指数バックオフ + ジッター）を使用。上限超過後は `on_failure_exhausted` に遷移 |
| `continue` | ステップを失敗としてマークし、後続ステップの実行を継続。後続ステップの inputs に該当成果物がない場合、空として扱う |
| `abort` | ワークフロー全体を中断。未実行ステップはすべてスキップ。実行中ステップはキャンセル |

### 6.2 リトライ上限超過後の動作

`on_failure: retry` で `max_retries` を超過した場合:

1. 既存の DLQ にジョブ情報を記録
2. `ErrorClass` に基づいてエスカレーション判定:
   - `RETRYABLE_TRANSIENT` / `RETRYABLE_RATE_LIMIT` → ステップを `FAILED` にし、`abort` と同じ動作
   - `NON_RETRYABLE` / `FATAL` → 即座に `abort`（リトライせず）
3. ワークフロー全体の結果に失敗理由を記録

### 6.3 ErrorClass との統合

既存の `ErrorClass` 分類はステップ実行時にそのまま適用される:

```
Worker 実行
  ↓ WorkerResult.errorClass
ErrorClass 判定
  ├── FATAL              → 即座に abort（on_failure 設定を無視）
  ├── NON_RETRYABLE      → on_failure に従う（retry 不可、continue or abort）
  ├── RETRYABLE_TRANSIENT → on_failure: retry なら RetryPolicy でリトライ
  └── RETRYABLE_RATE_LIMIT → on_failure: retry ならバックオフ付きリトライ
```

> **注**: `ErrorClass.FATAL` はステップの `on_failure` 設定に**関わらず**ワークフローを中断する。
> これは Core の安全性不変条件（mechanism）として既存設計と一貫する。

### 6.4 completion_check ループの仕様

#### retry との違い

| | `on_failure: retry` | `completion_check` ループ |
|---|---|---|
| トリガー | Worker が**失敗**（`WorkerStatus.FAILED`） | Worker は**成功**したがタスクが**未完了** |
| 上限 | `max_retries` | `max_iterations` |
| 判定者 | `ErrorClass` による自動分類 | チェッカー Worker による評価 |
| バックオフ | 指数バックオフ + ジッター | なし（即座に再実行） |
| 上限超過 | DLQ + abort | `on_iterations_exhausted` に従う |

#### 実行の詳細フロー

```
ステップ開始 (iteration = 1)
  │
  ├─→ メイン Worker 実行
  │     ├── FAILED → on_failure ポリシーで処理（retry / continue / abort）
  │     │              ※ retry 成功後は completion_check に進む
  │     └── SUCCEEDED ↓
  │
  ├─→ completion_check が未定義 → ステップ SUCCEEDED（ループなし）
  │
  ├─→ completion_check Worker 実行
  │     ├── チェッカー自体が FAILED → ステップを FAILED（on_failure で処理）
  │     ├── 完了判定 → ステップ SUCCEEDED
  │     └── 未完了判定 ↓
  │
  ├─→ iteration < max_iterations ?
  │     ├── Yes → iteration++、メイン Worker を再実行
  │     └── No  → on_iterations_exhausted で処理
  │              ├── abort    → ステップ FAILED、ワークフロー中断
  │              └── continue → ステップを INCOMPLETE としてマーク、後続へ
  │
  └─→ ステップ timeout に達した → 実行中の Worker をキャンセル、ステップ FAILED
```

#### チェッカー Worker の応答プロトコル

チェッカー Worker は `WorkerResult` を返す。完了判定は以下で行う:

- `WorkerStatus.SUCCEEDED` → **完了**（ループ終了）
- `WorkerStatus.FAILED` かつ `ErrorClass.RETRYABLE_TRANSIENT` → **未完了**（ループ継続）
- `WorkerStatus.FAILED` かつ `ErrorClass.NON_RETRYABLE` / `FATAL` → **チェック自体の失敗**（ステップ FAILED）

> **設計意図**: 既存の `WorkerResult` / `ErrorClass` をそのまま利用し、新しいプロトコルを追加しない。
> チェッカーは「未完了 = 一時的な失敗」として報告する。これは「まだ条件を満たしていない」の自然な表現である。

#### コンテキストの引き継ぎ

ループ内のイテレーション間では:

- **同一 workspace** 上で動作するため、ファイル変更は自動的に引き継がれる
- `context/<step_id>/_meta.json` には最終イテレーションの結果のみ記録
- `_meta.json` に `iterations` フィールドを追加し、実行回数を記録

```json
{
  "stepId": "implement-all",
  "status": "SUCCEEDED",
  "iterations": 5,
  "maxIterations": 20,
  ...
}
```

### 6.5 ワークフロータイムアウト

ワークフロー全体の `timeout` に達した場合:

1. 実行中の全ステップにキャンセルを送信（既存の `CancellationManager` 経由）
2. 未実行ステップをスキップ
3. ワークフロー状態を `TIMED_OUT` に設定

### 6.6 ワークフロー実行状態

```typescript
enum WorkflowStatus {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  SUCCEEDED = "SUCCEEDED",     // 全ステップが SUCCEEDED または SKIPPED（continue による）
  FAILED = "FAILED",           // いずれかのステップが FAILED で abort
  TIMED_OUT = "TIMED_OUT",     // ワークフロー全体のタイムアウト
  CANCELLED = "CANCELLED",     // 外部からのキャンセル
}

enum StepStatus {
  PENDING = "PENDING",         // 依存未解決で待機中
  READY = "READY",             // 依存解決済み、実行待ち
  RUNNING = "RUNNING",         // メイン Worker 実行中
  CHECKING = "CHECKING",       // completion_check Worker 実行中
  SUCCEEDED = "SUCCEEDED",     // 正常完了（completion_check 合格含む）
  FAILED = "FAILED",           // 失敗（リトライ上限超過含む）
  INCOMPLETE = "INCOMPLETE",   // max_iterations 超過 + on_iterations_exhausted: continue
  SKIPPED = "SKIPPED",         // 先行ステップの失敗で未実行
  CANCELLED = "CANCELLED",     // キャンセルされた
}
```

---

## 7. DAG 実行アルゴリズム

### 7.1 ステップ状態遷移

```
PENDING → READY → RUNNING → SUCCEEDED
                     │  ↑
                     │  └── (completion_check 未完了) ── CHECKING → RUNNING  ※ループ
                     │
                     ├── CHECKING → SUCCEEDED  ※完了判定
                     │
                     ├── FAILED → (retry) → RUNNING
                     │     ↓
                     │   (abort) → 後続ステップを SKIPPED に
                     │
                     └── INCOMPLETE  ※max_iterations 超過 + continue

PENDING → SKIPPED  （先行ステップの失敗 + abort 時）
RUNNING → CANCELLED（タイムアウトまたは外部キャンセル時）
```

### 7.2 スケジューリングループ

```
毎 tick（100ms 間隔、既存の processLoop と同期）:

1. 全ステップの depends_on を走査
   - depends_on の全ステップが SUCCEEDED → ステップを READY に遷移
   - depends_on のいずれかが FAILED:
     - 失敗ステップの on_failure が continue → READY に遷移（成果物は空）
     - 失敗ステップの on_failure が abort → このステップを SKIPPED に
   - depends_on が未完了のものがある → PENDING のまま

2. READY ステップを concurrency 制限内で RUNNING に遷移
   - Job を生成し既存の JobQueue に投入
   - ExecutionBudget の maxConcurrency で並列数を制御

3. RUNNING ステップの完了イベントを処理
   - SUCCEEDED:
     - completion_check なし → outputs を context/ に収集、ステップ SUCCEEDED
     - completion_check あり → ステップを CHECKING に遷移、チェッカー Worker を起動
   - FAILED: on_failure ポリシーに基づき retry / continue / abort

4. CHECKING ステップの完了イベントを処理
   - 完了判定 → outputs を context/ に収集、ステップ SUCCEEDED
   - 未完了判定:
     - iteration < max_iterations → iteration++、ステップを RUNNING に戻しメイン Worker を再起動
     - iteration >= max_iterations → on_iterations_exhausted に従い abort / continue
   - チェッカー自体の失敗 → ステップ FAILED

5. 全ステップが終端状態（SUCCEEDED / FAILED / INCOMPLETE / SKIPPED / CANCELLED）→ ワークフロー完了
```

### 7.3 DAG バリデーション（ワークフロー読み込み時）

YAML パース後、実行前に以下を検証:

- **循環検出**: `depends_on` にサイクルがないこと（トポロジカルソート可能）
- **参照整合性**: `depends_on` のステップ ID が `steps` に存在すること
- **入力整合性**: `inputs[].from` が `depends_on` に含まれていること
- **出力名の一意性**: 同一ステップ内で `outputs[].name` が重複しないこと
- **Worker 種別の有効性**: `worker` が `WorkerKind` enum の値であること
- **Capability の有効性**: `capabilities` が `WorkerCapability` enum の値であること
- **completion_check の整合性**: `completion_check` がある場合、`max_iterations` が 2 以上であること（1 以下はループの意味がない）
- **completion_check の Worker 有効性**: `completion_check.worker` が `WorkerKind` enum の値であること

---

## 8. 実装ロードマップ

本設計は段階的に実装可能。以下は推奨する実装順序:

### Phase 1: YAML パーサーと DAG バリデーション

- YAML パーサー（`WorkflowDefinition` 型への変換）
- DAG バリデーション（循環検出、参照整合性）
- DurationString のパーサー

### Phase 2: ワークフロー実行エンジン

- `WorkflowExecutor` クラス（ステップ状態管理、DAG スケジューリング）
- 既存 Scheduler の `processLoop` への統合
- ステップ → Job 変換ロジック
- `completion_check` ループ実行（RUNNING → CHECKING → RUNNING サイクル）

### Phase 3: コンテキスト管理

- `context/` ディレクトリの作成・管理
- 成果物の収集（Worker 完了後）
- 成果物の配布（Worker 開始前に inputs を解決）

### Phase 4: エラーハンドリングとオブザーバビリティ

- ステップレベルの `on_failure` ポリシー実行
- ワークフロータイムアウト
- ワークフロー実行ログ・メトリクス

---

## 9. 制約と将来の拡張

### 現在のスコープ外

- **条件分岐** (`if` / `when`): ステップの実行をランタイム条件で制御する機能。将来的にステップに `when` フィールドを追加して対応可能
- **動的展開ループ** (`for_each`): 入力リストに基づいてステップを動的に N 個生成する機能（`completion_check` による条件ループは対応済み）
- **サブワークフロー**: ワークフローの入れ子・再利用
- **外部イベントトリガー**: Webhook や cron によるワークフロー起動
- **ステップ間の変数**: ファイル以外の軽量なデータ受け渡し

### 設計上の判断

- **ファイルベースのコンテキスト受け渡しを選択した理由**: Worker はプロセス分離されており、共有メモリは使えない。ファイルシステムは Worker 種別に依存しない汎用的なインターフェースであり、デバッグ時に中間成果物を直接確認できる利点がある
- **YAML を選択した理由**: 複数行テキスト（instructions）の記述が JSON より自然。人間が読み書きしやすく、Git での差分管理に適している
- **ワークフロー全体の concurrency を設ける理由**: Worker プロセスはリソースを消費するため、無制限の並列実行はシステムを圧迫する。`ExecutionBudgetConfig.maxConcurrency` と連携して制御する
