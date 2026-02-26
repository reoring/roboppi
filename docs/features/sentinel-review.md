# Sentinel 実装レビュー（未コミット）

Date: 2026-02-26（残課題対応の実装まで反映）

このドキュメントは、現在の作業ツリー（未コミット）に入っている Sentinel 実装を
「要件を満たす構造になっているか」という観点で包括的にレビューした結果をまとめます。

想定要件（会話での要件を反映）:

- Sentinel は workflow の "step" として実行されない（runner-owned / 並走コンポーネント）
- workflow 定義に Sentinel 設定を持ち、step ごとに "この条件で監視" を宣言できる
- Sentinel は step 本体とは独立して `kubectl` 等の probe を実行して
  progressing / stalled / terminal を判断できる
- terminal（回復不能 / 打つべき手）なら待たずに止め、フィードバック（reasons/fingerprints + artifacts）を残せる
- "現在実行中のコマンドを止めてやりなおさせる"（redo/retry）や、continue/break が
  deterministic に制御できる

本レビューは、コード差分の精読 + テスト実行結果に基づきます。

## 実施した確認

- `git status` / `git diff` による変更点棚卸し
- 主要実装ファイルの読み取り（DSL/Executor/Sentinel各コンポーネント/テスト）
- 検証コマンド（いずれも成功）

```bash
make typecheck
make test-unit
make test-at
```

## 変更点（インベントリ）

Tracked（既存ファイルの変更）:

- `Makefile`
- `src/workflow/executor.ts`
- `src/workflow/parser.ts`
- `src/workflow/types.ts`

Untracked（新規追加）:

- `src/workflow/sentinel/`
  - `activity-tracker.ts`
  - `probe-runner.ts`
  - `sentinel-controller.ts`
  - `stall-watcher.ts`
  - `telemetry-sink.ts`
- `tests/unit/`（Sentinel の unit テスト群）
  - `tests/unit/sentinel-activity-tracker.test.ts`
  - `tests/unit/sentinel-parser.test.ts`
  - `tests/unit/sentinel-probe-runner.test.ts`
  - `tests/unit/sentinel-telemetry-sink.test.ts`
- `tests/at/workflow-sentinel.test.ts`（Sentinel の AT）
- `docs/features/sentinel.md`（設計ドキュメント）
- `docs/issues/0009-stall-sentinel-early-interruption.md`
- `docs/issues/0009-stall-sentinel-early-interruption.ja.md`

## 結論（要件適合性の総評）

MVP としては要件方向にかなり近い実装です。

- runner-owned Sentinel は実現（Executor で初期化し、step/check と並走）
- step/check に対して "外側から" probe を回して中断できる
- completion_check については `as_incomplete=true` により "止めて次の反復へ" を
  deterministic にできる（= verify の長い wait を切れる）
- artifacts（`event.json` / `probe.jsonl`）と fingerprints/reasons は出せる

一方で、実運用（特に supervised + TUI 無効や CUSTOM step の多用）に入れる前に意識したい
構造的な注意点が残っています。

対応済み（今回の実装で解消）:

- DSL の `action: ignore` の意味論（ignored の場合は event を残すが abort しない）
- telemetry 初期化順（`workflow_started` を telemetry が確実に捕捉）
- probe watcher の overlap（`setTimeout` ループに変更し、probe 完了後に次回を予約）
- probe stdout の上限（ストリーム読み取りで 64KB 上限、超過時は kill）
- `state.json` の毎イベント書き込み（debounce + `flush()` の導入）
- workflow teardown で `TelemetrySink.flush()` を呼び、debounce 中の最終スナップショットを書き出す
- `_workflow/` telemetry ディレクトリと stepId の衝突（stepId `_workflow` を予約）
- step-local abort listener のクリーンアップ（cleanup で remove）
- `error_class` の typo 検出（parser が `ErrorClass` enum と照合し、typo を parse 時にエラー化）
- probe の診断性（exit code を記録し、必要に応じて bounded stderr を `probe.jsonl` に記録できる）
- `no_output_timeout` の誤爆識別（worker_event 未観測時に `stall/no-initial-output` fingerprint を付加）
- worker_event が出ないモード向けの `no_output_timeout` 制御（`activity_source` により "any_event" / "probe_only" を選択可能）

残課題/注意点（中長期・運用で吸収する前提）:

- `no_output_timeout` の意味論: "no output" は観測面に依存する。worker_event が出ないモード
  では `activity_source: "probe_only"`（推奨）や `activity_source: "any_event"` を使う
- probe の stderr は `capture_stderr: true` の場合のみ保存される（デフォルトは `false`）。
  保存する場合は stdout だけでなく stderr も secret-safe 前提で実装/運用する必要がある

補足（低優先度の注意）:

- `TelemetrySink.emit()` は fire-and-forget のため、より強い保証（例: 最終イベントが必ず
  state.json に反映される）を求める場合は in-flight write の drain を含む flush 設計が必要

この辺りを改善すれば、0042 のような「待ちが長い・進捗がない・でもログが出続ける」
タイプに対して、かなり強いコントロール面になります。

## DSL / 契約レビュー

### workflow レベル: `sentinel:`

定義（`src/workflow/types.ts`）:

- `WorkflowDefinition.sentinel?: SentinelConfig`
- `SentinelConfig`:
  - `enabled?: boolean`
  - `telemetry?: { events_file?, state_file?, include_worker_output? }`
  - `defaults?: { no_output_timeout?, activity_source?, interrupt? }`

パーサ検証（`src/workflow/parser.ts`）:

- `sentinel.enabled` は boolean
- `sentinel.telemetry.*` は optional 文字列/boolean
- `sentinel.defaults.no_output_timeout` は duration string（`parseDuration()` で検証）
- `sentinel.defaults.activity_source` は enum（`worker_event|any_event|probe_only`）
- `sentinel.defaults.interrupt.strategy` は "cancel" のみ許容

指摘:

- `defaults.interrupt` は現状 "バリデーションされるが実行時には未使用"（常に cancel 的挙動）
- Sentinel/stall で追加した duration（`no_output_timeout`, `probe.interval`, `probe.timeout`）は
  parse 時に検証される（ただし workflow/step の `timeout` など、他の duration は既存どおり実行時 parse）

### step / completion_check レベル: `stall:`

定義（`src/workflow/types.ts`）:

- `StepDefinition.stall?: StallPolicy`
- `CompletionCheckDef.stall?: StallPolicy`

`StallPolicy`:

- `enabled?: boolean`
- `no_output_timeout?: DurationString`
- `activity_source?: "worker_event"|"any_event"|"probe_only"`
- `probe?: { interval, timeout?, command, stall_threshold, capture_stderr?, require_zero_exit? }`
- `on_stall?: { action, error_class?, fingerprint_prefix?, as_incomplete? }`
- `on_terminal?: { action, error_class?, fingerprint_prefix?, as_incomplete? }`

パーサ検証（`src/workflow/parser.ts`）:

- `activity_source` は enum（`worker_event|any_event|probe_only`）
- `no_output_timeout` は duration string（`parseDuration()` で検証）
- `probe.interval` は必須 duration string（`parseDuration()` で検証）
- `probe.timeout` は optional duration string（`parseDuration()` で検証）
- `probe.command` は必須 string
- `probe.stall_threshold` は number かつ >= 1
- `probe.capture_stderr` は boolean（デフォルト false / opt-in）
- `probe.require_zero_exit` は boolean（デフォルト false）
- action enum は `interrupt|fail|ignore`
- `error_class` は `ErrorClass` enum と照合してバリデーションする
- `_stall` を artifact 名として予約（outputs.name に `_stall` は不可）

指摘:

- `error_class` は `ErrorClass` enum と照合され、typo は parse 時に `WorkflowParseError` になる
- `action: ignore` は実装済み（event.json + warning を残し、abort しない。連続発火は抑制）

## 実装（ランタイム）レビュー

### 主要コンポーネント

Sentinel 実装は `src/workflow/sentinel/` 以下にまとまっています。

- `SentinelController`（`sentinel-controller.ts`）
  - Executor から呼ばれる入り口
  - `ActivityTracker` を持ち、guard（watcher）の start/stop を管理
  - abort は `AbortController.abort(reason)` の reason にタグ文字列を入れて識別

- `ActivityTracker`（`activity-tracker.ts`）
  - `ExecEvent` を受けて stepId ごとの活動タイムスタンプを更新
  - "出力活動" は `ExecEvent.type=worker_event` で更新（加えて step_phase/step_state も追跡し、`activity_source=any_event` で利用可能）

- Watcher（`stall-watcher.ts`）
  - `NoOutputWatcher`: `no_output_timeout` と `activity_source` に応じてトリガ（`probe_only` の場合は無効）
  - `NoProgressWatcher`: probe 実行 + digest 比較 + class 判定

- `ProbeRunner`（`probe-runner.ts`）
  - `sh -c <command>` を `Bun.spawn` で実行
  - stdout を JSON として parse し、digest を算出（probe の digest 指定を優先）
  - exit code を取得し、`require_zero_exit=true` のときは exit_code!=0 を失敗扱いにできる

- `TelemetrySink`（`telemetry-sink.ts`）
  - `ExecEventSink` をラップし、secret-safe に `events.jsonl` と `state.json` を書く

### Executor 統合（`src/workflow/executor.ts`）

#### 1) step-local AbortController の導入

- これが「workflow 全体を止めずに、今のコマンドだけ止める」の核
- `createStepAbortController()` で step/check ごとに AbortController を作成
- Sentinel はその controller を abort する

注意:

- `createStepAbortController()` は cleanup を返し、呼び出し側が `finally` で remove する
  ことで listener の積み上がりは解消されている

#### 2) effective sink（telemetry + activity）の合成

- `sentinel.enabled=true` のとき:
  - 元 sink を `TelemetrySink` でラップ
  - さらに composite sink を作り、
    - telemetry への書き込み
    - `SentinelController.onEvent()` への通知
    を同時に行う

改善:

- Sentinel/Telemetry 初期化が `workflow_started` emit より前に移動され、telemetry 側で
  `workflow_started` を確実に捕捉できる

#### 3) guard の開始/停止

- `resolveStallPolicy()` で実効ポリシーを確定（workflow defaults も反映）
- `runStep` 前に `guardStep`、`runCheck` 前に `guardCheck` を開始
- `finally` で guard.stop

#### 4) Sentinel abort の識別

- `SENTINEL_ABORT_REASON = "sentinel:stall"`
- Executor は `AbortSignal.reason === SENTINEL_ABORT_REASON` で Sentinel 由来中断を判定

#### 5) 結果マッピング（redo/continue/break の要）

実装上のポイント:

- "abort されたとき StepRunner が throw する" ケースだけでなく、
  "キャンセル結果を返す（throw しない）" ケースも現実には多い
- 今回の実装は、両方に対して Sentinel 由来なら deterministic にマップするようになっている

step 実行:

- Sentinel abort なら `StepRunResult` を `FAILED` として扱い、`errorClass` を付与
- これにより既存の `on_failure: retry` / `max_retries` が "redo" として機能
- continue は `on_failure: continue` を使うことで downstream が進める

completion_check:

- Sentinel abort + `as_incomplete=true` の場合:
  - `CheckResult` を `complete=false, failed=false` に変換
  - `fingerprints/reasons` を Sentinel trigger 由来で注入
  - その後は既存の反復ループ（max_iterations）が継続

- `as_incomplete` が無い場合は step を FAILED に落として break 可能

指摘:

- `action: ignore` は watcher 側で実装済み
- `action: fail` と `action: interrupt` の差は現状 "abort の有無" ではなく、executor 側の
  error class 既定値（fail→NON_RETRYABLE、それ以外→RETRYABLE_TRANSIENT）として表現される

## Artifact / Telemetry レビュー

### step-level artifacts

- `context/<stepId>/_stall/event.json`
- `context/<stepId>/_stall/probe.jsonl`（probe がある場合）

`event.json` は概ね次を含む:

- schema: `roboppi.sentinel.stall.v1`
- workflow id/name
- step id/iteration
- trigger.kind: `no_output|no_progress|terminal`
- action.kind: policy 由来（ignore の場合は abort せず、event のみ残す）
- fingerprints/reasons
- pointers

指摘:

- `event.json` の `step.phase` は `executing|checking` を記録できる
- pointers の telemetry パスは `sentinel.telemetry.events_file` の override を反映する

### workflow telemetry

`TelemetrySink` が `context/_workflow/` 配下に以下を書きます（デフォルト）:

- `events.jsonl`: JSONL で redacted ExecEvent
- `state.json`: 最新スナップショット

redaction:

- `include_worker_output=false`（デフォルト）なら stdout/stderr の content は保存せず、byteLength のみ
- core_log の line は保存しない

指摘（重要）:

- `state.json` は debounce（500ms）で書き出すため、I/O 負荷は軽減されている
- executor の `finally` で `TelemetrySink.flush()` が呼ばれ、debounce 中の state.json は
  workflow 終了時に書き出される
- ただし `TelemetrySink.emit()` 自体は fire-and-forget のため、より強い保証（例: 最終の
  `workflow_finished` が必ず state.json に反映される）を求める場合は、in-flight write の
  drain を含む flush 設計が必要

## Probe 契約レビュー

`ProbeRunner` は probe コマンドの stdout を JSON として扱い、以下を解釈します。

- `class?: "progressing" | "stalled" | "terminal"`
- `digest?: string`（あればそれを使用）
- `fingerprints?: string[]`
- `reasons?: string[]`
- `summary?: object`

`NoProgressWatcher` の挙動:

- `class=terminal` → 即時トリガ（on_terminal）
- `class=progressing` → no-progress カウンタをリセット
- それ以外 → digest equality で `stall_threshold` 回連続なら no_progress トリガ

指摘（重要）:

- probe stdout はストリーム読み取りで上限を適用しており、巨大出力によるメモリ圧迫リスクは軽減されている
- probe 実行は `setTimeout` ループになっており、overlap（並行実行）は起きない
 - probe は exit code を取得し、`probe.jsonl` に記録する
 - stderr は deadlock 回避のため常に bounded で読むが、`probe.jsonl` への記録は
   `capture_stderr: true` の場合のみ（保存する場合は stderr も secret-safe 前提）

## テストレビュー

unit tests（`tests/unit/`）:

- parser: sentinel/stall の validation + `_stall` 予約
- probe-runner: JSON parse / digest / timeout
- activity-tracker: event で timestamp 更新
- telemetry-sink: redaction / JSONL / state

AT（`tests/at/workflow-sentinel.test.ts`）:

- no_output_timeout で hang step を中断し、event.json が出る
- probe の digest 停滞で中断
- sentinel.enabled=false / stall.enabled=false の非干渉
- completion_check で `as_incomplete=true` のとき INCOMPLETE としてループ制御できる
- runner が abort 時に throw しない（FAILED を返す）ケースでも Sentinel としてマップされる

`Makefile` も更新され、`make test-unit` / `make test` に `tests/unit` が含まれるようになっています。

## 残る課題（中長期）

1) `no_output_timeout` の信頼性

- デフォルト（`activity_source: worker_event`）は `worker_event` 前提のため、BATCH/CUSTOM 等で
  worker_event が出ない場合は誤爆しやすい
- 対応策として `activity_source` を選べる:
  - `any_event`: step_phase/step_state も活動指標に含める（"出力" というより "観測できた活動" の監視）
  - `probe_only`: NoOutputWatcher を無効化し、probe を主戦力にする（推奨）
- `stall/no-initial-output` fingerprint により「worker_event 未観測」起因の検知であることを識別できる

2) `no_output_timeout` の意味論（worker_event が出ないモード）

- worker_event を観測できないとき、no_output は「実際の stdout/stderr が無い」ではなく
  「観測面が無い（または executor 側イベントが進まない）」を含む
- `any_event` は "step が何かしら進行している" を見る用途には有効だが、"出力が出ている" を
  厳密に意味しない
- 真に stdout/stderr の無出力を監視したい場合は、STREAM の要求（supervised の出力モード分離）や
  CUSTOM/Shell の worker_event 対応が必要

3) probe 診断情報と secret-safe のトレードオフ

- stderr 保存は `capture_stderr=true` の opt-in であり、成功時は stderr を保持しない
  （ProbeRunner 自体は deadlock 回避のため常に stderr を読む）
- success 判定は `require_zero_exit` で選択可能（後方互換の JSON-only / 厳密な exit_code==0）

## TODO（中長期）

- [x] `error_class` を parser で enum バリデーションし、typo を parse 時に落とす
- [x] probe 失敗時の診断情報を secret-safe に強化する（exit code の記録 + bounded stderr の opt-in 記録）
- [x] `no_output_timeout` の誤爆を識別可能にする（worker_event 未観測時の診断 fingerprint 付加）

- [x] worker_event が出ないモードの `no_output_timeout` を根本的に扱える設計を追加する
  → `activity_source` フィールド（`"worker_event"` | `"any_event"` | `"probe_only"`）を
  `StallPolicy` と `SentinelDefaultsConfig` に追加。BATCH/CUSTOM ワーカーでは
  `"any_event"`（step_phase/step_state タイムスタンプも参照）または `"probe_only"`（
  タイマーベース検知を無効化し probe のみに依存）を選択可能。
- [x] probe の stderr 保存をより安全にする（opt-in 化/マスク/キー allowlist 等の設計）
  → `capture_stderr: boolean` を `StallProbeConfig` に追加（デフォルト: `false`）。
  ProbeRunner は deadlock 防止のため常に stderr を読むが、probe.jsonl への書き込みは
  `capture_stderr: true` の場合のみ。
- [x] probe の success 判定ルールを明文化する（exit code と JSON の関係）
  → `require_zero_exit: boolean` を `StallProbeConfig` に追加（デフォルト: `false`）。
  `false` では JSON パース成功 = success（後方互換）。`true` では exit_code === 0 AND
  JSON パース成功で success。非ゼロ exit 時も parsed output は diagnostic 用に保持。

- [x] Sentinel/stall の duration を parse 時にバリデーションする
  → `no_output_timeout`, `probe.interval`, `probe.timeout` を `parseDuration()` で検証し、
  invalid の場合は `WorkflowParseError` を返す

運用上の推奨設定（TODO 完了済み）:

- worker_event が信頼できない step では `activity_source: "probe_only"` を設定し probe を主戦力にする
  （または `activity_source: "any_event"` で step_phase/step_state も活動指標に含める）
- probe stderr を診断に使いたい場合は `capture_stderr: true` を明示（デフォルトは安全側の `false`）
- probe の exit code で成否を厳密に判定したい場合は `require_zero_exit: true` を設定

0042（appthrust/platform Issue 0042）を確実に短縮するための TODO（運用・実装両面）:

- [x] workflow-level `sentinel.defaults` の適用範囲を整理する（`stall:` が無い step/check を guard するか、docs で明示してワークフロー側に `stall: {}` を要求する）
  → `resolveStallPolicy()` を変更し、`stall:` ブロックが無い step/check にも `sentinel.defaults` から
  自動的にポリシーを合成して guard するようにした。opt-out は `stall: { enabled: false }` で可能。
- [x] probe 実行環境を step/check と揃える（`ProbeRunner` に `env` を渡す、または `stall.probe.env` を DSL に追加する）
  → workflow-level `env` を executor → sentinel-controller → stall-watcher → ProbeRunner のチェーンで
  渡すようにした。probe は `{ ...process.env, ...workflowEnv }` で実行される。
- [x] probe の連続失敗（非JSON/timeout/non-zero 等）の扱いをポリシー化する（例: `on_probe_error` / `probe_error_threshold` で terminal/stall/ignore を選べる）
  → `StallProbeConfig` に `on_probe_error: "ignore"|"stall"|"terminal"` (default: "ignore") と
  `probe_error_threshold: number` (default: 3, min: 1) を追加。連続失敗時に on_stall/on_terminal を発火可能。
- [x] `as_incomplete` の適用範囲（現状 completion_check のみ）を `docs/features/sentinel.md` に明記し、step 本体での `INCOMPLETE` 化を設計するか「on_failure: continue で吸収」を推奨として固定する
  → `docs/features/sentinel.md` に明記。step 本体では FAILED + `on_failure: continue` で吸収を推奨。
- [x] `docs/features/sentinel.md` の例と実装差分を解消する（例: `sentinel.defaults` の挙動、event.json の `signals` フィールドの扱い）
  → event.json の `phase` を "executing" に修正、`signals` フィールドを削除、`terminal_pattern` を削除。
  defaults の auto-guard 挙動を明記。probe env inheritance を記載。

## 0042（appthrust/platform）観点のメモ

0042 の典型は「待ちループが出力し続ける/timeoutまで待つ」なので、
この Sentinel 実装の主戦場は probe（kubectl など）です。

- `no_output_timeout` は "worker_event が信頼できる" 条件が揃うまで慎重に
- completion_check 側（verify）に `as_incomplete=true` を付けると、
  "回復不能/停滞" を検知した時点で verify を止めて次の反復に進める
- probe は secret-safe JSON で fingerprints を出し、Convergence に接続する設計が有効

### 追加レビュー（0042: appthrust/platform Issue 0042 への対処性）

0042 の実例（`appthrust/platform`）では、待機は概ね以下の性質を持つ:

- `e2e/kest-env.sh` の `retry_until_success ... 600 10 kubectl ... get crd ...` のように、
  **10 秒おきに同じエラー（NotFound 等）を出し続ける**。
- つまり "ハングして無出力" ではなく、**出力はあるが進捗が無い**。
- `completion_check`（`verify.sh`）が返るまで executor は次の iteration（fix/implement）に戻れず、
  timeout 近傍で `CANCELLED`（例: exit 143）になると "時間もシグナルも失う"。

Sentinel（本実装）の適合点:

- `NoProgressWatcher`（`src/workflow/sentinel/stall-watcher.ts`）により、probe digest の停滞で
  **timeout 前に中断**できる（0042の本丸）。
- completion_check の `as_incomplete=true`（`src/workflow/executor.ts`）により、
  "中断 = 失敗" ではなく **INCOMPLETE として次 iteration に戻す** が実現できる。
- `event.json` / `probe.jsonl` と fingerprints/reasons が残るため、
  0042 の analyze/plan（または convergence）に安定キーを供給できる。

0042 で確実に効かせるための前提（運用/設定）:

- `no_output_timeout` 単体では効きにくい（出力が出続けるため）。**probe を主戦力にする**。
- probe は "kubectl 生出力" ではなく、毎回安定する secret-safe JSON を出す必要がある
  （時刻などの揺れを除去し、fingerprints を短く安定させる）。
- completion_check を止めてループに戻すには `on_stall` / `on_terminal` へ
  `as_incomplete: true` を明示する。

設計/実装のズレとして注意が必要な点（0042 適用時にハマりやすい）:

- ~~workflow の `sentinel.defaults` は `stall:` ブロックが存在する step/check にしか適用されない。~~
  → **解消済み**: `resolveStallPolicy()` が defaults から自動合成し、全 step を auto-guard する。
  opt-out は `stall: { enabled: false }` で可能。
- ~~probe が失敗（非JSON/timeout 等）した場合、現状は進捗/停滞判定に使わず無視される。~~
  → **解消済み**: `on_probe_error: "stall"|"terminal"` + `probe_error_threshold` で
  連続失敗時に on_stall/on_terminal アクションを発火可能。
- `as_incomplete` は **completion_check の結果変換にのみ**適用される。
  step 本体の Sentinel 中断は `FAILED` として扱われるため、"止めて downstream に進めたい" 場合は
  workflow の `on_failure: continue` 等で吸収が必要。（ドキュメントに明記済み）
- ~~`ProbeRunner` は `env: { ...process.env }` 固定で、step/check に渡す `env` を引き継がない。~~
  → **解消済み**: workflow env が executor → sentinel-controller → stall-watcher → ProbeRunner
  のチェーンで伝播される。
