# Workflow システム 受け入れテスト設計

## テスト方針

- **テストレベル**: YAML 文字列を入力、`WorkflowState` を出力として検証する E2E テスト
- **Worker**: `MockStepRunner` を使用。実プロセスは起動しない（プロセス統合はスコープ外）
- **ファイル I/O**: 実際のファイルシステム操作を行う（`ContextManager` が実ファイルを扱うため）
- **全テストを temp ディレクトリ内で実行し、テスト後にクリーンアップする**

---

## AT-1: YAML パース → DAG バリデーション → 実行 フルパイプライン

### AT-1.1 正常系: 設計書の「実装→レビュー→修正」例を完走

**入力 YAML**: `docs/workflow-design.md` セクション 3.1 の `implement-review-fix` ワークフロー

**MockStepRunner の振る舞い**:
- 全ステップ SUCCEEDED を返す
- 各ステップで `outputs[].path` に該当するファイルを workspace に書き出す

**検証項目**:
| # | 検証内容 | 期待値 |
|---|---------|--------|
| 1 | `WorkflowState.status` | `SUCCEEDED` |
| 2 | 全ステップの `StepState.status` | `SUCCEEDED` |
| 3 | 実行順序 | `implement` → (`test`, `review` 並列) → `fix` |
| 4 | `context/implement/implementation/` にファイルが存在 | true |
| 5 | `context/review/review-comments/` にファイルが存在 | true |
| 6 | `context/test/test-report/` にファイルが存在 | true |
| 7 | `context/_workflow.json` が存在し、name が正しい | `"implement-review-fix"` |
| 8 | 各ステップの `_meta.json` が存在する | true |

### AT-1.2 正常系: 設計書の「completion_check ループ」例を完走

**入力 YAML**: `docs/workflow-design.md` セクション 3.3 の `implement-from-todo` ワークフロー

**MockStepRunner の振る舞い**:
- `implement-all` ステップ: 毎回 SUCCEEDED
- `completion_check`: 3 回目で `complete: true` を返す
- `verify` ステップ: SUCCEEDED

**検証項目**:
| # | 検証内容 | 期待値 |
|---|---------|--------|
| 1 | `WorkflowState.status` | `SUCCEEDED` |
| 2 | `implement-all` の `StepState.iteration` | `3` |
| 3 | `implement-all` の `StepState.status` | `SUCCEEDED` |
| 4 | `verify` の `StepState.status` | `SUCCEEDED` |
| 5 | StepRunner の `runStep` 呼び出し回数（implement-all） | `3` |
| 6 | StepRunner の `runCheck` 呼び出し回数（implement-all） | `3` |

### AT-1.3 異常系: 不正な YAML は早期にリジェクト

**入力 YAML**: 各パターン

| ケース | YAML の問題 | 期待動作 |
|--------|-----------|---------|
| a | `version: "2"` | `WorkflowParseError`（version must be "1"） |
| b | `steps` が空オブジェクト | `WorkflowParseError`（at least one step） |
| c | ステップの `worker: "INVALID"` | `WorkflowParseError`（invalid worker） |
| d | `capabilities: ["DESTROY"]` | `WorkflowParseError`（invalid capability） |
| e | `completion_check` あり + `max_iterations` なし | `WorkflowParseError`（max_iterations required） |
| f | `completion_check` あり + `max_iterations: 1` | `WorkflowParseError`（must be >= 2） |
| g | `on_failure: "explode"` | `WorkflowParseError`（invalid on_failure） |
| h | YAML 構文エラー（インデント不正） | `WorkflowParseError`（Invalid YAML） |

### AT-1.4 異常系: DAG バリデーションエラー

| ケース | DAG の問題 | 期待動作 |
|--------|-----------|---------|
| a | A → B → A（循環） | `validateDag` がサイクルエラーを返す |
| b | A → B → C → A（3 ノード循環） | `validateDag` がサイクルエラーを返す |
| c | `depends_on: ["nonexistent"]` | 参照整合性エラー |
| d | `inputs[].from` が `depends_on` にない | 入力整合性エラー |
| e | 同一ステップ内で `outputs[].name` が重複 | 出力名一意性エラー |
| f | 自己参照 `depends_on: ["self"]` | サイクルエラー |

---

## AT-2: DAG 実行トポロジー

### AT-2.1 線形チェーン (A → B → C → D)

**検証項目**:
- 実行順序が厳密に `[A, B, C, D]` であること
- 各ステップ開始時に先行ステップが SUCCEEDED であること
- 全ステップ SUCCEEDED → `WorkflowStatus.SUCCEEDED`

### AT-2.2 ダイヤモンド (A → {B, C} → D)

**検証項目**:
- A 完了後に B, C が並列起動すること
- B, C 両方完了後に D が起動すること
- MockStepRunner の `maxConcurrentObserved >= 2`

### AT-2.3 ワイドファンアウト (A → {B, C, D, E})

**検証項目**:
- 4 ステップが並列起動可能であること（concurrency 制限なし時）
- concurrency: 2 の場合、同時実行が 2 以下であること

### AT-2.4 独立グラフ (A, B, C 相互依存なし)

**検証項目**:
- 全ステップが即座に READY になること
- 並列実行されること
- いずれかが FAILED でも他は影響を受けないこと（on_failure のポリシーによる）

### AT-2.5 深い依存チェーン (A → B → C → ... → J, 10段)

**検証項目**:
- 全 10 ステップが順番に完走すること
- 中間ステップの失敗が後続全てを SKIPPED にすること（on_failure: abort 時）

### AT-2.6 複雑 DAG（複数合流点）

```
A → B → D → F
A → C → D
A → C → E → F
```

**検証項目**:
- D は B と C の両方が完了してから起動
- F は D と E の両方が完了してから起動
- E は C のみに依存

---

## AT-3: コンテキスト受け渡し（ContextManager）

### AT-3.1 ステップ間のファイル受け渡し

**シナリオ**:
1. ステップ A が workspace に `output.txt` を書き出す
2. ステップ A の `outputs: [{name: "result", path: "output.txt"}]`
3. ステップ B が `inputs: [{from: "A", artifact: "result"}]` で参照
4. ステップ B の workspace に `result/output.txt` が存在することを検証

**MockStepRunner の振る舞い**:
- A の `runStep` 内で `fs.writeFile(workspace + "/output.txt", "hello")` を実行
- B の `runStep` 内で `fs.readFile(workspace + "/result/output.txt")` を読んで内容を検証

**検証項目**:
| # | 検証内容 | 期待値 |
|---|---------|--------|
| 1 | `context/A/result/output.txt` が存在 | true |
| 2 | B の workspace に `result/output.txt` が存在 | true |
| 3 | ファイルの内容 | `"hello"` |

### AT-3.2 ディレクトリ成果物の受け渡し

**シナリオ**: ステップ A が `src/` ディレクトリを出力し、ステップ B が参照する

**検証項目**:
- ディレクトリごと `context/A/<artifactName>/` にコピーされること
- B の workspace にディレクトリ構造が再現されること

### AT-3.3 `as` によるリネーム

**シナリオ**: `inputs: [{from: "A", artifact: "result", as: "prev-output"}]`

**検証項目**:
- B の workspace に `prev-output/` として配置されること（`result/` ではない）

### AT-3.4 存在しないアーティファクトの参照

**シナリオ**: A が outputs で宣言したパスにファイルを書かなかった場合

**検証項目**:
- `collectOutputs` がエラーにならないこと（スキップ）
- B の `resolveInputs` で該当ディレクトリが空であること

### AT-3.5 on_failure: continue 時の欠落入力

**シナリオ**:
- A が FAILED（on_failure: continue）
- B が A の成果物を inputs で参照

**検証項目**:
- B は起動されること
- B の workspace に A の成果物が存在しないこと（空）
- B がそれでも正常に実行可能なこと

### AT-3.6 `_meta.json` の内容検証

**シナリオ**: 成功したステップの `_meta.json` を読み取る

**検証項目**:
| フィールド | 期待値 |
|-----------|--------|
| `stepId` | ステップ ID と一致 |
| `status` | `"SUCCEEDED"` |
| `startedAt` | 0 より大きい数値 |
| `completedAt` | `startedAt` 以上 |
| `attempts` | 1 以上 |
| `workerKind` | ステップの `worker` と一致 |
| `artifacts` | `outputs` 定義と対応 |

### AT-3.7 `_workflow.json` の内容検証

**検証項目**:
| フィールド | 期待値 |
|-----------|--------|
| `id` | UUID 形式 |
| `name` | ワークフロー名と一致 |
| `startedAt` | 0 より大きい数値 |
| `status` | `"RUNNING"`（実行中に書き込まれるため） |

---

## AT-4: completion_check ループ

### AT-4.1 初回で完了（ループなし）

**シナリオ**: completion_check が 1 回目で `complete: true`

**検証項目**:
- `runStep` 1 回、`runCheck` 1 回
- `StepState.iteration` = 1
- `StepState.status` = `SUCCEEDED`

### AT-4.2 N 回目で完了

**シナリオ**: completion_check が N 回目（N = 5）で `complete: true`、`max_iterations: 10`

**検証項目**:
- `runStep` 5 回、`runCheck` 5 回
- `StepState.iteration` = 5
- ワークフロー全体 SUCCEEDED

### AT-4.3 max_iterations 到達 + abort

**シナリオ**: completion_check が常に `complete: false`、`max_iterations: 3`、`on_iterations_exhausted: "abort"`

**検証項目**:
- `runStep` 3 回、`runCheck` 3 回
- ステップ FAILED
- 後続ステップ SKIPPED
- ワークフロー FAILED

### AT-4.4 max_iterations 到達 + continue

**シナリオ**: completion_check が常に `complete: false`、`max_iterations: 3`、`on_iterations_exhausted: "continue"`

**検証項目**:
- ステップ INCOMPLETE
- 後続ステップが実行されること
- ワークフロー SUCCEEDED（他に失敗がなければ）

### AT-4.5 チェッカー自体が失敗

**シナリオ**: completion_check が `{complete: false, failed: true}` を返す

**検証項目**:
- ステップ FAILED
- ループは即座に終了（max_iterations に関わらず）
- on_failure ポリシーに基づき後続が SKIPPED or 実行

### AT-4.6 ループ中のステップ失敗 + retry 後に completion_check

**シナリオ**:
- iteration 1: `runStep` FAILED (RETRYABLE_TRANSIENT) → retry → SUCCEEDED → check 未完了
- iteration 2: `runStep` SUCCEEDED → check 完了

**検証項目**:
- `runStep` 3 回（失敗 1 + リトライ成功 1 + iteration 2 で 1）
- `runCheck` 2 回
- ステップ SUCCEEDED、iteration = 2

### AT-4.7 ループ中のイテレーション間でファイル状態が引き継がれる

**シナリオ**:
- iteration 1: Worker が `progress.txt` に "step1" を書く
- iteration 2: Worker が `progress.txt` を読み、"step1\nstep2" に追記
- completion_check: iteration 2 で完了

**検証項目**:
- 同一 workspace 上で動作しているため、ファイルの状態が蓄積されること
- 最終的な `progress.txt` の内容が "step1\nstep2" であること

---

## AT-5: エラーハンドリング

### AT-5.1 on_failure: abort — 後続が全て SKIPPED

**シナリオ**: A → B → C、B が FAILED (on_failure: abort)

**検証項目**:
- A: SUCCEEDED、B: FAILED、C: SKIPPED
- ワークフロー: FAILED

### AT-5.2 on_failure: continue — 後続が実行される

**シナリオ**: A → B → C、A が FAILED (on_failure: continue)

**検証項目**:
- A: FAILED、B: SUCCEEDED、C: SUCCEEDED
- ワークフロー: FAILED（FAILED ステップがあるため）

### AT-5.3 on_failure: retry — リトライ成功

**シナリオ**: A (max_retries: 2)、1 回目 FAILED (RETRYABLE_TRANSIENT)、2 回目 SUCCEEDED

**検証項目**:
- A: SUCCEEDED
- `runStep` 呼び出し回数: 2
- ワークフロー: SUCCEEDED

### AT-5.4 on_failure: retry — リトライ上限到達

**シナリオ**: A (max_retries: 2, on_failure: retry)、全回 FAILED

**検証項目**:
- `runStep` 呼び出し回数: 3（初回 + リトライ 2 回）
- A: FAILED
- 後続: SKIPPED

### AT-5.5 ErrorClass.FATAL が on_failure 設定を上書き

| ケース | on_failure 設定 | ErrorClass | 期待動作 |
|--------|---------------|-----------|---------|
| a | `continue` | `FATAL` | ステップ FAILED、後続 SKIPPED |
| b | `retry` (max_retries: 5) | `FATAL` | リトライなし（runStep 1回）、後続 SKIPPED |
| c | `abort` | `FATAL` | ステップ FAILED、後続 SKIPPED |

### AT-5.6 ErrorClass ごとの on_failure: retry 動作

| ErrorClass | on_failure: retry 時の動作 |
|-----------|--------------------------|
| `RETRYABLE_TRANSIENT` | リトライされる |
| `RETRYABLE_RATE_LIMIT` | リトライされる |
| `NON_RETRYABLE` | リトライされない（即 FAILED） |
| `FATAL` | リトライされない（即 abort） |

### AT-5.7 並列ステップの一方が abort した場合

**シナリオ**: A → {B, C} → D、B が FAILED (abort)、C は実行中

**検証項目**:
- B: FAILED
- C: 実行中なら完走する（実行中ステップはキャンセルされない）
- D: SKIPPED（B の abort により）
- ワークフロー: FAILED

### AT-5.8 デフォルト on_failure の確認

**シナリオ**: on_failure 未指定のステップが FAILED

**検証項目**:
- abort として扱われること（後続 SKIPPED）

---

## AT-6: タイムアウト

### AT-6.1 ワークフロー全体タイムアウト

**シナリオ**: workflow.timeout = "1s"、ステップ A が 5 秒かかる

**検証項目**:
- A: CANCELLED
- 未実行ステップ: SKIPPED
- ワークフロー: TIMED_OUT
- 実行時間が timeout 付近で終了すること（±500ms）

### AT-6.2 タイムアウト時に複数ステップが実行中

**シナリオ**: A, B, C が並列実行中にタイムアウト

**検証項目**:
- 実行中の全ステップ: CANCELLED
- PENDING のステップ: SKIPPED
- ワークフロー: TIMED_OUT

### AT-6.3 completion_check ループ中のタイムアウト

**シナリオ**: completion_check ループの途中（iteration 3/10）でワークフロータイムアウト

**検証項目**:
- ステップ: CANCELLED
- ループが中断されること
- ワークフロー: TIMED_OUT

### AT-6.4 タイムアウト後に AbortSignal が発火する

**シナリオ**: Worker が `abortSignal.addEventListener("abort", ...)` で監視

**検証項目**:
- abort イベントが発火すること
- Worker が abort を検知して処理を中断できること

---

## AT-7: 並行制御

### AT-7.1 concurrency: 1 で逐次実行

**シナリオ**: A, B, C（依存なし）、concurrency: 1

**検証項目**:
- `maxConcurrentObserved` = 1
- 全ステップ SUCCEEDED

### AT-7.2 concurrency: 2 で 4 ステップ

**シナリオ**: A, B, C, D（依存なし）、concurrency: 2

**検証項目**:
- `maxConcurrentObserved` <= 2
- 全ステップ SUCCEEDED

### AT-7.3 concurrency 未指定（デフォルト無制限）

**シナリオ**: A, B, C, D, E（依存なし）、concurrency 未指定

**検証項目**:
- 全ステップが同時起動可能であること
- `maxConcurrentObserved` >= 4

### AT-7.4 concurrency とDAG 依存の組み合わせ

**シナリオ**: A → {B, C, D}、concurrency: 2

**検証項目**:
- A 完了後、B, C, D のうち最大 2 つが同時実行
- 3 つ目は前の 2 つのいずれかが完了してから起動

---

## AT-8: DurationString パーサー

| 入力 | 期待値 (ms) |
|-----|------------|
| `"5s"` | 5000 |
| `"30s"` | 30000 |
| `"5m"` | 300000 |
| `"2h"` | 7200000 |
| `"1h30m"` | 5400000 |
| `"1h30m45s"` | 5445000 |
| `""` | Error |
| `"0s"` | Error |
| `"abc"` | Error |
| `"5x"` | Error |
| `"-5m"` | Error |

---

## AT-9: エッジケース

### AT-9.1 ステップが 1 つだけのワークフロー

**検証項目**:
- 正常に実行・完了すること
- DAG バリデーション通過

### AT-9.2 ステップの outputs が空の場合

**シナリオ**: ステップに `outputs` が定義されていない

**検証項目**:
- `context/<stepId>/` ディレクトリは作成されるが成果物は空
- 後続ステップの実行に影響しないこと

### AT-9.3 同一ファイルパスを複数ステップが出力

**シナリオ**: A と B がそれぞれ `outputs: [{name: "code", path: "src/main.ts"}]`

**検証項目**:
- 各ステップの context ディレクトリに個別にコピーされること（衝突しない）
- `context/A/code/main.ts` と `context/B/code/main.ts` が独立

### AT-9.4 非常に長いステップ ID

**シナリオ**: ステップ ID が 200 文字

**検証項目**:
- パース・バリデーション・実行がエラーにならないこと

### AT-9.5 instructions に特殊文字を含む

**シナリオ**: YAML の複数行テキスト、日本語、絵文字、バックスラッシュ

**検証項目**:
- パース後の `instructions` が元のテキストを正確に保持

### AT-9.6 全ステップが SKIPPED

**シナリオ**: A (on_failure: abort) が FAILED、B, C, D が全て A に依存

**検証項目**:
- ワークフロー: FAILED
- B, C, D: 全て SKIPPED

---

## AT-10: 現行ユニットテストとのカバレッジ差分

以下は現行のユニットテストで**カバーされていない**ため、受け入れテストで重点的に検証するべき項目:

| # | 不足箇所 | 対応 AT |
|---|---------|---------|
| 1 | YAML パース → バリデーション → 実行のフルパイプライン | AT-1.1, AT-1.2 |
| 2 | `ContextManager.resolveInputs()` / `collectOutputs()` による実ファイル受け渡し | AT-3.1 〜 AT-3.5 |
| 3 | `_meta.json` / `_workflow.json` の内容検証 | AT-3.6, AT-3.7 |
| 4 | completion_check + retry の組み合わせ | AT-4.6 |
| 5 | ループ間のファイル状態引き継ぎ | AT-4.7 |
| 6 | 並列ステップの一方が abort した場合の他方の振る舞い | AT-5.7 |
| 7 | ErrorClass ごとの retry 可否マトリクス | AT-5.6 |
| 8 | 深い依存チェーン（10 段以上） | AT-2.5 |
| 9 | concurrency と DAG 依存の組み合わせ | AT-7.4 |
| 10 | completion_check ループ中のタイムアウト | AT-6.3 |

---

## テスト実装ファイル構成（案）

```
tests/at/
├── supervisor.md                              # 本設計書
├── workflow-pipeline.test.ts                  # AT-1: フルパイプライン
├── workflow-dag-topology.test.ts              # AT-2: DAG トポロジー
├── workflow-context-passing.test.ts           # AT-3: コンテキスト受け渡し
├── workflow-completion-check.test.ts          # AT-4: completion_check ループ
├── workflow-error-handling.test.ts            # AT-5: エラーハンドリング
├── workflow-timeout.test.ts                   # AT-6: タイムアウト
├── workflow-concurrency.test.ts              # AT-7: 並行制御
├── workflow-duration-parser.test.ts           # AT-8: DurationString パーサー
└── workflow-edge-cases.test.ts               # AT-9: エッジケース
```

## 合格基準

- 上記全テストケースが PASS であること
- `bun x tsc --noEmit` が 0 エラーであること
- 既存の 408 テストが引き続き PASS であること
