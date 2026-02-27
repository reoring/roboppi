# Workflow Management Agent テスト仕様書

Status: draft

設計参照: `docs/features/workflow-management-agent.md`

## 1. 目的
- Workflow Management Agent（以下「管理エージェント」）が、既存 workflow 実行へ安全に統合されることを検証する。
- 「安全なデフォルト（無効/失敗時は既存どおりに進む）」「決定プロトコルの厳密検証」「並列実行下の競合排除」「監査ログの完全性」を保証する。

## 2. 対象（スコープ）
- Workflow DSL
  - `src/workflow/types.ts`（`management` 追加、`StepStatus.OMITTED` 追加）
  - `src/workflow/parser.ts`（`management` ブロック検証、予約名追加）
- Workflow 実行
  - `src/workflow/executor.ts`（hook 呼び出し、OMITTED 依存解決、abortReason 拡張、タイムアウト上書き）
  - `src/workflow/multi-worker-step-runner.ts`（`createScopedAbort` の deadline 固定仕様に基づく pre_* 制約）
- 管理エージェント実装（新規）
  - `src/workflow/management/management-controller.ts`
  - `src/workflow/management/hook-context-builder.ts`
  - `src/workflow/management/decision-resolver.ts`
  - `src/workflow/management/directive-validator.ts`
  - `src/workflow/management/management-telemetry.ts`
  - `src/workflow/management/types.ts`
- 既存機能との統合
  - Sentinel: `src/workflow/sentinel/*`（stall 検知は Sentinel、判断は management）
  - completion_check / convergence: `src/workflow/executor.ts`, `src/workflow/completion-decision.ts`

## 3. 非対象
- LLM の推論品質（正しい判断を下すか、指示が「賢い」か）
- 外部 worker CLI（OpenCode / Claude Code / Codex CLI）の安定性そのもの
- Dynamic DAG modification（設計 Phase 6）

## 4. 用語/定義
- hook: `pre_step` / `post_step` / `pre_check` / `post_check` / `on_stall` / `periodic`
- hook invocation: hook を 1 回呼び出して decision を解決する処理単位。`hook_id`（UUID）で一意。
- decision file: management worker が書く `context/_management/inv/<hook_id>/decision.json`
- input file: executor が書く `context/_management/inv/<hook_id>/input.json`
- directive: decision 内の `directive`。`action` により型が決まる。
- staleness: decision が別 invocation のもの（`hook_id` 不一致、または mtime が古い）
- applied: decision が受理され executor に適用された（拒否/timeout/error/stale ではない）
- intervention: `directive.action !== "proceed"`
- OMITTED: 管理エージェントの skip により「任意に省略された」状態。下流をブロックしない。

## 5. 前提条件
- `bun` が利用可能
- テストはネットワーク不要・決定的であること（LLM 実呼び出し禁止）
- `/tmp` 等に一時ディレクトリを作成可能

## 6. テストレベル
- Unit: `test/unit/**`（validator / resolver / builder / telemetry 等の純粋ロジック）
- Integration: `test/integration/**`（executor と管理コンポーネント結合、ファイル生成・状態遷移）
- Acceptance(AT): `tests/at/**`（YAML -> parse -> executor の E2E。ただし worker は Mock で決定的）

## 7. 仕様要件（テスト対象の要求）
R-01: `management.enabled` が未指定/false のとき、既存 workflow と同一挙動（hook 無し、`_management/` 生成無し）。

R-02: `hooks: {}`（または全て false）は hook を一切発火させない。

R-03: hook invocation ごとに `hook_id=UUID` を生成し、以下を満たす。
- `context/_management/inv/<hook_id>/input.json` を作成
- `ROBOPPI_MANAGEMENT_HOOK_ID` / `ROBOPPI_MANAGEMENT_INPUT_FILE` / `ROBOPPI_MANAGEMENT_DECISION_FILE` を worker に渡す
- decision は `hook_id` 相関・staleness 判定に通らない限り適用されない

R-04: `decision-resolver` は decision JSON を厳格に検証する。
- JSON parse / 必須フィールド / 文字列長上限（append/reason/message: 4096）
- `hook_id` 不一致は stale として拒否
- `hook_id` 欠落は mtime ベースの staleness 判定（2s grace）
- 拒否/timeout/error 時は `{ action: "proceed" }` にフォールバックし、`decisions.jsonl` に理由を記録

R-05: `directive-validator` は permission matrix と step state を検証し、違反は拒否する。

R-06: `skip` は `StepStatus.SKIPPED` ではなく `StepStatus.OMITTED` をセットし、下流依存をブロックしない。

R-07: `modify_instructions` は overlay model を用いる。
- base instructions は不変
- convergence overlay の後に management overlay を合成
- management overlay は `pre_step` 毎に置換（`proceed` でクリア）
- overlay には `[Management Agent]` プレフィックスを付与

R-08: `abort_workflow` は `abortReason: "management"` として扱われ、workflow status は `CANCELLED`（v1）になる。

R-09: `adjust_timeout` は `pre_step` / `pre_check` のみ有効で、workflow 余り時間・Core 予算を超えない（上限で cap）。

R-10: `pre_step` は `launchReadySteps()` で RUNNING 遷移前に実行され、管理呼び出しが step concurrency を消費しない。

R-11: management 有効かつ Sentinel 無効でも `_workflow/state.json` が書かれる（ManagementTelemetrySink）。

R-12: Sentinel 有効かつ `management.hooks.on_stall=true` のとき、stall の「判断」は management が担当し、management 失敗時のみ Sentinel の静的 action にフォールバックする。

R-13: management worker の `worker_event` は main sink/telemetry/activity tracking に混入しない（専用 sink に隔離）。

R-14: runaway prevention
- `max_consecutive_interventions` 超過で hook 呼び出しを bypass（warning + proceed）
- `min_remaining_time` 未満で hook 呼び出しを skip（proceed）

R-15: `_management` は予約名
- step id として使用不可
- artifact name として使用不可

R-16: step-level overrides
- `steps.<id>.management.enabled=false` は当該 step の hook を無効化
- `context_hint` は management agent instructions に追加される

R-17: management agent は agent catalog を参照できる（`management.agent.agent: <id>`）。

## 8. テスト観点
- 安全性: invalid/stale/timeout を「停止せず proceed」へ収束させる
- 決定性: LLM/外部依存を排し、Mock で再現できる
- 並列性: `concurrency>1` でもファイル衝突しない（per-invocation dir）
- 互換性: Sentinel/Convergence/CompletionCheck と矛盾しない
- 監査性: `decisions.jsonl` と `inv/<hook_id>/` が追跡可能

### 8.1 生成物（ファイル/ログ）仕様（最小要件）

管理エージェント有効時（`management.enabled=true`）に、以下の生成物を検証対象とする。

- 管理アーティファクト
  - `context/_management/decisions.jsonl`
  - `context/_management/inv/<hook_id>/input.json`
  - `context/_management/inv/<hook_id>/decision.json`
  - `context/_management/inv/<hook_id>/worker.jsonl`（management worker が event を出した場合）

- `decisions.jsonl`（JSON Lines）必須フィールド
  - `ts`（number, epoch ms）
  - `hook_id`（string, UUID）
  - `hook`（string）
  - `step_id`（string）
  - `directive`（object）
  - `applied`（boolean）
  - `wallTimeMs`（number）
  - `source`（`file-json` | `none`）
  - `reason`（string, optional; `applied=false` のときは原則必須）

- `input.json` 必須フィールド（詳細 schema は実装で確定）
  - `hook_id`, `hook`, `step_id`
  - workflow state snapshot（少なくとも全 step の `status`/`iteration`/`maxIterations`）

- `decision.json` 必須フィールド
  - `hook_id`（推奨: 必須。欠落時は mtime + 2s grace による互換処理のみ許容）
  - `hook`, `step_id`
  - `directive`（`{ action: ... }`）
  - `reasoning`/`confidence` は任意（情報用途）

- management worker に渡す環境変数（hook invocation 単位）
  - `ROBOPPI_MANAGEMENT_HOOK_ID=<hook_id>`
  - `ROBOPPI_MANAGEMENT_INPUT_FILE=<abs path>`
  - `ROBOPPI_MANAGEMENT_DECISION_FILE=<abs path>`

- Telemetry independence（Sentinel 無効時）
  - `context/_workflow/state.json` は必ず存在（ManagementTelemetrySink）
  - `context/_workflow/events.jsonl` は Sentinel 専用（management 単独では生成しない）

## 9. テストケース

### 9.1 DSL/Parser

TC-MA-P-01: management 未指定は無効
- 種別: Unit
- 前提: workflow YAML に `management:` が無い
- 期待: parse 成功、実行時に hook が発火しない（`_management/` が生成されない）

TC-MA-P-02: management.enabled=true で agent 不足はエラー
- 種別: Unit
- 条件: `management.enabled: true` かつ `management.agent` 無し
- 期待: parse 失敗（フィールドパス付き）

TC-MA-P-03: hooks の未知キーはエラー
- 種別: Unit
- 条件: `management.hooks: { pre_step: true, unknown_hook: true }`
- 期待: parse 失敗

TC-MA-P-04: max_consecutive_interventions は 1 以上
- 種別: Unit
- 条件: `max_consecutive_interventions: 0`
- 期待: parse 失敗

TC-MA-P-05: reserved step id `_management`
- 種別: Unit
- 条件: `steps: { _management: ... }`
- 期待: parse 失敗

TC-MA-P-06: reserved artifact name `_management`
- 種別: Unit
- 条件: `outputs: [{ name: _management, path: ... }]`
- 期待: parse 失敗

TC-MA-P-07: management.agent は worker 直指定と agent catalog 参照を同時指定できない
- 種別: Unit
- 条件: `management.agent: { worker: OPENCODE, agent: workflow-manager, ... }`
- 期待: parse 失敗

TC-MA-P-08: management.agent.timeout は DurationString
- 種別: Unit
- 条件: `management.agent.timeout: "not-a-duration"`
- 期待: parse 失敗

TC-MA-P-09: min_remaining_time は DurationString
- 種別: Unit
- 条件: `management.min_remaining_time: "xxx"`
- 期待: parse 失敗

TC-MA-P-10: step-level management.enabled は boolean
- 種別: Unit
- 条件: `steps.A.management.enabled: "yes"`
- 期待: parse 失敗

TC-MA-P-11: step-level management.context_hint は string
- 種別: Unit
- 条件: `steps.A.management.context_hint: 123`
- 期待: parse 失敗

### 9.2 DecisionResolver（hook_id / staleness / JSON）

TC-MA-D-01: hook_id 一致の decision を受理
- 種別: Unit
- 手順: `hook_id=A` の invocation に対し、decision.json に `hook_id=A` を書く
- 期待: `hookIdMatch=true`、directive が返る

TC-MA-D-02: hook_id 不一致は stale として拒否
- 種別: Unit
- 手順: invocation `hook_id=A`、decision.json `hook_id=B`
- 期待: `hookIdMatch=false`、`reason` が設定され、directive は `proceed` へフォールバック

TC-MA-D-03: hook_id 欠落 + mtime 古いは stale
- 種別: Unit
- 手順: decision.json に hook_id を書かず、mtime を `hookStartedAt` より十分古くする
- 期待: stale 拒否、`proceed`

TC-MA-D-04: hook_id 欠落 + mtime 新しい（grace 内）は受理
- 種別: Unit
- 手順: decision.json に hook_id を書かず、mtime を `hookStartedAt` 直後にする（<=2s）
- 期待: 受理（`hookIdMatch=undefined`）、directive が返る

TC-MA-D-05: JSON 不正は拒否
- 種別: Unit
- 条件: decision.json が不正 JSON
- 期待: 拒否理由が記録され `proceed`

TC-MA-D-06: action 未知は拒否
- 種別: Unit
- 条件: `directive.action: "explode"`
- 期待: 拒否、`proceed`

TC-MA-D-07: 文字列フィールド上限（4096）
- 種別: Unit
- 条件: `append`/`reason`/`message` が 4096 超
- 期待: 拒否、`proceed`

TC-MA-D-08: hook/step_id ミスマッチは拒否
- 種別: Unit
- 条件: invocation context の `hook`/`step_id` と decision の `hook`/`step_id` が一致しない
- 期待: misattribution として拒否、`proceed`

TC-MA-D-09: decision file missing
- 種別: Unit
- 条件: decision.json が存在しない
- 期待: `source=none`、`reason` が設定され、`proceed`

TC-MA-D-10: directive 必須フィールド欠落
- 種別: Unit
- 条件: `action=skip` で `reason` が無い / `action=adjust_timeout` で `timeout` が無い等
- 期待: 拒否、`proceed`

### 9.3 DirectiveValidator（permission matrix / step state）

TC-MA-V-01: disallowed directive は拒否
- 種別: Unit
- 条件: `post_step` で `skip`
- 期待: 拒否、`proceed`

TC-MA-V-02: skip は READY のみ
- 種別: Unit
- 条件: step が RUNNING のとき `pre_step` 相当で skip を適用しようとする
- 期待: 拒否、`proceed`

TC-MA-V-03: adjust_timeout は pre_step/pre_check のみ
- 種別: Unit
- 条件: `post_check` で adjust_timeout
- 期待: 拒否、`proceed`

TC-MA-V-04: force_complete は post_check のみ
- 種別: Unit
- 条件: `pre_step` で force_complete
- 期待: 拒否、`proceed`

TC-MA-V-05: retry は on_stall のみ
- 種別: Unit
- 条件: `pre_step` で retry
- 期待: 拒否、`proceed`

TC-MA-V-06: modify_instructions は pre_step/pre_check/on_stall のみ
- 種別: Unit
- 条件: `post_step` で modify_instructions
- 期待: 拒否、`proceed`

TC-MA-V-07: annotate/abort_workflow/proceed は常に許可
- 種別: Unit
- 条件: いずれの hook でも annotate/abort_workflow/proceed
- 期待: 受理される

### 9.4 Executor 統合（状態遷移/並列/監査ログ）

TC-MA-E-01: management 無効時は挙動不変
- 種別: Integration
- 条件: `management` 無し、既存 workflow 実行
- 期待:
  - workflow 成否/step 状態が従来どおり
  - `context/_management/` が存在しない

TC-MA-E-02: pre_step proceed
- 種別: Integration
- 条件: `management.enabled=true`, `hooks.pre_step=true`、管理 worker が proceed decision を返す
- 期待:
  - step は通常どおり RUNNING→SUCCEEDED
  - `context/_management/inv/<hook_id>/{input.json,decision.json}` が作成される
  - `context/_management/decisions.jsonl` に 1 行追加（`applied=true`）

TC-MA-E-03: pre_step skip は OMITTED になり下流をブロックしない
- 種別: Integration
- 条件: A→B（B depends_on A）。A の pre_step で skip。
- 期待:
  - A: `StepStatus.OMITTED`
  - B: 実行され `SUCCEEDED`
  - runner の runStep は A を呼ばない

TC-MA-E-04: OMITTED の outputs は空
- 種別: Integration
- 条件: B が `inputs: [{ from: A, artifact: out }]` を持つ。A は OMITTED。
- 期待:
  - B の workspace に `out/` がコピーされない（missing を許容し失敗しない）

TC-MA-E-05: overlay 合成（base + convergence + management）
- 種別: Integration
- 条件: convergence stage>1 で convergence overlay が有効、かつ pre_step で modify_instructions
- 期待:
  - runStep に渡る instructions が `base` → `convergence` → `[Management Agent]...` の順
  - 同一 iteration で重複 append が発生しない

TC-MA-E-06: management overlay の置換/クリア
- 種別: Integration
- 条件: iteration 3 で modify_instructions、iteration 4 で proceed
- 期待:
  - iteration 4 の instructions に iteration 3 の管理 overlay が残らない

TC-MA-E-07: pre_step は concurrency slot を消費しない
- 種別: Integration
- 条件: `concurrency=2`、独立 2 step が READY。同時に pre_step hook を有効化。
- 期待:
  - step 実行時の `maxConcurrentObserved >= 2`
  - management hook 待ちが step 並列性を低下させない

TC-MA-E-08: hook_id 競合なし（並列）
- 種別: Integration
- 条件: 同時に 2 つの pre_step hook が走る（concurrency=2）
- 期待:
  - `_management/inv/` 配下に異なる `hook_id` ディレクトリが 2 つ作成
  - decision の取り違えが起きない（各 step が自分の decision を適用）

TC-MA-E-09: management timeout は proceed（安全）
- 種別: Integration
- 条件: 管理 worker が timeout を超えて応答しない
- 期待:
  - workflow がハングしない
  - decisions.jsonl に `applied=false` と `reason=timeout` 相当が記録
  - step は通常どおり実行される

TC-MA-E-10: max_consecutive_interventions guard
- 種別: Integration
- 条件: 連続で non-proceed decision を N 回返す（N=`max_consecutive_interventions`）
- 期待:
  - N+1 回目は hook 呼び出しを bypass（worker を起動しない）
  - warning が emit される

TC-MA-E-11: min_remaining_time guard
- 種別: Integration
- 条件: workflow timeout を短くし、残り時間 < min_remaining_time で hook 点に到達
- 期待:
  - hook を呼ばない（inv dir が増えない）
  - proceed と同等の挙動

TC-MA-E-12: abort_workflow
- 種別: Integration
- 条件: pre_step または post_step 等で abort_workflow
- 期待:
  - workflow status は `CANCELLED`
  - workflow meta に management 由来の abort reason が残る

TC-MA-E-13: ManagementTelemetrySink（Sentinel 無効でも state.json が書かれる）
- 種別: Integration
- 条件: `management.enabled=true` かつ `sentinel.enabled` 未指定/false
- 期待:
  - `context/_workflow/state.json` が存在し、workflow/step 状態が反映される
  - `context/_workflow/events.jsonl` は生成されない（Sentinel 無効のため）

TC-MA-E-14: Sentinel Telemetry を再利用（Sentinel 有効時）
- 種別: Integration
- 条件: `management.enabled=true` かつ `sentinel.enabled=true`
- 期待:
  - `context/_workflow/state.json` と `context/_workflow/events.jsonl` が生成される
  - management telemetry が二重に state.json を競合書き込みしない

TC-MA-E-15: step-level management.enabled=false は当該 step の hook を無効化
- 種別: Integration
- 条件: workflow-level で `hooks.pre_step=true`、ただし `steps.A.management.enabled=false`
- 期待:
  - A に対する pre_step invocation が発生しない（inv dir が増えない）
  - それ以外の step には hook が適用されうる

TC-MA-E-16: step-level context_hint は management agent instructions に反映
- 種別: Integration
- 条件: `steps.A.management.context_hint` を設定し、管理 worker 側で受領した instructions を検証
- 期待: hook-specific prompt に context_hint が含まれる

TC-MA-E-17: decisions.jsonl の形式
- 種別: Integration
- 条件: 複数 hook を発火させる
- 期待:
  - decisions.jsonl の全行が JSON として parse 可能
  - 8.1 の必須フィールドが存在

TC-MA-E-18: managementPending（同一 step に pre_step が重複発火しない）
- 種別: Integration
- 条件: scheduling loop が複数 tick 回り得る状況で pre_step を遅延させる
- 期待:
  - 同じ step に対し pre_step invocation が 1 回だけ生成される
  - 重複 invocation による inv dir 増殖が発生しない

TC-MA-E-19: post_step annotate は step 状態を変えない
- 種別: Integration
- 条件: post_step で annotate
- 期待:
  - step terminal status は維持される
  - main sink に warning が emit される

### 9.5 completion_check / convergence / Sentinel

TC-MA-X-01: post_check force_complete で loop 早期終了
- 種別: Integration
- 条件: completion_check が常に incomplete を返すが、post_check で force_complete
- 期待:
  - step の iteration が想定回数で止まる
  - workflow は SUCCEEDED（既存仕様に従う）

TC-MA-X-02: adjust_timeout（pre_check）で checker timeout を変更
- 種別: Integration
- 条件: checker が長時間かかるケースで、pre_check で timeout を延長
- 期待:
  - checker がタイムアウトせず完了
  - workflow 余り時間を超える要求は cap される

TC-MA-X-03: Sentinel stall + management on_stall
- 種別: AT
- 条件: Sentinel が stall を検知、`management.hooks.on_stall=true`
- 期待:
  - management hook が呼ばれ decision が記録される
  - management が valid directive を返した場合、Sentinel の静的 on_stall.action を適用しない
  - management が timeout/invalid の場合のみ静的 action にフォールバック

TC-MA-X-04: management worker event isolation
- 種別: AT
- 条件: 管理 worker が `worker_event(stdout/stderr)` を出す
- 期待:
  - main telemetry（`_workflow/events.jsonl`）に管理 worker の event が混入しない
  - `_management/inv/<hook_id>/worker.jsonl` にのみ記録される

TC-MA-X-05: on_stall retry（現在 attempt の再実行）
- 種別: AT
- 条件: Sentinel が stall 検知し管理 hook が `retry` を返す（`max_retries`/予算内）
- 期待:
  - 当該 step が再実行される（runner 呼び出し回数が増える）
  - retry の `modify_instructions` が次 attempt の instructions に反映される

TC-MA-X-06: on_stall で management timeout/invalid は Sentinel 静的 action にフォールバック
- 種別: AT
- 条件: management on_stall が timeout または invalid directive
- 期待:
  - Sentinel の設定どおりに interrupt/fail/ignore が適用される
  - decisions.jsonl に `applied=false` と理由が残る

TC-MA-X-07: subworkflow（v1 は parent のみ hook）
- 種別: AT
- 条件: subworkflow step を含む workflow で management を有効化（bubble on/off 両方）
- 期待:
  - hook の step_id は親 step のみ（子 step 単位では発火しない）
  - 親/子が別々に management を持つ場合、互いの decisions/inv が混線しない

## 10. 実行方法
- Unit: `make test-unit`
- Integration: `make test-integration`
- AT: `make test-at`
- 全部: `make test-all`

## 11. 合否基準
- P0（本仕様書の全テストケース）は全て PASS
- `decisions.jsonl` と `inv/<hook_id>/` が常に生成・整合し、拒否時も必ず安全側（proceed/fallback）に倒れる

## 12. トレーサビリティ（要求→テスト）
- R-01: TC-MA-E-01
- R-02: TC-MA-E-01, TC-MA-P-01
- R-03: TC-MA-E-02, TC-MA-E-08, TC-MA-D-01..D-04
- R-04: TC-MA-D-01..D-10
- R-05: TC-MA-V-01..V-07
- R-06: TC-MA-E-03, TC-MA-E-04
- R-07: TC-MA-E-05, TC-MA-E-06, TC-MA-X-05
- R-08: TC-MA-E-12
- R-09: TC-MA-X-02
- R-10: TC-MA-E-07, TC-MA-E-18
- R-11: TC-MA-E-13
- R-12: TC-MA-X-03, TC-MA-X-06
- R-13: TC-MA-X-04
- R-14: TC-MA-E-10, TC-MA-E-11
- R-15: TC-MA-P-05, TC-MA-P-06
- R-16: TC-MA-E-15, TC-MA-E-16
- R-17: TC-MA-P-07（解析）+（実行時解決の AT/Integration を別途追加）
