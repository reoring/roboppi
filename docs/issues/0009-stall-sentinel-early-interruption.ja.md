# Stall Sentinel: workflow のスタックを早期に検出して中断する（Kubernetes wait / CRD 不整合など）

Status: proposal

## 問題

インフラ寄りの workflow（クラスタ構築、Helm deploy、readiness wait、OCI pull など）は、
「進捗が出ない／原因がほぼ確定しているのに待ち続ける」状態になりやすく、
実際に次のアクションが可能になるのは **timeout 発火時**になりがちです。

`appthrust/platform` の Issue 0042（kest CI を PMC/ControlCluster に寄せる）では特に顕著で、

- `verify.sh`（または subworkflow の phase）の中で wait が長時間ループする
- CRD 不在/不整合（依存導入の失敗など）が原因でも wait budget を最後まで消費しがち
- completion_check は verify が返るまで判断できず、修正ループへ戻れない
- workflow 全体の timeout 付近で `CANCELLED` / `SIGTERM`（例: exit code 143）になり、時間もシグナルも失う

CRD wait の具体例（非本質だが象徴的）:

- `appthrust/platform/e2e/kest-env.sh` が `retry_until_success ... 600 10 kubectl ... get crd <name>` を使う
- CRD が現れない場合、失敗がほぼ明らかでも 600s まで待ってから落ちる

Roboppi には Convergence Controller（反復 fingerprint による段階エスカレーション）がある一方、
「step 実行中に stall を検出して、早期に中断し、機械可読な証跡を残す」仕組みは不足しています。

## 目標

1. step/workflow timeout より前に、secret-safe かつ deterministic なシグナルで stall を検出する。
2. 可能な限り最小スコープ（当該コマンド/プロセスグループ）だけを中断する。
3. 構造化 artifact（JSON）を残し、安定した `fingerprints[]` を供給する。
4. Roboppi の既存機構と統合する:
   - completion_check の `decision_file` JSON
   - Convergence Controller（fingerprint の反復検出）
   - subworkflow（bubble / exports 安全化）

## 非目標

- あらゆるインフラ障害の完全分類。
- スクリプト内の probe-aware wait（ドメイン特化）を置き換えること（補完関係）。
- kubeconfig 本文/token/Secret data の出力・収集。

## 設計概要

Roboppi 側に step レベルの **Stall Sentinel（Stall Controller）** を導入します。

Sentinel は step 実行中の状態を監視し、stall 条件を満たしたら **早期に中断**し、
その理由と観測結果を **構造化 artifact** として保存します。

### どこに置くか

根本解は Roboppi runner 機能として実装し、以下を一貫して守れるようにする:

- worker step（`CUSTOM|CODEX_CLI|CLAUDE_CODE|OPENCODE`）
- completion_check の worker（= verify wait を cut できる）
- subworkflow step（child workflow を 1 単位として sentinel で守る）

短期の緩和策としては downstream repo 側で「シェルの watchdog wrapper」を入れる方法もあるが、
長期的には runner で提供する。

## Stall シグナル（deterministic）

複数のシグナルを合成可能にする。

### A: no-output deadline

一定時間 stdout/stderr イベントが無い場合に trigger。

- “完全ハング” に強い
- 10 秒ごとに同じエラーを出し続ける wait には効かない

### B: probe による no-progress

一定間隔で **probe コマンド（secret-safe）** を実行し、出力を hash して進捗を判定する。

- hash が `stall_threshold` 回連続で変わらない -> stalled
- probe が terminal failure を返す -> 即 fail

Kubernetes の wait（出力はあるが進捗しない）にはこれが主。

probe の要件:

- secret-safe
- ノイズが少なく、正規化された安定出力
- 推奨: 1 行 JSON（必要なら JSONL）

### C: terminal patterns（任意・保守的）

出力の regex で terminal と判定して早期に落とす。

文字列マッチは壊れやすいので、基本は probe 優先。

## 中断セマンティクス

trigger 時:

1. SIGINT（プロセスグループ）
2. `grace_int` 後に SIGTERM
3. `grace_term` 後に SIGKILL

何を送ったか（signals/timestamp）は artifact に残す。

## Artifact 契約

step context 配下へ書く（workspace-relative）:

- `context/<stepId>/_stall/event.json`
- `context/<stepId>/_stall/probe.jsonl`（任意）
- `context/<stepId>/_stall/stderr.tail.log`（任意・redacted）

### event.json schema（案）

```json
{
  "check_id": "<ROBOPPI_COMPLETION_CHECK_ID または run id>",
  "workflow": "<workflow name>",
  "step_id": "<stepId>",
  "iteration": 3,
  "trigger": {
    "kind": "no_output|no_progress|terminal",
    "reason": "8 intervals no probe progress",
    "observed_at_unix": 1739999999
  },
  "action": {
    "signals": ["SIGINT", "SIGTERM"],
    "terminated": true
  },
  "fingerprints": [
    "stall/no-progress",
    "k8s/crd/missing:k0smotrondockerclusters.cluster.appthrust.io"
  ],
  "pointers": {
    "step_log": "context/<stepId>/_logs/worker.log",
    "probe_log": "context/<stepId>/_stall/probe.jsonl"
  }
}
```

## completion_check + Convergence との統合

### completion_check

completion_check 中に sentinel が trigger した場合でも、checker は以下を出せるべき:

- `decision: "incomplete"`
- `event.json` から `fingerprints[]` を引き継ぐ
- `reasons[]` に `context/<step>/_stall/event.json` を指す短い説明を入れる

これにより「待つ→timeout→fix へ戻る」ではなく、
「早期中断→証跡→fix へ戻る」にできる。

### Convergence Controller

stall 由来 fingerprint（例: `stall/no-progress`, `k8s/crd/missing:<name>`）を標準化すると、
同一 stall の反復で段階エスカレーションできる:

- stage を上げて probe を強化 / 診断を増やす
- それでも同じなら fail-fast してチェックリスト（manual_actions）を出す

## Kubernetes / CRD 不整合: probe と fingerprint 指針

これは workflow 側の設計になるが、runner がやりやすくする。

CRD wait 向け probe は最低限以下をまとめるとよい:

- CRD の存在 + `spec.versions[]`
- upstream installer の状態（HelmRelease / ClusterSummary / Package reconcile）
- 高シグナルな controller 健康状態（OOMKilled / CrashLoopBackOff）

fingerprint 例:

- `k8s/crd/missing:<crd>`
- `k8s/crd/version-mismatch:<crd>`
- `k8s/helmrelease/failed:<ns>/<name>`
- `k8s/controller/oomkilled:<ns>/<name>`
- `k8s/wait/stalled:no-condition-change`

参考: `docs/issues/0008-completion-check-proactive-wait-minimization.md`
（スクリプト内の probe-aware wait による早期失敗）。

## Workflow DSL の露出（案）

step / completion_check に任意フィールド（名称 TBD）を追加する:

```yaml
steps:
  provision:
    # ...
    stall:
      no_output_timeout: "15m"
      probe:
        interval: "10s"
        command: |
          # secret-safe JSON を出す
          bash scripts/k8s-probe.sh --mode control
      stall_threshold: 6
      on_stall: interrupt   # interrupt|fail|ignore
```

初期実装は `no_output_timeout` + `probe` に絞ってよい。

## 実装計画（段階）

1. `stall` 設定の types + parser validate（opt-in）。
2. workflow executor に `StallController` を実装:
   - worker 出力ストリームを観測（last output time）
   - probe を timer で実行（best-effort）
   - ProcessManager 経由で process group を中断
   - `context/<step>/_stall/event.json` を生成
3. completion_check が stall artifact を `decision_file` に流し込む helper を追加。
4. テスト:
   - unit: no-output / no-progress / artifact
   - integration: 変化しない probe を持つ擬似 long-running CUSTOM step
5. probe-aware sentinel の example workflow を追加。

## 受け入れ条件

- probe が no-progress を示す stall は step timeout より前に中断できる。
- 中断時に必ず `context/<step>/_stall/event.json` が生成される。
- completion_check が stall artifact から `incomplete` を決め、安定 fingerprint を出せる。
- 同一 stall fingerprint の反復で Convergence が段階エスカレーションする。
- すべて secret-safe。

## 関連

- `docs/issues/0008-completion-check-proactive-wait-minimization.md`（CRD wait を含む probe-aware wait）
- `docs/issues/0004-implement-loop-self-healing.md`（Convergence Controller）
- `docs/wip/subworkflow-completion-loop.ja.md`（subworkflow ループ + convergence）
- 元の 0042 文脈のメモ（初稿）: `appthrust/platform/docs/roboppi/sentinel-agent-workflow-stall-interrupt.md`
