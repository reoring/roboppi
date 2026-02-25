# completion_check の待機最適化不足（状態待ちを自発検知して早期収束できない）

ステータス: 提案（要実装）

## 問題

`platform-dev-0042` の実行で、以下のような長時間待機が発生した。

- `verify.sh` 内の `e2e/kest-env.sh --need control` が、ControlCluster 側 CRD 待機で 10 秒間隔リトライを継続
- 典型ログ:
  - `control crd present: k0smotrondockerclusters.cluster.appthrust.io`
  - `Error from server (NotFound): customresourcedefinitions.apiextensions.k8s.io "k0smotrondockerclusters.cluster.appthrust.io" not found`
- 既定待機は 600 秒（10 秒間隔）で、失敗が明白でもタイムアウトまで待つ

現状では `completion_check` が `verify.sh` の完了後にしか判定できないため、
「待機が非生産的である」ことを早期に検知して `fix.md` へ接続するまでの時間が長い。

## 現行挙動（要点）

対象:

- `../appthrust/platform/e2e/kest-env.sh`
- `../appthrust/platform/.roboppi-loop/verify.sh`
- `src/workflow/executor.ts`

現状フロー:

1. `implement` がコード変更
2. `completion_check` が `verify.sh` を実行
3. `verify.sh` 内で `retry_until_success` による固定間隔ポーリング
4. 失敗時に初めて verdict/fix フェーズへ進む

重要点:

- `completion_check` は `verify.sh` が返るまで介入できない
- `retry_until_success` は「進展なし」を認識しない（時間ベースのみ）
- 失敗要因が「即時に再現可能な欠落（NotFound 等）」でも待機を続ける

## 根本原因

1. 待機ロジックが時間主導（timeout 主導）
- 条件不成立時の原因分類（未配備 / 永続失敗 / 依存欠落）がない

2. 進展判定の欠如
- 前回観測との差分（resourceVersion, condition 変化, failed reason 変化）を見ない

3. 失敗シグナルの抽象化不足
- `kubectl` エラー文字列があるだけで「早期失敗可能」か判断しない

4. 修正ループへの接続が遅延
- `fix.md` 生成は verify 完了後にしか実行できない

## 目標

1. 待機中に「進展なし / 致命条件」を検知し、早期終了できる
2. 早期終了時に機械可読な失敗理由（fingerprint）を残す
3. `completion_check` が即座に `incomplete` 判定し、次 iteration の修正に入れる
4. 既存互換を保ちつつ、待機時間を短縮する

## 解決方針

## 1) Probe 付き待機プリミティブを導入

`retry_until_success` を拡張した `retry_with_probe` を追加する。

インターフェース案:

- `condition_cmd`: 成功判定
- `probe_cmd`: 状態収集（JSON 出力推奨）
- `classify_cmd`: probe を `retryable | terminal_fail | progressing | stalled` に分類
- `stall_threshold`: 進展なし連続回数上限
- `max_wait`: 最大待機秒

挙動:

- `terminal_fail`: 即時失敗（timeout を待たない）
- `stalled` が閾値超過: 早期失敗
- `progressing`: 待機継続

## 2) 失敗分類ルール（初期）

CRD 待機に対して以下を最低限実装する。

- `NotFound` が続く場合:
  - 依存 HelmRelease/ClusterSummary が `Failed` なら `terminal_fail`
  - 依存が `Progressing` なら `retryable`
- `Forbidden` / `Unauthorized`:
  - `terminal_fail`（権限問題）
- webhook/TLS エラー:
  - 一定回数までは `retryable`、閾値超過で `stalled`

## 3) 診断アーティファクトの標準化

早期失敗時に以下を必ず出力する。

- `context/<step>/wait-failure.json`
  - `check_id`, `phase`, `target`, `reason`, `fingerprints`, `elapsed_s`
- `context/<step>/wait-probe.log`
  - probe の時系列（secret-safe）

`completion_check` はこれを参照して `review.verdict` / `fix.md` を生成する。

## 4) verdict への理由伝播を強制

`review.verdict`（JSON）に最低限以下を要求する。

- `decision: "incomplete"`
- `reasons: [...]`
- `fingerprints: [...]`

例 fingerprint:

- `kest/control/crd-missing/k0smotrondockerclusters`
- `kest/control/helmrelease-failed/<release>`
- `kest/control/stalled/no-progress`

## 5) Workflow DSL の拡張（任意）

将来的に workflow 定義で待機制御を記述できるようにする。

案:

- `wait_policy` フィールド
  - `mode: timeout_only | probe_aware`
  - `stall_threshold`
  - `terminal_patterns`

ただし初期実装は `e2e/kest-env.sh` の関数化だけでも効果がある。

## 実装計画（段階）

1. `e2e/kest-env.sh` に `retry_with_probe` を追加
- まず `control crd present` 待機に適用

2. `ctl1` bring-up 用 probe を追加
- `CRD`, `HelmRelease`, `ClusterSummary`, `events` を収集
- secret-safe でログ化

3. 早期失敗時の JSON 出力を実装
- `wait-failure.json` を生成

4. `verify.sh` / completion_check プロンプトを更新
- `wait-failure.json` を読んで `fix.md` に具体化

5. Roboppi 側の判定補助
- `completion-decision` の `reasons/fingerprints` を活用した収束制御に接続

## 受け入れ条件

1. CRD 欠落が継続し依存が失敗しているケースで、600 秒待たずに失敗終了できる
2. 早期失敗時に `wait-failure.json` が出力される
3. `completion_check` が `incomplete` + `fix.md` を生成し、次 iteration で修正に入る
4. 既存の正常ケースでは誤判定で早期打ち切りしない
5. ログは secret-safe（kubeconfig 本文/token を出さない）

## 非目標

- すべての待機ポイントを一度に probe 化すること
- すべての外部依存失敗を自動修復すること

## 既知リスクと緩和

1. 誤分類（本来回復可能な待機を terminal_fail 判定）
- 緩和: 初期は conservative に運用し、`terminal_fail` 条件を最小から拡張

2. probe 実行によるログ肥大
- 緩和: JSON 要約 + tail 保持 + artifact 収集上限

3. 実装複雑化
- 緩和: CRD待機1点から導入し、共通関数に寄せて段階展開

## 参考（今回観測した現象）

- PMC/ControlCluster 自体は最終的に Provisioned まで進むケースがある
- それでも特定 CRD が ControlCluster 上に現れず待機が長期化する
- 依存失敗（chart not found / ownership metadata 不整合）が同時に発生するため、
  単純な時間待機では収束が遅い
