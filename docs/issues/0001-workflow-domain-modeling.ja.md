# Workflow のドメインモデル化不足（YAMLスキーマ直結 / 正規化・検証の分散）

ステータス: 提案

## 問題

Workflow YAML を `parseWorkflow()` で読み取った後の構造が、そのまま実行時のドメインモデルとして使われています。
その結果、「構成（config）」「実行計画（compiled/resolved）」「実行結果（runtime state）」の境界が薄く、変換・検証が分散しやすい状態です。

具体的な症状:

- supervised / non-supervised の両経路で **同種の正規化処理が重複**している
  - 例: `timeout` の duration parse、`workspace` の `path.resolve()`、budget の組み立て
  - `src/workflow/multi-worker-step-runner.ts` と `src/workflow/core-ipc-step-runner.ts` に類似ロジックが存在
- **検証が複数箇所に散在**しており、仕様追加のたびに差分が出やすい
  - `src/workflow/parser.ts`（スキーマ/フィールド検証）
  - `src/workflow/dag-validator.ts`（DAG整合/一部安全チェック）
  - `src/workflow/executor.ts`（実行中の安全/収束/infra failure ガード）
- Core IPC 経由の `WORKER_TASK` が **payload の型契約に弱い**
  - Core 側で `job.payload as { ... }` のようなキャストに依存（`src/core/agentcore.ts`）
  - Runner/Core 間の「期待フィールド」が型で共有されていないため、破壊的変更が混入しやすい

## 現行構造（要約）

- YAML -> `WorkflowDefinition` / `StepDefinition`（`src/workflow/types.ts`）
- runner: 読み込み/パース/validateDag -> `WorkflowExecutor` に投入（`src/workflow/run.ts`）
- executor: DAG状態管理 + loop（completion_check） + 収束ガード等（`src/workflow/executor.ts`）
- step 実行: `StepRunner` ポートに委譲
  - direct spawn: `MultiWorkerStepRunner`（`src/workflow/multi-worker-step-runner.ts`）
  - supervised: `CoreIpcStepRunner`（`src/workflow/core-ipc-step-runner.ts`）

この分割自体は健全ですが、「YAML型」と「実行用の解決済みモデル」が分離されていない点が、重複・分散の根になっています。

## 根本原因

1) `StepDefinition` が「ユーザー入力（YAML）」と「実行計画（resolved）」の両方を兼ねている

2) 正規化（duration/path/capabilities/budget/env）を StepRunner 側で都度行っている

3) IPC payload の型を Core/Runner で共有しておらず、境界が暗黙契約になっている

## 目標

- 構成（YAML）と実行計画（resolved/compiled）を分離し、**正規化・検証を単一パスに集約**する
- supervised / non-supervised で **同一の解決結果（timeout/workspace/budget等）**になることを担保する
- Core IPC の `WORKER_TASK` payload を型で固定し、破壊的変更をビルド時に検出できるようにする
- 既存 YAML と互換を維持する（破壊的変更はしない）

## 提案

### 1) Resolved/Compiled Workflow モデルを導入

`WorkflowDefinition`（YAMLスキーマ）から、実行用の「解決済みモデル」を作る。

例（概念）:

- `ResolvedWorkflow`:
  - `workflowTimeoutMs: number`
  - `steps: Record<string, ResolvedStep>`
- `ResolvedStep`:
  - `stepId: string`
  - `workerKind: WorkerKind`（`"OPENCODE"`等ではなく実行enum）
  - `workspaceRef: string`（絶対パス）
  - `timeoutMs: number`
  - `budget: { deadlineAt: number; maxSteps?; maxCommandTimeMs? }`
  - `capabilities: WorkerCapability[]`（文字列配列ではなく実行enum）
  - `model?: string`
  - `completionCheck?: ResolvedCheck`

この compiled モデルを `WorkflowExecutor` と StepRunner が消費し、StepRunner から duration/path 解決ロジックを排除する。

### 2) 検証パイプラインを整理

検証を「スキーマ検証」と「セマンティック検証」と「実行安全検証」に分け、責務の場所を固定する。

- スキーマ検証: `parser.ts`
- セマンティック検証: DAG、depends_on/inputs整合、completion_check + max_iterations 等
- 実行安全検証: 実行中の drift / convergence / infra failure など（executor）

少なくとも、**DAG・max_iterations などの静的制約は compiled 生成前に一度だけ**走るようにする。

### 3) Core IPC の WORKER_TASK payload 型を共有

`CoreIpcStepRunner` が送る `job.payload` と、Core が受ける payload を、同一の型/validator で共有する。

例:

- `src/types/worker-task-payload.ts` を追加
- `CoreIpcStepRunner` は `WorkerTaskJobPayload` を組み立てる
- `AgentCore.executeWorkerTask` は payload を type guard で検証し、`as { ... }` を避ける

### 4) 観測性: resolved 値を成果物に残す

`context/_workflow.json` や `context/<step>/_meta.json` に、解決済みの timeout/budget/workspaceRef/model/agent などを（必要最小限で）残す。
実行後に「実際に何が設定されていたか」を再現できるようにする。

## 実装タスク（段階的）

### Phase 0: 仕様/境界の確定（小さく決める）

- [ ] resolved モデルの形を確定する
  - 推奨: `timeoutMs` を保持し、`deadlineAt = now + timeoutMs` は step 実行直前に決める（長時間ワークフローでも timeout がズレない）
- [ ] completion_check の timeout 既定を決める
  - 推奨: `check.timeout` 未指定時は `step.timeoutMs / 4`（docs の既定と整合）。互換リスクがあれば後方互換フラグで段階導入
- [ ] agent catalog の解決場所を固定する
  - 推奨: 現状どおり parse 時に解決（`src/workflow/parser.ts`）し、resolved は「実行のための正規化」に集中

### Phase 1: 正規化を 1 箇所に集約（shared resolver 導入）

- [ ] `src/workflow/resolve-worker-task.ts`（名称は任意）を追加
  - `resolveTaskLike(def, workspaceRoot, env)` を実装
    - duration string -> ms（`timeoutMs`, `maxCommandTimeMs`）
    - `workspace` -> `workspaceRef`（`path.resolve`）
    - capability string[] -> `WorkerCapability[]`
    - `worker` -> `WorkerKind`
    - `model` / `instructions` / `env` を反映
  - `buildWorkerTask(resolved, abortSignal)` を実装（`deadlineAt = now + timeoutMs`）
- [ ] 単体テストを追加: `test/unit/workflow/resolve-worker-task.test.ts`
  - duration parse / workspace resolve / capability mapping / default timeout

### Phase 2: StepRunner の重複除去（resolver 利用に置換）

- [ ] `src/workflow/multi-worker-step-runner.ts` を resolver 方式に置換
  - 既存の `buildWorkerTask`/型定義を削除し、shared resolver を使用
- [ ] `src/workflow/core-ipc-step-runner.ts` を resolver 方式に置換
  - `ResolvedWorkerTaskDef`/変換ロジックの重複を削除
- [ ] 両Runnerで「同一 StepDefinition -> 同一 resolved spec」になることのテストを追加
  - 例: resolved だけ比較（`workerTaskId`/`deadlineAt` は除外）

### Phase 3: Core IPC 境界の型契約を固定（payload 共有 + 検証）

- [ ] `src/types/worker-task-job-payload.ts`（名称は任意）を追加
  - `WorkerTaskJobPayload` 型 + type guard（最低限: 必須フィールドの存在/型）
- [ ] `src/workflow/core-ipc-step-runner.ts` で payload を `WorkerTaskJobPayload` で組み立てる
- [ ] `src/core/agentcore.ts` で payload を type guard で検証し、`as { ... }` を排除
  - invalid payload は `job_completed(outcome=failed, errorClass=NON_RETRYABLE)` で確実に終端させる
- [ ] テストを追加
  - invalid payload が Core で fail-fast し、ハング/未完了が起きない

### Phase 4:（任意）Compiled Workflow モデルへ昇格

- [ ] `ResolvedWorkflow` / `ResolvedStepStatic` を導入して「静的フィールド」を事前解決
  - 注意: convergence で `instructions` が動的に変わるため、instructions は毎回適用（静的解決から除外）
- [ ] Executor/Runner の境界を整理し、resolved を一度だけ作って共有する

### Phase 5: 観測性/成果物（resolved 値の永続化）

- [ ] `context/<step>/_meta.json` に resolved 値（timeoutMs/workspaceRef/workerKind/model 等）を必要最小限で記録
- [ ] docs 更新（この issue と `docs/guide/workflow.md` の該当箇所）

## 受け入れ条件

- duration/path/budget/capabilities の解決ロジックが 1 箇所に集約される
- `MultiWorkerStepRunner` と `CoreIpcStepRunner` から正規化ロジックが消え、compiled モデルを実行するだけになる
- Core 側が typed payload を検証し、Runner/Core 間の契約が明文化される
- 既存 examples が動作し、`make typecheck` / `make test` が通る

## 参考（現行の該当箇所）

- YAML parse / schema: `src/workflow/parser.ts`, `src/workflow/types.ts`
- DAG validate: `src/workflow/dag-validator.ts`
- Executor: `src/workflow/executor.ts`
- StepRunner (direct): `src/workflow/multi-worker-step-runner.ts`
- StepRunner (supervised): `src/workflow/core-ipc-step-runner.ts`
- Core worker delegation: `src/core/agentcore.ts`
