# Implement ループの自律収束不足（INCOMPLETE の反復 / 収束不能）

ステータス: 部分実装（Convergence Controller: 停滞検知/段階的戦略切替/診断出力 + scope guard; baseline 差分は未実装）

## 問題

2026-02-14 の実行（`/home/reoring/appthrust/platform/.roboppi-loop/run-local-workflow-20260214-214510.log`）で、以下を確認した。

- `completion decision` の parse failure（`expected COMPLETE/INCOMPLETE marker`）はこのログでは発生していない
  - `completion decision: incomplete source=file-text` を複数回確認
  - parse failure 自体は別 run で発生しており、先行 issue で扱う
- `implement` は `INCOMPLETE` 判定で iteration を継続する（収束制御が弱い）
- 少なくとも 1 回はテスト失敗が観測されている
  - `go test ./...` が `template_test.go:104` で FAIL（`gateway-api-crds-template should contain standard install header`）
  - その後に `go test ./...` が PASS するケースもあり得るが、判定が `INCOMPLETE` のまま反復し得る（例: 互換 verdict が FAIL のまま / スコープ逸脱が残る）

つまり、判定の安定性問題（前 issue）は改善されつつあるが、"INCOMPLETE を自律的に収束させる" 制御が不足している。

## 現行挙動（要点）

1. `implement` が作業を実行
2. `completion_check` が verdict/marker から `COMPLETE/INCOMPLETE` を決定
3. `INCOMPLETE` なら次 iteration へ進む
4. 同一失敗（または同一 verdict）を検知しても、戦略切替や停止条件が弱く、反復し続ける

## 根本原因

1. completion 判定が基本二値（complete/incomplete）で、失敗内容の同一性（同じ失敗が続いているか）を状態として扱っていない
2. baseline（元々壊れているテスト / 既存 FAIL）と新規失敗の差分ゲートがない
3. failure fingerprint（失敗署名）の蓄積・比較がない（停滞検知ができない）
4. スコープ外変更（allowed paths 逸脱）の検出・抑制が弱く、修正対象が拡散しやすい
5. iteration 上限以外の停止条件が弱い（原因付き fail-fast / 診断アーティファクトが不足）

## 目標

1. 同一失敗の反復を自動検出し、戦略を段階的に切り替える
2. 収束不能時は早期に原因付きで停止する（fail-fast with diagnosis）
3. baseline 差分で完了判定を安定化する
4. スコープ外変更を抑制し、milestone の diff を小さく保つ

## 解決方針（AgentCore/Supervisor 側）

基本方針: Workflow の loop（`completion_check` + `max_iterations`）に、Supervisor 側で **収束コントローラ（Convergence Controller）** を追加する。

- 目的: 「同じ INCOMPLETE が続く」状態を機械的に検知し、
  - stage を上げて制約を強める（= 戦略切替）
  - それでも進展しない場合は診断付きで停止する
- 既存 workflow 互換: デフォルトは現行挙動維持（opt-in）とし、段階的に適用する

## 1) Structured Decision Contract を拡張（reasons / fingerprints）

completion 判定は LLM 自由文ではなく、**機械生成 JSON を正経路**に寄せる。

- `decision_file` 例（推奨）:
  - `{"decision":"complete|incomplete","check_id":"...","reasons":[...],"fingerprints":[...]}`
- `check_id` により stale file 混入を時刻比較なしで防止
- 互換（PASS/FAIL, COMPLETE/INCOMPLETE）も当面維持

この issue の self-healing は、`reasons` / `fingerprints` を主要シグナルとして利用する。

## 2) Failure Fingerprint を導入

テスト失敗を正規化して署名化し、iteration 間で比較する。

- 例: `command + package + testName + errorSignature + file:line`
- 出力: `fingerprint_id`（hash）
- 同一 fingerprint の連続回数を state に保持

## 3) Baseline 差分ゲートを導入

`implement` 前に baseline を取得し、完了判定は "新規失敗の有無" を見る。

- baseline 例: `go test ./...` の失敗集合
- completion 条件（例）:
  - `new_failures == 0`
  - `scope_violation == false`

実装メモ:
- baseline は「同一 workspace 上での実行」だと汚染されるため、可能なら `git worktree` 等で **クリーンな作業ツリー**を作り、その上で baseline を取る
- baseline 取得に失敗した場合は warning ではなく明示的に fail-fast（原因付き）

## 4) 停滞時の段階的戦略切替（Convergence Controller）

同一 fingerprint（または failure set）が続く場合、段階的に挙動を切り替える。

- Stage 1: 通常修正
- Stage 2: 最小修正モード（diff budget / allowed_paths を強制、不要変更の巻き戻しを優先）
- Stage 3: 診断アーティファクトを出して `FAILED`（理由明示、fingerprint と停滞根拠を添付）

これにより、無限に近い反復を防止する。

## 5) スコープガード（allowed_paths + diff budget）

workflow に `allowed_paths` を定義し、範囲外変更を検出したら `INCOMPLETE` + 明示理由にする。

- 例: milestone が controller 周辺なら `charts/` 変更は警告/ブロック

実装メモ:
- git repo であれば `git status --porcelain` / `git diff --name-only` で変更ファイル集合を取得し、allowed_paths に照合する
- workflow 生成物（例: `context/`, `.roboppi-loop/`）は scope 判定から除外する（誤検知防止）

## 6) Completion Check を完全機械判定へ寄せる

最終判定は LLM 自由文ではなく、`decision_file`（structured JSON）を正経路にする。

- LLM は「提案生成 + JSON 出力」に限定
- 互換のため marker 探索は残すが、file-first を固定

## 7) 診断アーティファクトを標準化

収束性を可視化するため、以下を保存する。

- `baseline_failures.json`
- `current_failures.json`
- `failure_fingerprint_history.json`
- `completion_reasons.json`

推奨保存先:
- workflow workspace の `context/<step>/...`（runner が収集しやすい）
- 併用で `.roboppi-loop/` にも置く場合は `.gitignore` 前提

## 実装計画

1. 失敗解析モジュール追加
- 例: `src/workflow/quality/failure-fingerprint.ts`

2. state 拡張（Convergence Controller）
- fingerprint 履歴、連続回数、failure set hash、diff hash、戦略 stage を保持
- stage に応じて implement step の instructions を自動で強制上書き/追記（最小修正モード等）

3. baseline ステップ追加
- `implement` 前に baseline 取得（可能なら clean worktree）

4. completion 判定拡張
- `decision_file` JSON に `reasons` / `fingerprints` を追加
- 判定ロジックは既存 resolver（`resolveCompletionDecision`）を拡張

5. scope guard 実装
- workflow 定義に `allowed_paths` を追加し検証
- scope violation は fingerprint としても記録し、停滞検知の材料にする

6. テスト
- 単体: fingerprint 正規化、同一判定、stage 遷移、allowed_paths 判定
- 統合: 同一 failure set が継続した場合に stage が進み、最終的に診断付きで停止

## 受け入れ条件

1. 同一 fingerprint が連続した場合、stage 遷移が発生する
2. stage 上限到達時、`FAILED` は原因（fingerprint/reason）付きで返る
3. baseline 差分で `new_failures == 0` のときのみ `COMPLETE` になる
4. `allowed_paths` 外の変更は検知・記録される
5. 既存 workflow（互換 verdict）との互換を維持する

## 非目標

- 任意の実装バグを常に自動修復すること
- LLM のコード品質を常に保証すること

## 既知リスクと緩和

1. テストの非決定性で fingerprint が揺れる
- 緩和: エラーメッセージ正規化・ノイズ除去・複数回観測

2. baseline に問題があると判定が歪む
- 緩和: baseline 取得失敗時は warning ではなく明示的に fail-fast

3. 実行時間増加
- 緩和: baseline の対象を設定可能にし、重いテストは明示 opt-in

## 関連

- 先行 issue: `docs/issues/completion-check-decision-stability.ja.md`
  - 判定パース安定化を扱う
  - 本 issue はその次段として、収束制御と自律修復性を扱う
