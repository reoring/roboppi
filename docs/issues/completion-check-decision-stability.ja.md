# Completion Check 判定の不安定性 (COMPLETE/INCOMPLETE parse failure)

ステータス: 実装進行中（core completion 判定の共通化 + decision_file 強化）

## 問題

`completion_check` で以下の失敗が発生する場合がある。

```
Completion check failed: could not parse completion decision (expected COMPLETE/INCOMPLETE marker)
```

実運用で確認された症状:

- Worker 出力に `INCOMPLETE` が存在するのに parse failure になる
- `.agentcore-loop/review.verdict` に `FAIL` が書かれていても判定に使われないケースがある
- その結果、`max_iterations` 到達前にワークフローが即 `FAILED` になる

この問題は workflow 側プロンプト調整では再発し得るため、AgentCore/Supervisor 側の判定実装を根本修正する。

## 現行挙動（要点）

対象実装:

- `src/workflow/core-ipc-step-runner.ts`
- `src/workflow/multi-worker-step-runner.ts`
- `src/workflow/completion-decision.ts`
- `src/worker/adapters/opencode-adapter.ts`

現状の判定経路:

1. `decision_file` があればファイルから判定を読む（`PASS/FAIL`, `COMPLETE/INCOMPLETE`）
2. 読めなければ worker の自由文テキストから marker を探索
3. 判定不能なら `NON_RETRYABLE` で step を失敗終了

## 根本原因

1. 判定チャネルが「自由文」に依存している
- LLM の最終出力形式が揺れると判定不能になる

2. `decision_file` の有効判定が時刻ヒューリスティック依存
- `mtime` に依存した鮮度判定で取りこぼす余地がある

3. runner 実装が二重化しており、挙動差の温床になっている
- `core-ipc-step-runner` と `multi-worker-step-runner` に同種ロジックが重複

4. 判定不能を即 fail にしている
- 判定チャネルの一時不整合で workflow 全体が落ちる

## 目標

1. completion 判定を決定的（deterministic）にする
2. 判定不能時に workflow が不必要に hard fail しない
3. 判定ロジックを単一実装に統一する
4. 既存 workflow との後方互換を維持する

## 実装メモ（2026-02-14）

- `src/workflow/completion-decision.ts`
  - `decision_file` を JSON / legacy テキストで解決する共通関数 `resolveCompletionDecision` を追加
  - `AGENTCORE_COMPLETION_CHECK_ID` と照合して `check_id` 安全性を追加
  - `PASS/FAIL`/`COMPLETE/INCOMPLETE` と JSON `{"decision":"...","check_id":"..."}` を受け入れる
- `src/workflow/core-ipc-step-runner.ts` と `src/workflow/multi-worker-step-runner.ts`
  - `decision_file` 判定を共通化
  - 判定不能を `checkResult.failed: false`（INCOMPLETE 扱い）に変更し、ハード失敗を回避
  - verbose 時に `decision_source` / `check_id_match` のログを出力

## 解決方針（本体側）

## 1) Structured Decision Contract を導入

`completion_check` の判定を構造化する。

- 新フォーマット（推奨）:
  - `decision_file` に JSON を書く
  - 例: `{"decision":"complete","check_id":"...","reasons":[...],"fingerprints":[...]}`
- 旧フォーマット（互換）:
  - `PASS/FAIL`
  - `COMPLETE/INCOMPLETE`

`check_id` により、古い run の判定ファイル混入を時刻比較なしで防止する。

## 2) 判定アルゴリズムを file-first で固定

優先順位を明示して一本化する。

1. `decision_file`（structured JSON）
2. `decision_file`（legacy text）
3. worker 出力 marker（互換フォールバック）

補足:
- marker 探索は互換のため残すが、正規経路は `decision_file` とする。

## 3) 判定不能時の扱いを `INCOMPLETE` に変更

現状の hard fail をやめる。

- 変更前: parse 不能 => `FAILED (NON_RETRYABLE)`
- 変更後: parse 不能 => `INCOMPLETE`（再ループ対象）

上限管理:
- `max_iterations` で停止
- 追加で parse failure カウントを保持し、閾値超過時に分かりやすい失敗理由を返す

## 4) runner 実装を共通モジュールへ集約

共通判定モジュールを新設して重複を除去する。

- 例: `src/workflow/completion-resolution.ts`
- `core-ipc-step-runner.ts` / `multi-worker-step-runner.ts` は同モジュールを利用

## 5) 観測性（debuggability）を強化

判定ログに最低限以下を出す。

- `decision_source`（file-json / file-legacy / marker / none）
- `check_id` の一致有無
- parse failure 理由（"missing decision", "invalid json", など）

## 実装計画

1. 型/仕様追加
- `CompletionCheckDef` に structured decision の仕様コメントを追加
- `check_id` の生成と受け渡し仕様を確定

2. 共通判定モジュール実装
- `parseCompletionDecisionFromFile` を structured 対応
- 判定優先順位を共通関数化

3. runner 置換
- `core-ipc-step-runner.ts` の判定部分を共通化
- `multi-worker-step-runner.ts` の判定部分を共通化

4. failure semantics 変更
- parse failure を `INCOMPLETE` 扱いに変更
- parse failure カウンタを step state に追加（必要なら）

5. テスト
- 単体テスト:
  - structured file 判定（complete/incomplete）
  - legacy file 判定（PASS/FAIL）
  - marker fallback
  - stale file（check_id 不一致）
  - invalid json
- 統合テスト:
  - `examples/agent-pr-loop.yaml` 相当で `FAIL -> fix -> PASS` のループ完走
  - marker のみでも後方互換で動作

6. サンプル更新
- `examples/agent-pr-loop.yaml` を structured decision に更新
- 既存サンプルは移行ガイドを添えて互換維持

## 受け入れ条件

1. `INCOMPLETE`/`FAIL` 判定で parse failure による即死が発生しない
2. `review.verdict`（または structured decision file）があれば安定してループ継続できる
3. `core-ipc` / `multi-worker` で同一入力に対して同一判定になる
4. 既存 `PASS/FAIL`, `COMPLETE/INCOMPLETE` workflow が互換で動作する

## 非目標

- LLM のレビュー品質（判定内容の妥当性）そのものを保証すること
- ワークフロー設計ミス（例: 永続的に FAIL になる TODO 設計）を自動解消すること

## 既知リスクと緩和

1. parse failure を `INCOMPLETE` にするとループが長引く
- 緩和: `max_iterations` と parse failure 閾値ログを明示

2. legacy/structured 混在で移行時の混乱
- 緩和: file-first の優先順位を固定し、ログに `decision_source` を出す

3. 既存 workflow との互換破壊
- 緩和: legacy text 判定のサポートを維持

## 進め方（短期）

1. 共通判定モジュール + structured file 対応を先行実装
2. parse failure を `INCOMPLETE` 化
3. `examples/agent-pr-loop.yaml` を structured decision に移行
4. 実環境で再現していたケースで再検証
