# Sentinel レビュー残課題 — 対応実装レポート

Date: 2026-02-26

## 概要

`docs/features/sentinel-review.md` で指摘された残課題3点に対する修正を実装した。
本ドキュメントはその変更内容・設計判断・検証結果をまとめる。

対象の残課題:

1. `error_class` の typo 検出 — parser が enum バリデーションしておらず typo が silent fallback になる
2. probe の診断性 — stderr を捨てているため probe 失敗時の情報が薄い
3. `no_output_timeout` の信頼性 — worker_event の有無に強く依存し BATCH/CUSTOM で誤爆しやすい

## 実施体制

3つの課題は互いに独立しているため、3エージェント並列（worktree 分離）で実装し、
リーダーが統合・最終検証を行った。

```
sentinel-fixes (Team)
├── team-lead          — 設計・統合・AT修正・最終検証
├── error-class-validator — 課題1: parser enum バリデーション
├── probe-diagnostics     — 課題2: stderr/exitCode 診断強化
└── no-output-fixer       — 課題3: no_output_timeout 信頼性
```

## 課題1: `error_class` の typo 検出

### 問題

`validateStallAction()` は `error_class` を `validateOptionalString()` でしか検証せず、
任意の文字列が通る。typo（例: `RETRYABLE_TRANSIET`）は parse 時にエラーにならず、
実行時に unknown → デフォルトへ silent fallback する。

### 変更内容

**`src/workflow/parser.ts`**

```typescript
const VALID_ERROR_CLASSES = new Set<string>(Object.values(ErrorClass));
```

`validateStallAction()` に enum 照合を追加:

```typescript
validateOptionalString(obj["error_class"], `${path}.error_class`);
if (obj["error_class"] !== undefined && !VALID_ERROR_CLASSES.has(obj["error_class"] as string)) {
  throw new WorkflowParseError(
    `${path}.error_class must be one of: ${[...VALID_ERROR_CLASSES].join(", ")} (got "${String(obj["error_class"])}")`,
  );
}
```

`ErrorClass` は `src/types/common.ts` から import しているため、
enum に値が追加されれば自動的にバリデーションに反映される。

**`tests/unit/sentinel-parser.test.ts`** — テスト2件追加:

- `valid error_class passes validation` — `RETRYABLE_TRANSIENT` が通ることを確認
- `invalid error_class (typo) throws error` — `RETRYABLE_TRANSIET` が `WorkflowParseError` になることを確認

### 設計判断

- `ErrorClass` enum 値のハードコードではなく `Object.values(ErrorClass)` から動的生成
  → enum 拡張時にバリデーション側の修正が不要
- `on_stall` / `on_terminal` 両方の `error_class` に適用される（`validateStallAction` は共通関数）

## 課題2: probe の診断性強化

### 問題

`ProbeRunner` は `stderr: "ignore"` で probe を実行するため、probe が失敗した場合に
exit code・stderr といった診断情報がまったく得られない。

### 変更内容

**`src/workflow/sentinel/probe-runner.ts`**

`ProbeResult` インターフェースに2フィールド追加:

```typescript
export interface ProbeResult {
  success: boolean;
  output?: ProbeOutput;
  digest: string;
  error?: string;
  exitCode?: number;   // NEW: プロセス終了コード
  stderr?: string;     // NEW: bounded stderr（最大4KB、失敗時のみ）
  ts: number;
}
```

主な実装変更:

- `stderr: "ignore"` → `stderr: "pipe"` に変更
- stdout と stderr を `Promise.all` で並行読み取り（デッドロック防止）
- stderr は 4KB 上限（secret-safe トレードオフ）
- `exitCode` は全結果パスに含む
- `stderr` は失敗時のみ含む（成功時は省略）
- stdout/stderr 読み取りを `readBoundedChunks` / `readBoundedString` に共通化

```typescript
// stdout と stderr を並行読み取り
const [stdoutChunks, stderrText] = await Promise.all([
  this.readBoundedChunks(proc.stdout as ReadableStream<Uint8Array>, MAX_PROBE_OUTPUT_BYTES),
  this.readBoundedString(proc.stderr as ReadableStream<Uint8Array>, MAX_PROBE_STDERR_BYTES),
]);
```

**`src/workflow/sentinel/stall-watcher.ts`**

`NoProgressWatcher.appendProbeLog()` で `probe.jsonl` に `exitCode`/`stderr` を記録:

```typescript
if (result.exitCode !== undefined) entry.exitCode = result.exitCode;
if (result.stderr) entry.stderr = result.stderr;
```

**`tests/unit/sentinel-probe-runner.test.ts`** — テスト4件追加:

- `probe stderr is captured on failure` — 無効JSON出力時に stderr が捕捉される
- `probe exit code is captured` — 正常終了時 exitCode=0
- `probe non-zero exit code is captured on failure` — `exit 42` → exitCode=42
- `successful probe omits stderr` — 成功時 stderr は undefined

### 設計判断

- **stderr 上限 4KB**: stdout の 64KB より小さい。probe stderr に機密情報が混入するリスクを
  抑えつつ、エラーメッセージとして十分な量
- **成功時は stderr 省略**: 成功した probe の stderr は通常空であり、万一 secret が混入した場合の
  リスクを排除
- **`Promise.all` による並行読み取り**: stdout を先に読み終えてから stderr を読む逐次方式では、
  stderr バッファが満杯になった場合にプロセスがブロックし、stdout の読み取りも停止する
  デッドロックが起きうる
- **outer catch では exitCode/stderr を含めない**: プロセス起動自体が失敗した場合（`Bun.spawn` 例外）は
  exitCode/stderr が存在しない

## 課題3: `no_output_timeout` の信頼性

### 問題

`NoOutputWatcher` は `lastWorkerOutputTs`（`worker_event` でのみ更新）をもとに
タイムアウトを判定する。BATCH/CUSTOM ワーカーは `worker_event` を発行しないことがあり、
step 開始直後にタイムアウトが発火する（false positive）。

### 設計の経緯

当初は「`worker_event` を受信するまでタイムアウトをスキップする」
（`hasReceivedWorkerEvent === false` なら early return）方式で実装した。
しかし AT テストでこの方式は以下の問題を起こした:

- AT テストの CUSTOM ワーカーは `worker_event` を発行しない
- タイムアウトが永久に発火しなくなり、4件のテストが 5s timeout で失敗

これは正当なシナリオ（真にハングしている step を検知する）を壊す変更であった。

**最終設計**: タイムアウトの発火は維持しつつ、`hasReceivedWorkerEvent === false` の場合に
診断情報を付加する方式に変更した。false positive をブロックするのではなく
**識別可能にする**。

### 変更内容

**`src/workflow/sentinel/activity-tracker.ts`**

`StepActivity` に `hasReceivedWorkerEvent: boolean` を追加:

```typescript
export interface StepActivity {
  stepId: string;
  lastWorkerOutputTs: number;
  lastStepPhaseTs: number;
  lastStepStateTs: number;
  hasReceivedWorkerEvent: boolean;  // NEW
}
```

- `register()` で `false` に初期化
- `worker_event` 受信時のみ `true` に設定
- `step_phase` / `step_state` では変化しない

**`src/workflow/sentinel/stall-watcher.ts`**

`NoOutputWatcher.check()` で、タイムアウト発火時に `hasReceivedWorkerEvent` を参照:

```typescript
const noInitialEvent = !activity.hasReceivedWorkerEvent;

const trigger: StallTriggerResult = {
  kind: "no_output",
  reason: noInitialEvent
    ? `no worker output received since step start (threshold: ...) — no worker_event ever observed; consider using probe-based detection`
    : `no worker output for Xs (threshold: Ys)`,
  fingerprints: [
    "stall/no-output",
    ...(noInitialEvent ? ["stall/no-initial-output"] : []),
    ...(this.options.policy.on_stall?.fingerprint_prefix ?? []),
  ],
  reasons: [
    "no worker output detected",
    ...(noInitialEvent ? ["no worker_event received since step start — detection may be unreliable for this worker type"] : []),
  ],
};
```

`hasReceivedWorkerEvent === false` の場合に付加される情報:

| フィールド | 値 |
|-----------|-----|
| fingerprint | `stall/no-initial-output` |
| reason | `no worker_event received since step start — detection may be unreliable for this worker type` |
| trigger.reason | `... consider using probe-based detection` |

これらは `event.json` にも記録される。

**`tests/unit/sentinel-activity-tracker.test.ts`** — テスト3件追加:

- `hasReceivedWorkerEvent is false after register` — 初期値の確認
- `hasReceivedWorkerEvent becomes true after worker_event` — worker_event で ON
- `hasReceivedWorkerEvent remains false for step_phase and step_state events` — 他イベントでは変化しない

### 設計判断

- **発火のブロックではなく診断情報の付加**: 真のハングを検知する機能は維持しつつ、
  false positive を事後識別できるようにする
- **fingerprint `stall/no-initial-output`**: Convergence や外部システムで
  このフィンガープリントをフィルタ条件にすれば、BATCH/CUSTOM ワーカーの false positive を
  自動的に除外可能
- **DSL 変更なし**: 新しい設定項目を追加しない。ランタイムの挙動改善のみ
- **probe 推奨メッセージ**: reason に `consider using probe-based detection` を含め、
  オペレーターを正しい対処（probe 利用）へ誘導する

## 検証結果

すべてのテストスイートが pass:

```
make typecheck           → pass
make test-unit           → 973 pass, 0 fail
make test-at             → 147 pass, 0 fail
```

## 変更ファイル一覧

| ファイル | 課題 | 変更種別 |
|---------|------|---------|
| `src/workflow/parser.ts` | #1 | `VALID_ERROR_CLASSES` 追加、`validateStallAction()` に enum 照合追加 |
| `src/workflow/sentinel/probe-runner.ts` | #2 | `stderr: "pipe"`、`ProbeResult` に `exitCode`/`stderr`、並行読み取り |
| `src/workflow/sentinel/stall-watcher.ts` | #2, #3 | probe.jsonl に exitCode/stderr 記録、NoOutputWatcher に診断 fingerprint |
| `src/workflow/sentinel/activity-tracker.ts` | #3 | `hasReceivedWorkerEvent` フラグ追加 |
| `tests/unit/sentinel-parser.test.ts` | #1 | テスト2件追加 |
| `tests/unit/sentinel-probe-runner.test.ts` | #2 | テスト4件追加 |
| `tests/unit/sentinel-activity-tracker.test.ts` | #3 | テスト3件追加 |

## レビュー文書の TODO 更新

`sentinel-review.md` の TODO セクションとの対応:

- [x] `error_class` を parser で enum バリデーションし、typo を parse 時に落とす
- [x] probe 失敗時の診断情報を secret-safe に強化する（exit code / bounded stderr）
- [x] `no_output_timeout` の信頼性を上げる（false positive に診断 fingerprint を付加）

残る低優先度の注意点（第3弾で一部解消）:

- `TelemetrySink.emit()` は fire-and-forget（in-flight write の drain を含む flush が必要な場合は追加設計）
- `defaults.interrupt` はバリデーションされるが実行時には未使用
- ~~duration の妥当性は parse 時に検証されない（既存の他 duration と同様）~~ → 第3弾で解消

---

# Sentinel レビュー残課題（第2弾）— 中長期課題の対応実装レポート

Date: 2026-02-26

## 概要

`docs/features/sentinel-review.md` の中長期 TODO 3件に対する実装を行った。
前回の対応（課題1〜3: error_class typo 検出、probe 診断性、no_output_timeout 信頼性）が
「識別可能にする」アプローチだったのに対し、今回は「根本的に制御可能にする」DSL 拡張を実施した。

対象の残課題:

1. `no_output_timeout` の信頼性（根本対策）— worker_event が出ないモードを DSL で制御可能にする
2. probe stderr の安全性 — stderr の probe.jsonl 記録を opt-in 化する
3. probe success 判定ルールの明文化 — exit code と JSON の関係を DSL で宣言可能にする

## 実施体制

3つの課題は互いに独立しているため、3エージェント並列（worktree 分離）で実装し、
リーダーが統合・ドキュメント更新・最終検証を行った。

```
sentinel-remaining (Team)
├── team-lead               — 設計・統合・ドキュメント・最終検証
├── agent-activity-source   — 課題1: activity_source DSL 拡張
├── agent-capture-stderr    — 課題2: capture_stderr opt-in 化
└── agent-require-zero-exit — 課題3: require_zero_exit 明文化
```

## 課題1: `activity_source` — no_output_timeout の根本的な信頼性改善

### 問題

前回の対応（`stall/no-initial-output` fingerprint 付加）は false positive を
**識別可能に**したが、BATCH/CUSTOM ワーカーでは `no_output_timeout` が本質的に
不適切なケースが残る。ワーカー種別に応じてタイムアウトの判定基準を切り替える
DSL レベルの制御が必要。

### 変更内容

**`src/workflow/types.ts`**

`StallPolicy` と `SentinelDefaultsConfig` に `activity_source` フィールドを追加:

```typescript
export interface StallPolicy {
  // ...
  /** Controls which event timestamps drive no_output_timeout.
   *  - "worker_event" (default): uses worker stdout/stderr event timestamps
   *  - "any_event": uses the most recent of worker_event, step_phase, step_state
   *  - "probe_only": disables timer-based no_output_timeout; rely on probe
   */
  activity_source?: "worker_event" | "any_event" | "probe_only";
  // ...
}

export interface SentinelDefaultsConfig {
  no_output_timeout?: DurationString;
  activity_source?: "worker_event" | "any_event" | "probe_only";
  interrupt?: SentinelInterruptConfig;
}
```

3つのモード:

| モード | 判定基準 | ユースケース |
|--------|---------|-------------|
| `worker_event` | `lastWorkerOutputTs` のみ | stdout/stderr を出すワーカー（デフォルト） |
| `any_event` | `max(lastWorkerOutputTs, lastStepPhaseTs, lastStepStateTs)` | BATCH/CUSTOM で step_phase は出るがworker_event が出ないケース |
| `probe_only` | NoOutputWatcher を作成しない | probe ベース検知のみに依存したいケース |

**`src/workflow/parser.ts`**

`validateStallPolicy()` と `validateSentinel()` の defaults ブロックに
`activity_source` のバリデーションを追加:

```typescript
const VALID_ACTIVITY_SOURCES = new Set(["worker_event", "any_event", "probe_only"]);
if (obj["activity_source"] !== undefined) {
  if (typeof obj["activity_source"] !== "string" || !VALID_ACTIVITY_SOURCES.has(obj["activity_source"])) {
    throw new WorkflowParseError(
      `${path}.activity_source must be one of: ${[...VALID_ACTIVITY_SOURCES].join(", ")} (got "${String(obj["activity_source"])}")`,
    );
  }
}
```

**`src/workflow/sentinel/stall-watcher.ts`**

`StallWatcherOptions` に `activitySource` を追加。
`NoOutputWatcher.check()` で参照タイムスタンプを切り替え:

```typescript
let referenceTs: number;
const source = this.options.activitySource ?? "worker_event";
switch (source) {
  case "any_event":
    referenceTs = Math.max(
      activity.lastWorkerOutputTs,
      activity.lastStepPhaseTs,
      activity.lastStepStateTs,
    );
    break;
  case "worker_event":
  default:
    referenceTs = activity.lastWorkerOutputTs;
    break;
}
```

`any_event` モードでは `noInitialEvent` を常に `false` とする
（step_phase/step_state は register 時に初期化されるため）。

**`src/workflow/sentinel/sentinel-controller.ts`**

`startGuard()` で effective `activity_source` を解決:

```typescript
const effectiveActivitySource =
  policy.activity_source ?? this.config.defaults?.activity_source ?? "worker_event";
```

`probe_only` のとき `NoOutputWatcher` の作成をスキップ:

```typescript
if (effectiveNoOutputTimeout && effectiveActivitySource !== "probe_only") {
  // ... create NoOutputWatcher ...
}
```

**`src/workflow/executor.ts`**

`resolveStallPolicy()` で `activity_source` を workflow defaults からマージ:

```typescript
const effectiveActivitySource =
  policy.activity_source ?? this.definition.sentinel?.defaults?.activity_source;
if (!policy.activity_source && effectiveActivitySource) {
  merged.activity_source = effectiveActivitySource;
}
```

**テスト追加:**

- `tests/unit/sentinel-parser.test.ts` — 4件: valid values、invalid value、defaults level、invalid defaults
- `tests/at/workflow-sentinel.test.ts` — 1件: `probe_only` がタイマーベース watcher を無効化

### 設計判断

- **DSL 拡張**: 前回の「識別可能にする」から一歩進み、ワーカー特性に応じた制御を宣言的に行えるようにした
- **デフォルト `worker_event`**: 後方互換を維持。既存ワークフローの挙動は変わらない
- **`probe_only`**: `no_output_timeout` が設定されていても NoOutputWatcher を作らない。
  probe のみに依存する明示的な宣言
- **workflow defaults での指定可能**: 全 step に共通の `activity_source` を一箇所で設定できる

## 課題2: `capture_stderr` — probe stderr の安全性改善

### 問題

前回の対応で probe の stderr を bounded（4KB）で捕捉するようにしたが、
`probe.jsonl` への記録は常に行われる。probe stderr に secret が混入した場合、
artifact として永続化されるリスクがある。

### 変更内容

**`src/workflow/types.ts`**

`StallProbeConfig` に `capture_stderr` フィールドを追加:

```typescript
export interface StallProbeConfig {
  // ...
  /** Whether to capture probe stderr in probe.jsonl. Default: false (opt-in). */
  capture_stderr?: boolean;
  // ...
}
```

**`src/workflow/parser.ts`**

probe バリデーションブロック内に追加:

```typescript
validateOptionalBoolean(probe["capture_stderr"], `${path}.probe.capture_stderr`);
```

**`src/workflow/sentinel/stall-watcher.ts`**

`NoProgressWatcher` に `captureStderr` フィールドを追加:

```typescript
private captureStderr: boolean;

// constructor:
this.captureStderr = probe.capture_stderr ?? false;
```

`appendProbeLog()` の stderr 記録条件を変更:

```typescript
// Before:
if (result.stderr) entry.stderr = result.stderr;

// After:
if (result.stderr && this.captureStderr) entry.stderr = result.stderr;
```

**重要**: `ProbeRunner` 自体は常に stderr を読む（`Promise.all` による並行読み取りは
デッドロック防止に必須）。フィルタリングは `probe.jsonl` への書き込み時のみ。

**テスト追加:**

- `tests/unit/sentinel-parser.test.ts` — 3件: `true` / `false` が parse 成功、非 boolean でエラー

### 設計判断

- **デフォルト `false`（opt-in）**: 安全側をデフォルトに。既存ワークフローは
  今後 stderr が probe.jsonl に記録されなくなる（安全な方向の挙動変更）
- **boolean で十分**: `"capture" | "omit"` の文字列 enum も検討したが、
  2状態しかなく他の DSL フィールド（`enabled`, `include_worker_output`, `as_incomplete`）
  と同様に boolean が適切
- **ProbeRunner は変更なし**: stderr の読み取り自体は内部で継続（deadlock 防止 +
  JSON パース失敗時のエラーメッセージ生成に必要）

## 課題3: `require_zero_exit` — probe success 判定の明文化

### 問題

現状の `ProbeRunner` は JSON パース成功 = `success: true` としており、exit code は
記録するが success 判定に影響しない。これにより:

- 非ゼロ exit + 有効 JSON → `success: true`（矛盾しうる）
- exit code を使いたいユーザーに制御手段がない

### 変更内容

**`src/workflow/types.ts`**

`StallProbeConfig` に `require_zero_exit` フィールドを追加:

```typescript
export interface StallProbeConfig {
  // ...
  /** When true, probe success requires exit_code === 0 AND valid JSON.
   *  Default: false (JSON-only, exit code is recorded but does not affect success).
   */
  require_zero_exit?: boolean;
  // ...
}
```

**`src/workflow/parser.ts`**

probe バリデーションブロック内に追加:

```typescript
validateOptionalBoolean(probe["require_zero_exit"], `${path}.probe.require_zero_exit`);
```

**`src/workflow/sentinel/probe-runner.ts`**

コンストラクタに `requireZeroExit` パラメータを追加:

```typescript
private requireZeroExit: boolean;

constructor(command: string, timeoutMs: number, cwd?: string, requireZeroExit: boolean = false) {
  // ...
  this.requireZeroExit = requireZeroExit;
}
```

`run()` で JSON パース成功後、exit code チェックを追加:

```typescript
if (this.requireZeroExit && exitCode !== 0) {
  return {
    success: false,
    output,  // parsed output は diagnostic 用に保持
    digest,
    error: `probe exited with non-zero code ${exitCode} (require_zero_exit is enabled)`,
    exitCode,
    stderr: stderrText || undefined,
    ts,
  };
}
```

**`src/workflow/sentinel/stall-watcher.ts`**

`NoProgressWatcher` コンストラクタで `ProbeRunner` に `require_zero_exit` を渡す:

```typescript
this.probeRunner = new ProbeRunner(
  probe.command,
  probeTimeoutMs,
  cwd,
  probe.require_zero_exit ?? false,
);
```

**テスト追加:**

- `tests/unit/sentinel-parser.test.ts` — 2件: valid boolean、非 boolean でエラー
- `tests/unit/sentinel-probe-runner.test.ts` — 4件:
  - `require_zero_exit=true` + exit 0 → success
  - `require_zero_exit=true` + exit 1 → failure（error に `require_zero_exit` を含む）
  - `require_zero_exit=true` + exit 1 → parsed output が保持される
  - `require_zero_exit=false` + exit 1 → success（後方互換）

### success 判定マトリクス

| JSON パース | Exit Code | `require_zero_exit` | `success` |
|:----------:|:---------:|:-------------------:|:---------:|
| OK | 0 | false | true |
| OK | 0 | true | true |
| OK | 非ゼロ | false | **true**（後方互換） |
| OK | 非ゼロ | true | **false**（新挙動） |
| 失敗 | 任意 | 任意 | false |

### 設計判断

- **デフォルト `false`（後方互換）**: JSON パース成功 = success が既存の probe 契約。
  一部のツール（`jq`, `kubectl` 等）は有効な JSON を出力しつつ非ゼロで終了することがある
- **非ゼロ exit 時も parsed output を保持**: `result.output` に fingerprints/reasons/summary
  が含まれていれば、failure 時の診断に有用。`success: false` でも output は参照可能
- **`success_criteria` enum ではなく boolean**: JSON パースは probe 契約の根幹（digest 計算に必須）
  であり、唯一のオプション軸は exit code の扱い。3値 enum は過剰

## 検証結果

すべてのテストスイートが pass:

```
make typecheck           → pass
make test-unit           → 986 pass, 0 fail
make test-at             → 148 pass, 0 fail
```

## 変更ファイル一覧

| ファイル | 課題 | 変更種別 |
|---------|------|---------|
| `src/workflow/types.ts` | #1, #2, #3 | `StallPolicy` に `activity_source`、`StallProbeConfig` に `capture_stderr`/`require_zero_exit`、`SentinelDefaultsConfig` に `activity_source` |
| `src/workflow/parser.ts` | #1, #2, #3 | `validateStallPolicy()` に `activity_source` バリデーション、probe ブロックに `capture_stderr`/`require_zero_exit` バリデーション、`validateSentinel()` defaults に `activity_source` バリデーション |
| `src/workflow/sentinel/probe-runner.ts` | #3 | コンストラクタに `requireZeroExit`、`run()` に exit code チェック |
| `src/workflow/sentinel/stall-watcher.ts` | #1, #2, #3 | `activitySource` による参照タイムスタンプ切替、`captureStderr` による stderr フィルタ、`require_zero_exit` を ProbeRunner に伝播 |
| `src/workflow/sentinel/sentinel-controller.ts` | #1 | `activity_source` の解決、`probe_only` 時の NoOutputWatcher スキップ |
| `src/workflow/executor.ts` | #1 | `resolveStallPolicy()` で `activity_source` のデフォルトマージ |
| `tests/unit/sentinel-parser.test.ts` | #1, #2, #3 | テスト9件追加 |
| `tests/unit/sentinel-probe-runner.test.ts` | #3 | テスト4件追加 |
| `tests/at/workflow-sentinel.test.ts` | #1 | テスト1件追加 |
| `docs/features/sentinel.md` | all | DSL 例に `activity_source`/`capture_stderr`/`require_zero_exit` を追記 |
| `docs/features/sentinel-review.md` | all | 中長期 TODO を完了に更新、運用推奨設定を改訂 |

## レビュー文書の TODO 更新

`sentinel-review.md` の中長期 TODO セクションとの対応:

- [x] worker_event が出ないモードの `no_output_timeout` を根本的に扱える設計を追加する
  → `activity_source` フィールド（`"worker_event"` | `"any_event"` | `"probe_only"`）
- [x] probe の stderr 保存をより安全にする（opt-in 化/マスク/キー allowlist 等の設計）
  → `capture_stderr: boolean`（デフォルト: `false`）
- [x] probe の success 判定ルールを明文化する（exit code と JSON の関係）
  → `require_zero_exit: boolean`（デフォルト: `false`）

残る低優先度の注意点（第3弾で一部解消）:

- `TelemetrySink.emit()` は fire-and-forget（in-flight write の drain を含む flush が必要な場合は追加設計）
- `defaults.interrupt` はバリデーションされるが実行時には未使用
- ~~duration の妥当性は parse 時に検証されない（既存の他 duration と同様）~~ → 第3弾で解消

## DSL 例（全オプション込み）

```yaml
sentinel:
  enabled: true
  telemetry:
    events_file: "_workflow/events.jsonl"
    state_file: "_workflow/state.json"
    include_worker_output: false
  defaults:
    no_output_timeout: "15m"
    activity_source: "worker_event"  # NEW
    interrupt:
      strategy: cancel

steps:
  provision:
    worker: CUSTOM
    instructions: "bash scripts/provision.sh"
    capabilities: [READ, RUN_COMMANDS]
    timeout: "75m"

    stall:
      enabled: true
      no_output_timeout: "20m"
      activity_source: "any_event"    # NEW: CUSTOM ワーカー向け
      probe:
        interval: "10s"
        timeout: "5s"
        command: bash scripts/sentinel-probe.sh
        stall_threshold: 12
        capture_stderr: true          # NEW: 診断用に stderr を記録
        require_zero_exit: true       # NEW: exit code も判定に含める
      on_stall:
        action: interrupt
        error_class: RETRYABLE_TRANSIENT
      on_terminal:
        action: fail
        error_class: NON_RETRYABLE
```

---

# Sentinel レビュー残課題（第3弾）— 包括的レビューからの品質改善

Date: 2026-02-26

## 概要

`docs/features/sentinel-review.md` に基づく包括的コードレビューを5エージェント並列で実施し、
特定された品質課題に対して修正を行った。

第1弾・第2弾が「機能的な残課題」の実装だったのに対し、第3弾は「コード品質・テストカバレッジ・
ドキュメント整合性」に焦点を当てた構造的改善。

## 実施体制

### Phase 1: レビュー（5エージェント並列）

```
sentinel-review (Team)
├── team-lead              — 統合分析・クロスバリデーション・修正実装
├── sentinel-core-reviewer — sentinel/ 配下5ファイルのコードレビュー
├── integration-reviewer   — executor.ts/parser.ts/types.ts の統合レビュー
├── test-reviewer          — テストカバレッジ・品質レビュー
├── test-runner            — typecheck + unit + AT テスト実行
└── doc-reviewer           — ドキュメント整合性・コミット準備度確認
```

### Phase 2: 修正（リーダー直接 + 2エージェント並列）

```
├── team-lead               — 小修正（parser, executor, activity-tracker, sentinel.md）
├── controller-test-writer  — SentinelController ユニットテスト作成
└── watcher-test-writer     — Stall Watchers ユニットテスト作成
```

## レビュー統合分析

5エージェントの報告をクロスバリデーションした結果:

### 指摘された「バグ」4件の検証結果

| # | 指摘内容 | 実コード検証 | 実際の深刻度 |
|---|---------|------------|------------|
| 1 | ActivityTracker 並行ガード競合 | Executor は step→check を逐次実行。`finally` で `stop()` → `unregister()` 完了後に次の guard 開始。現行フローでは発生しない | WARNING（構造的脆弱性） |
| 2 | `step_state` の `Date.now()` 不整合 | `step_state` イベントは `ts`/`at` フィールドを持たない（ExecEvent 定義で確認）。`Date.now()` は唯一の選択肢であり正しい | NOTE（コメント追加で対応） |
| 3 | ProbeRunner UTF-8 境界 | `.slice(0, MAX_PROBE_OUTPUT_BYTES)` は文字数操作。バイト数で bounded 済みの文字列に対する no-op。`TextDecoder` は不完全マルチバイトを replacement character に変換するため crash しない | NOTE（低確率エッジケース） |
| 4 | Guard キー衝突（stepId にコロン） | stepId は YAML キーであり通常コロン不含 | NOTE（容易に修正可能だが現時点で不要） |

### テストカバレッジの最大ギャップ

test-reviewer が特定した最大の問題: **SentinelController と Stall Watchers にユニットテストが皆無**。
これらはコアロジックであり、ユニットテストなしでは guard ライフサイクル、タイマー動作、
probe スケジューリングの正しさが保証されない。

## 修正内容

### 修正1: Duration validation を parse 時に実施

**問題**: `no_output_timeout`, `probe.interval`, `probe.timeout` の duration 文字列は
文字列型チェックのみで、不正フォーマット（例: `"invalid"`）が実行時まで検出されなかった。

**変更**: `src/workflow/parser.ts`

`parseDuration()` を import し、4箇所でバリデーションを追加:

```typescript
// stall.no_output_timeout
if (typeof obj["no_output_timeout"] === "string") {
  try { parseDuration(obj["no_output_timeout"]); }
  catch { throw new WorkflowParseError(`${path}.no_output_timeout: invalid duration ...`); }
}

// probe.interval
try { parseDuration(probe["interval"] as string); }
catch { throw new WorkflowParseError(`${path}.probe.interval: invalid duration ...`); }

// probe.timeout
if (typeof probe["timeout"] === "string") {
  try { parseDuration(probe["timeout"]); }
  catch { throw new WorkflowParseError(`${path}.probe.timeout: invalid duration ...`); }
}

// sentinel.defaults.no_output_timeout
if (typeof defs["no_output_timeout"] === "string") {
  try { parseDuration(defs["no_output_timeout"]); }
  catch { throw new WorkflowParseError(`sentinel.defaults.no_output_timeout: invalid duration ...`); }
}
```

**設計判断**: 既存の他 duration（`timeout` 等）は parse 時に検証されないが、
sentinel の duration は probe スケジューリングに直結するため先行して実装。

### 修正2: Catch block の errorClass 解決を trigger ベースに統一

**問題**: executor.ts の3箇所の catch block で、sentinel abort 時の errorClass が
`on_stall` 固定で解決されていた。trigger が `on_terminal` 由来の場合に不正確。
（実害なし: post-catch コードで上書きされるため、最終結果は正しい）

**変更**: `src/workflow/executor.ts`（3箇所）

Before:
```typescript
const errorClass = this.resolveSentinelErrorClass(stepStallPolicy?.on_stall);
```

After:
```typescript
const trigger = sentinelGuard?.getLastTrigger();
const actionCfg = trigger?.kind === "terminal"
  ? stepStallPolicy?.on_terminal
  : stepStallPolicy?.on_stall;
const errorClass = this.resolveSentinelErrorClass(actionCfg);
```

適用箇所:
- Step 実行 catch（line ~720）
- Completion check catch（line ~903）
- Subworkflow check catch（line ~1375）

### 修正3: `step_state` の `Date.now()` 使用理由コメント追加

**変更**: `src/workflow/sentinel/activity-tracker.ts`

```typescript
case "step_state": {
  // step_state events don't carry a ts/at field (unlike worker_event
  // and step_phase), so Date.now() is the only available timestamp.
  const act = this.activities.get(event.stepId);
  if (act) act.lastStepStateTs = Date.now();
  break;
}
```

### 修正4: 設計ドキュメントのステータス更新

**変更**: `docs/features/sentinel.md`

- `Status: proposal` → `Status: implemented (v1)`
- Section 10 "Adoption Plan": Phase 1–4 を完了済みに更新
- Section 11 "Open Questions" → "Design Decisions (resolved)" に変換:
  - Q1–Q7: 実装で確定した設計判断を記録
  - Q8 (TUI): phase 2 として記録

### 修正5: SentinelController ユニットテスト新規作成

**ファイル**: `tests/unit/sentinel-controller.test.ts`（23テスト）

カバレッジ:
- コンストラクタ初期化
- `guardStep()` / `guardCheck()` — SentinelGuard 返却、phase 区別
- `guard.stop()` — watcher 停止、多重呼び出し安全
- `onEvent()` — ActivityTracker への伝播
- `stopAll()` — 全 guard 停止
- `getLastTrigger()` — 初期 null、stall 発火後にトリガー取得
- Guard キーの一意性（phase/iteration 別）
- `no_output_timeout` 設定時の NoOutputWatcher 生成
- `probe` 設定時の NoProgressWatcher 生成
- `activity_source=probe_only` による NoOutputWatcher スキップ
- Workflow defaults の適用（step overrides default）
- `SENTINEL_ABORT_REASON` タグ付き abort
- Warning イベントの emit 確認

### 修正6: Stall Watchers ユニットテスト新規作成

**ファイル**: `tests/unit/sentinel-stall-watcher.test.ts`（20テスト）

**NoOutputWatcher（9テスト）:**
- timeout 後の発火 / timeout 前の非発火
- `activity_source=worker_event` — `lastWorkerOutputTs` のみ使用
- `activity_source=any_event` — 全タイムスタンプの max 使用
- `abortStep` / `onTrigger` コールバック呼び出し
- `action=ignore` — event 記録するが abort しない
- `action=ignore` — ignoreFired フラグで1回のみ
- `stall/no-initial-output` fingerprint（worker_event 未受信時）
- `stop()` による以後のチェック抑止

**NoProgressWatcher（11テスト）:**
- digest 不変 × `stall_threshold` 回で発火
- `class=progressing` によるカウンタリセット
- `class=terminal` による即時発火（on_terminal）
- probe 失敗は progress/stall カウントしない
- `action=ignore` for no_progress — カウンタリセット、abort なし
- `action=ignore` for terminal — abort なし
- `stop()` による probe 停止
- `probe.jsonl` エントリ書き込み
- `capture_stderr=true` — stderr を probe.jsonl に記録
- `capture_stderr=false` — stderr を probe.jsonl から除外

## 検証結果

すべてのテストスイートが pass:

```
make typecheck           → pass（0 errors）
make test-unit           → 1,029 pass, 0 fail（+43 テスト: 986→1,029）
make test-at             →   148 pass, 0 fail
```

テスト増加の内訳:
- `sentinel-controller.test.ts`: +23 テスト（新規）
- `sentinel-stall-watcher.test.ts`: +20 テスト（新規）

## 変更ファイル一覧

| ファイル | 修正 | 変更種別 |
|---------|------|---------|
| `src/workflow/parser.ts` | #1 | `parseDuration` import、4箇所の duration バリデーション追加 |
| `src/workflow/executor.ts` | #2 | catch block 3箇所の errorClass 解決を trigger ベースに統一 |
| `src/workflow/sentinel/activity-tracker.ts` | #3 | `step_state` の `Date.now()` 使用理由コメント追加 |
| `docs/features/sentinel.md` | #4 | Status → implemented、Adoption Plan 更新、Open Questions → Design Decisions |
| `tests/unit/sentinel-controller.test.ts` | #5 | 新規作成（23テスト） |
| `tests/unit/sentinel-stall-watcher.test.ts` | #6 | 新規作成（20テスト） |

## レビュー文書の残課題更新

第1弾・第2弾の「残る低優先度の注意点」との対応:

- [x] duration の妥当性は parse 時に検証されない → parse 時バリデーション実装済み
- [ ] `TelemetrySink.emit()` は fire-and-forget（変更なし）
- [ ] `defaults.interrupt` はバリデーションされるが実行時には未使用（変更なし）

新たに確認された構造的注意点（中長期）:

- ActivityTracker の `register`/`unregister` は stepId 単位。現行の逐次実行では問題ないが、
  将来的に並行 step 実行を導入する場合はリファレンスカウントまたはキー付き登録が必要
- Guard キーフォーマット `${stepId}:${phase}:${iteration}` は stepId にコロンが含まれると
  衝突リスクあり。stepId の文字セット制約またはキーフォーマット変更で対応可能

---

# Sentinel レビュー残課題（第4弾）— action config 解決ロジックの統一

Date: 2026-02-26

## 概要

`docs/features/sentinel-review.md` および第3弾で修正された catch block の errorClass 解決を
さらに一歩進め、**action config 選択パターン全体を `resolveActionConfig()` ヘルパーに統一**した。

加えて、第3弾で見落とされていた **`as_incomplete` 解決のバグ**（completion_check / subworkflow
check の catch block で trigger kind を見ずに `on_stall` を常に優先する）を修正した。

## 実施体制

変更対象が `executor.ts` の1ファイルに集中しており、修正箇所が密結合（同一メソッド内の
catch/post-catch ペア）のため、**単一エージェントで実施**した。

チーム構成を検討した上での判断根拠:

| 観点 | 評価 |
|------|------|
| 変更対象ファイル数 | 1（`executor.ts`） |
| 変更箇所の結合度 | 高（同一メソッド内の catch/post-catch ペア） |
| 並列化余地 | 低（同一ファイルの密結合した変更） |
| 変更規模 | ヘルパー追加 + 6箇所の呼び出し置換 + 2箇所のバグ修正 |

複数エージェントの並列実行はオーバーヘッドが利点を上回ると判断。

## 発見した問題

### バグ: `as_incomplete` が trigger kind を無視（2箇所）

**影響**: completion_check / subworkflow check の catch block で、`on_terminal` に
`as_incomplete: true` を設定し `on_stall` には設定しなかった場合（またはその逆）に、
terminal trigger が発火しても `on_stall.as_incomplete` が優先されてしまう。

**箇所**:

1. Completion check catch（旧 line 893-896）
2. Subworkflow check catch（旧 line 1370-1372）

Before（バグあり）:
```typescript
const asIncomplete =
  checkStallPolicy?.on_stall?.as_incomplete ??
  checkStallPolicy?.on_terminal?.as_incomplete ??
  false;
```

After（修正済み）:
```typescript
const actionCfg = this.resolveActionConfig(checkStallPolicy, trigger);
const asIncomplete = actionCfg?.as_incomplete === true;
```

同じファイルの post-catch ブロック（旧 line 936-939, 1407-1410）は第3弾で既に正しく
trigger kind を参照していたため、catch block のみが残存バグだった。

### コード品質: action config 選択パターンの散在

`trigger?.kind === "terminal" ? policy.on_terminal : policy.on_stall` パターンが
executor.ts 内に **6箇所** inline で記述されていた（第3弾の修正後）。

## 変更内容

### 変更1: `resolveActionConfig()` ヘルパーメソッド追加

`resolveSentinelErrorClass()` の直前に追加:

```typescript
/** Select the action config (on_stall or on_terminal) based on trigger kind. */
private resolveActionConfig(
  stallPolicy: StallPolicy | null | undefined,
  trigger: { kind?: string } | null | undefined,
): StallPolicy["on_stall"] | StallPolicy["on_terminal"] | undefined {
  if (!stallPolicy) return undefined;
  return trigger?.kind === "terminal"
    ? stallPolicy.on_terminal
    : stallPolicy.on_stall;
}
```

設計判断:
- `StallPolicy | null | undefined` を受け付ける（`resolveStallPolicy()` が `null` を返すため）
- trigger も `null | undefined` を許容（guard 未生成時に `getLastTrigger()` が null を返す）
- 戻り値は既存の `resolveSentinelErrorClass()` の引数型と一致

### 変更2: 6箇所の inline パターンをヘルパー呼び出しに置換

| # | 箇所 | 種別 |
|---|------|------|
| 1 | Step execution catch | リファクタ（errorClass 解決） |
| 2 | Step execution post-catch | リファクタ（errorClass 解決） |
| 3 | Completion check catch | **バグ修正**（`as_incomplete` + errorClass 解決） |
| 4 | Completion check post-catch | リファクタ（actionCfg 解決） |
| 5 | Subworkflow check catch | **バグ修正**（`as_incomplete` + errorClass 解決） |
| 6 | Subworkflow check post-catch | リファクタ（actionCfg 解決） |

Before（各箇所の典型）:
```typescript
const trigger = sentinelGuard?.getLastTrigger();
const actionCfg = trigger?.kind === "terminal"
  ? stepStallPolicy?.on_terminal
  : stepStallPolicy?.on_stall;
const errorClass = this.resolveSentinelErrorClass(actionCfg);
```

After:
```typescript
const trigger = sentinelGuard?.getLastTrigger();
const actionCfg = this.resolveActionConfig(stepStallPolicy, trigger);
const errorClass = this.resolveSentinelErrorClass(actionCfg);
```

### 変更3: Completion check catch のバグ修正（詳細）

Before:
```typescript
if (this.isSentinelAbort(checkAbortController)) {
  const trigger = checkSentinelGuard?.getLastTrigger();
  const asIncomplete =
    checkStallPolicy?.on_stall?.as_incomplete ??       // ← 常に on_stall を優先
    checkStallPolicy?.on_terminal?.as_incomplete ??
    false;
  if (asIncomplete) {
    // ...
  } else {
    checkSentinelGuard?.stop();
    const checkTrigger = checkSentinelGuard?.getLastTrigger();
    const checkActionCfg = checkTrigger?.kind === "terminal"
      ? checkStallPolicy?.on_terminal
      : checkStallPolicy?.on_stall;
    const errorClass = this.resolveSentinelErrorClass(checkActionCfg);
```

After:
```typescript
if (this.isSentinelAbort(checkAbortController)) {
  const trigger = checkSentinelGuard?.getLastTrigger();
  const actionCfg = this.resolveActionConfig(checkStallPolicy, trigger);
  const asIncomplete = actionCfg?.as_incomplete === true;
  if (asIncomplete) {
    // ...
  } else {
    checkSentinelGuard?.stop();
    const errorClass = this.resolveSentinelErrorClass(actionCfg);
```

改善点:
- `as_incomplete` が trigger kind に基づいて正しく解決される
- `actionCfg` が一度だけ解決され、`as_incomplete` と `errorClass` の両方に使われる
- 冗長な `checkTrigger` 変数が不要に

### 変更4: Subworkflow check catch のバグ修正（詳細）

Completion check catch と同一パターン。変更内容は同等。

## 検証結果

すべてのテストスイートが pass:

```
make typecheck           → pass（0 errors）
make test-unit           → 1,029 pass, 0 fail
make test-at             →   148 pass, 0 fail
```

## 変更ファイル一覧

| ファイル | 変更種別 |
|---------|---------|
| `src/workflow/executor.ts` | `resolveActionConfig()` ヘルパー追加、6箇所の inline パターン置換（うち2箇所はバグ修正） |

## 第3弾からの差分

第3弾で修正された errorClass 解決（catch block 3箇所）は trigger ベースの inline コードだった。
第4弾では:

1. inline コードを `resolveActionConfig()` ヘルパーに抽出
2. 第3弾で見落とされた `as_incomplete` のバグを同時修正（catch block 2箇所）
3. post-catch block の inline コードも同じヘルパーに統一

結果として、action config 選択ロジックは `resolveActionConfig()` の1箇所に集約され、
executor.ts 内に trigger kind の条件分岐が散在しなくなった。

## レビュー文書の残課題更新

- [x] catch block の errorClass 解決を trigger ベースに統一（第3弾）
- [x] catch block の `as_incomplete` 解決を trigger ベースに統一（第4弾・バグ修正）
- [x] action config 選択パターンを `resolveActionConfig()` に集約（第4弾・リファクタ）

残る低優先度の注意点（変更なし）:

- `TelemetrySink.emit()` は fire-and-forget
- `defaults.interrupt` はバリデーションされるが実行時には未使用

---

# Sentinel レビュー残課題（第5弾）— 0042 対処性の強化

Date: 2026-02-26

## 概要

`docs/features/sentinel-review.md` の「0042 を確実に短縮するための TODO」5件すべてを対処した。
これらは運用・実装の両面で 0042（appthrust/platform Issue 0042）の待ち時間短縮に直結する課題群。

対象の残課題:

1. `sentinel.defaults` の適用範囲整理 — `stall:` が無い step/check を guard するか
2. probe 実行環境を step/check と揃える — `ProbeRunner` に workflow env を渡す
3. probe の連続失敗の扱いをポリシー化する — `on_probe_error` / `probe_error_threshold`
4. `as_incomplete` の適用範囲を明記する — docs で scope を明確化
5. `docs/features/sentinel.md` の例と実装差分を解消する — event.json/defaults/probe の不整合

## 実施体制

ファイル競合分析に基づき、実装タスク（1-3）は直列、ドキュメント（4-5）は並列エージェントで実施。

```
sentinel-remaining (Team)
├── lead          — タスク1-3の実装（直列）+ テスト実行 + 統合
└── doc-writer    — タスク4-5のドキュメント更新（実装完了後に起動）
```

チーム構成の判断根拠:

| 観点 | 評価 |
|------|------|
| タスク1-3のファイル重複 | 高（executor.ts, types.ts, parser.ts を共有） |
| ワークツリー利用可否 | 不可（全 Sentinel コードが未コミット） |
| タスク4-5の独立性 | 高（docs/features/sentinel.md のみ変更） |
| 最適戦略 | 実装は直列、ドキュメントは実装完了後に並列 |

## 課題1: `sentinel.defaults` の適用範囲整理

### 問題

`resolveStallPolicy(policy)` は `policy` が `undefined`（= step に `stall:` ブロックが無い）の場合
即座に `null` を返すため、`sentinel.defaults` に `no_output_timeout` を設定しても
`stall:` ブロックの無い step/check は一切 guard されない。

0042 では全 step を guard したいが、各 step に `stall: {}` を書く必要があった。

### 変更内容

**`src/workflow/executor.ts`** — `resolveStallPolicy()`

Before:
```typescript
private resolveStallPolicy(policy: StallPolicy | undefined): StallPolicy | null {
  if (!policy) return null;
  // ...
}
```

After:
```typescript
private resolveStallPolicy(policy: StallPolicy | undefined): StallPolicy | null {
  // If explicitly disabled, skip.
  if (policy?.enabled === false) return null;

  const defaults = this.definition.sentinel?.defaults;

  // No step-level policy: try to synthesize from workflow-level defaults.
  if (!policy) {
    if (!defaults) return null;
    const synthetic: StallPolicy = {};
    if (defaults.no_output_timeout) synthetic.no_output_timeout = defaults.no_output_timeout;
    if (defaults.activity_source) synthetic.activity_source = defaults.activity_source;
    // Only guard if there's at least one detection mechanism.
    if (!synthetic.no_output_timeout) return null;
    return synthetic;
  }

  // Step-level policy exists: merge with workflow defaults.
  // ... (existing merge logic, refactored to use `defaults` variable)
}
```

挙動変更:

| 条件 | Before | After |
|------|--------|-------|
| `stall:` なし + defaults なし | guard なし | guard なし |
| `stall:` なし + defaults に `no_output_timeout` あり | guard なし | **auto-guard** |
| `stall: { enabled: false }` | guard なし | guard なし |
| `stall: {}` + defaults あり | defaults をマージ | defaults をマージ |

opt-out は `stall: { enabled: false }` で可能。

### 設計判断

- **auto-guard**: `sentinel.enabled=true` + defaults に検知機構がある場合、全 step を自動 guard
- **opt-out 方式**: `stall: { enabled: false }` で明示的に除外。暗黙の除外は行わない
- **probe は auto-guard しない**: defaults には `probe` 設定を持たないため、
  auto-guard は `no_output_timeout` のみ。probe は step-level で明示が必要

## 課題2: probe 実行環境を step/check と揃える

### 問題

`ProbeRunner` は `env: { ...process.env }` 固定で probe を実行するが、
workflow に渡される `env`（kubeconfig パス、認証トークン等）を引き継がない。
0042 では probe が `kubectl` を実行するが、認証情報が env 経由の場合に probe だけ失敗する。

### 変更内容

env を以下のチェーンで伝播:

```
WorkflowExecutor (this.env)
  → SentinelController.guardStep/guardCheck(env)
    → startGuard(env)
      → NoProgressWatcher(options, cwd, env)
        → ProbeRunner(command, timeout, cwd, requireZeroExit, env)
```

**`src/workflow/sentinel/probe-runner.ts`**

コンストラクタに `env` パラメータを追加:
```typescript
constructor(command: string, timeoutMs: number, cwd?: string,
            requireZeroExit: boolean = false, env?: Record<string, string>) {
  // ...
  this.env = env;
}
```

`Bun.spawn` の env を変更:
```typescript
// Before:
env: { ...process.env },

// After:
env: { ...process.env, ...(this.env ?? {}) },
```

**`src/workflow/sentinel/stall-watcher.ts`**

`NoProgressWatcher` コンストラクタに `env` パラメータ追加:
```typescript
constructor(options: StallWatcherOptions, cwd?: string, env?: Record<string, string>)
```

**`src/workflow/sentinel/sentinel-controller.ts`**

`guardStep()`, `guardCheck()`, `startGuard()` に `env` パラメータ追加。
`NoProgressWatcher` 生成時に env を渡す。

**`src/workflow/executor.ts`**

3箇所の `guardStep`/`guardCheck` 呼び出しに `this.env` を追加。

**テスト追加:**

`tests/unit/sentinel-probe-runner.test.ts` — 2件:
- `probe inherits custom env` — env 変数が probe 内で参照可能
- `probe env merges with process.env` — process.env（PATH等）と共存

### 設計判断

- **workflow env の丸ごと伝播**: DSL に `probe.env` を追加する案もあったが、
  大半のケースでは workflow env の継承で十分。DSL 追加は将来の拡張として保留
- **マージ順序**: `{ ...process.env, ...workflowEnv }` — workflow env が process.env を上書き。
  ユーザー指定の env が優先される自然な挙動

## 課題3: probe の連続失敗の扱いをポリシー化する

### 問題

probe が連続失敗（非JSON/timeout/non-zero exit 等）した場合、現状は黙って無視される
（`stall-watcher.ts:268-271` の `return;`）。probe 自体が壊れていると Sentinel が沈黙し、
0042 の待ち短縮が一切効かない。

### 変更内容

**`src/workflow/types.ts`**

`StallProbeConfig` に2フィールド追加:
```typescript
export interface StallProbeConfig {
  // ... existing fields ...
  on_probe_error?: "ignore" | "stall" | "terminal";
  probe_error_threshold?: number;
}
```

**`src/workflow/parser.ts`**

probe バリデーション内に追加:
```typescript
const VALID_PROBE_ERROR_ACTIONS = new Set(["ignore", "stall", "terminal"]);
if (probe["on_probe_error"] !== undefined) {
  if (!VALID_PROBE_ERROR_ACTIONS.has(probe["on_probe_error"])) {
    throw new WorkflowParseError(`...`);
  }
}
validateOptionalNumber(probe["probe_error_threshold"], `...`, { min: 1 });
```

**`src/workflow/sentinel/stall-watcher.ts`**

`NoProgressWatcher` に連続エラー追跡を追加:

```typescript
private consecutiveProbeErrors = 0;
private onProbeError: "ignore" | "stall" | "terminal";
private probeErrorThreshold: number;
```

probe 失敗時のハンドリング:

```typescript
// Before:
if (!result.success) {
  return;  // 黙って無視
}

// After:
if (!result.success) {
  this.consecutiveProbeErrors++;
  if (this.onProbeError !== "ignore" &&
      this.consecutiveProbeErrors >= this.probeErrorThreshold) {
    await this.triggerProbeError(result);
  }
  return;
}
// Probe succeeded — reset error counter.
this.consecutiveProbeErrors = 0;
```

`triggerProbeError()` メソッド:
- `on_probe_error=stall` → `kind: "no_progress"` で `on_stall` アクションを発火
- `on_probe_error=terminal` → `kind: "terminal"` で `on_terminal` アクションを発火
- fingerprint: `stall/probe-error`
- `action=ignore` の場合はカウンタリセットして監視継続

**テスト追加:**

`tests/unit/sentinel-parser.test.ts` — 4件:
- valid `on_probe_error` values（ignore/stall/terminal）
- invalid `on_probe_error` でエラー
- valid `probe_error_threshold` パース
- invalid `probe_error_threshold` (< 1) でエラー

### 設計判断

- **デフォルト `ignore`**: 後方互換。既存ワークフローの挙動は変わらない
- **デフォルト threshold 3**: probe が一時的に失敗することは正常（ネットワーク瞬断等）。
  3回連続で安定した異常検知
- **`stall` vs `terminal` の選択**: ユーザーが probe 失敗の深刻度を判断し、
  `on_stall`（retry 可能）か `on_terminal`（即時停止）のどちらのアクションを使うか選べる
- **カウンタリセット**: probe 成功時と `action=ignore` トリガー時にリセット

## 課題4-5: ドキュメント整合（doc-writer エージェント）

### 変更内容

**`docs/features/sentinel.md`**

1. **Section 4.1 (sentinel.defaults)**:
   - コメント更新: defaults の auto-guard 挙動を明記
   - Notes に auto-guard の説明を追加（opt-out 方法含む）

2. **Section 4.2 (stall policy)**:
   - probe 例に `on_probe_error` / `probe_error_threshold` を追加
   - `as_incomplete` の scope 明確化:
     > `as_incomplete` currently applies only to `completion_check` stall policies.
     > For step body interruptions, use `on_failure: continue`.

3. **Section 5.1 (event.json)**:
   - `"phase": "running"` → `"phase": "executing"`（実装と一致）
   - `"signals": ["SIGTERM"]` を削除（未実装）
   - trigger kind から `terminal_pattern` を削除（未実装）

4. **Section 6.5 (Probe runner)**:
   - env 継承の説明を追加

5. **Section 10 (Adoption Plan)**:
   - Phase 4a (auto-guard)、4b (probe env)、4c (probe error policy) を追加

## 検証結果

すべてのテストスイートが pass:

```
make typecheck           → pass（0 errors）
make test-unit           → 1,035 pass, 0 fail（+6 テスト: 1,029→1,035）
make test-at             →   148 pass, 0 fail
```

テスト増加の内訳:
- `sentinel-probe-runner.test.ts`: +2 テスト（env passthrough）
- `sentinel-parser.test.ts`: +4 テスト（on_probe_error / probe_error_threshold）

## 変更ファイル一覧

| ファイル | 課題 | 変更種別 |
|---------|------|---------|
| `src/workflow/executor.ts` | #1, #2 | `resolveStallPolicy()` に auto-guard 合成追加、`guardStep`/`guardCheck` に env 引数追加（3箇所） |
| `src/workflow/types.ts` | #3 | `StallProbeConfig` に `on_probe_error`/`probe_error_threshold` 追加 |
| `src/workflow/parser.ts` | #3 | `on_probe_error` enum バリデーション、`probe_error_threshold` number バリデーション |
| `src/workflow/sentinel/probe-runner.ts` | #2 | コンストラクタに `env` パラメータ、`Bun.spawn` で env マージ |
| `src/workflow/sentinel/stall-watcher.ts` | #2, #3 | `NoProgressWatcher` に env/probe error tracking 追加、`triggerProbeError()` メソッド |
| `src/workflow/sentinel/sentinel-controller.ts` | #2 | `guardStep`/`guardCheck`/`startGuard` に env パラメータ追加 |
| `docs/features/sentinel.md` | #4, #5 | event.json 修正、defaults/probe/as_incomplete ドキュメント整合 |
| `docs/features/sentinel-review.md` | all | 0042 TODO 5件を完了に更新 |
| `tests/unit/sentinel-probe-runner.test.ts` | #2 | env passthrough テスト2件追加 |
| `tests/unit/sentinel-parser.test.ts` | #3 | probe error policy テスト4件追加 |

## レビュー文書の残課題更新

`sentinel-review.md` の「0042 を確実に短縮するための TODO」との対応:

- [x] workflow-level `sentinel.defaults` の適用範囲を整理する
  → auto-guard 実装。`stall:` なしでも defaults から合成。opt-out は `stall: { enabled: false }`
- [x] probe 実行環境を step/check と揃える
  → workflow env を ProbeRunner まで伝播。`{ ...process.env, ...workflowEnv }`
- [x] probe の連続失敗の扱いをポリシー化する
  → `on_probe_error` / `probe_error_threshold` で stall/terminal/ignore を選択可能
- [x] `as_incomplete` の適用範囲を明記する
  → completion_check のみ。step 本体は `on_failure: continue` で吸収を推奨
- [x] `docs/features/sentinel.md` の例と実装差分を解消する
  → phase/signals/terminal_pattern 修正、defaults auto-guard/probe env/error policy 記載

残る低優先度の注意点（変更なし）:

- `TelemetrySink.emit()` は fire-and-forget
- `defaults.interrupt` はバリデーションされるが実行時には未使用

---

# Sentinel レビュー残課題（第5弾追補）— レビューフィードバック対応

Date: 2026-02-26

## 概要

第5弾の実装に対するレビューで指摘された3点を修正した。
いずれも実運用で刺さりやすいエッジケースの堅牢化とドキュメント整合性。

## 修正1: ProbeRunner のハング防止

### 問題

`readBoundedChunks` が上限バイト数に達すると読み取りを停止するが、
プロセスは依然として書き込みを続ける。パイプバッファが満杯になると
プロセスが書き込み側でブロックし、`await proc.exited` が永遠に返らない。

さらに `clearTimeout(timeoutId)` が `await proc.exited` より前に呼ばれるため、
パイプ詰まりの場合に hard timeout が効かずプロセスが残り続ける。

stderr 側も同様で、4KB を超える stderr を出し続ける probe でハングし得る。

### 変更内容

**`src/workflow/sentinel/probe-runner.ts`**

1. `readBoundedChunks` / `readBoundedString` を `readBoundedDrain` / `readBoundedStringDrain` に置換:

```typescript
private async readBoundedDrain(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  proc: { kill(): void },
): Promise<{ chunks: Uint8Array[]; totalBytes: number }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    // Phase 1: collect up to maxBytes.
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) return { chunks, totalBytes };
      chunks.push(value);
      totalBytes += value.byteLength;
    }
    // Phase 2: limit reached — kill the process and drain to EOF so the
    // pipe doesn't block the process exit.
    proc.kill();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  return { chunks, totalBytes };
}
```

2. `clearTimeout(timeoutId)` を `await proc.exited` の**後**に移動:

```typescript
// Before:
clearTimeout(timeoutId);
const exitCode = await proc.exited;

// After:
const exitCode = await proc.exited;
clearTimeout(timeoutId);
```

### 設計判断

- **drain 方式**: 上限到達後もストリームを EOF まで読み捨てる。プロセスの書き込みがブロックしない
- **kill + drain**: 上限到達 → `proc.kill()` → 残データを drain。kill だけでは
  カーネルバッファに残ったデータでパイプが詰まる可能性があるため drain が必要
- **timeout は exit 後に clear**: パイプ詰まりが起きた場合でも hard timeout が
  プロセスを強制 kill できる。正常終了時は exit 直後に clear するため無駄な kill はない

## 修正2: `probe_only` + probe 無しの空ガード防止

### 問題

`sentinel.defaults` で `activity_source: probe_only` を設定し、step に `probe` が無い場合:
- auto-guard で合成されたポリシーは `activity_source: probe_only` を持つ
- `probe_only` のため `NoOutputWatcher` は作られない
- `probe` が無いため `NoProgressWatcher` も作られない
- 結果: 監視ゼロの guard が作成される（CPU は消費しないが混乱の元）

### 変更内容

**`src/workflow/executor.ts`** — `resolveStallPolicy()`

auto-guard 合成時:
```typescript
// probe_only without a probe means no watcher would be created — skip.
if (synthetic.activity_source === "probe_only") return null;
```

step-level ポリシーのマージ時:
```typescript
// probe_only without a probe is a no-op guard — skip.
const prelimActivitySource = policy.activity_source ?? defaults?.activity_source;
if (prelimActivitySource === "probe_only" && !policy.probe) return null;
```

### 設計判断

- **resolver で弾く**: watcher 生成時ではなくポリシー解決時に弾く。
  `SentinelController.startGuard()` が空の watcher リストで呼ばれるのを防ぐ
- **`probe_only` + probe ありは正当**: probe があれば NoProgressWatcher が作られるため問題ない

## 修正3: sentinel-review.md のズレ解消

### 問題

`sentinel-review.md` の「設計/実装のズレとして注意が必要な点」セクションが
第5弾の実装で解消された課題を反映していなかった。

### 変更内容

**`docs/features/sentinel-review.md`**

3点を取り消し線 + 解消済み注記に更新:
- `sentinel.defaults` の適用範囲 → auto-guard で解消
- probe 連続失敗の無視 → `on_probe_error` で解消
- ProbeRunner の env 固定 → workflow env 伝播で解消

`as_incomplete` の scope は現状維持の仕様のため取り消さず、ドキュメント明記済みの注記を追加。

## 検証結果

```
make typecheck           → pass（0 errors）
make test-unit           → 1,035 pass, 0 fail
make test-at             →   148 pass, 0 fail
```

## 変更ファイル一覧

| ファイル | 修正 | 変更種別 |
|---------|------|---------|
| `src/workflow/sentinel/probe-runner.ts` | #1 | `readBoundedDrain` に置換（kill + drain）、`clearTimeout` を exit 後に移動 |
| `src/workflow/executor.ts` | #2 | `resolveStallPolicy()` で `probe_only` + probe 無しを弾く（2箇所） |
| `docs/features/sentinel-review.md` | #3 | 解消済み課題を取り消し線 + 注記で更新 |
