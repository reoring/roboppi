# Supervised TUI: Logs タブが空 (リアルタイム監視不可) / IPC ストリーミング拡張案

ステータス: 実装済み

## 問題

`roboppi workflow ... --supervised --tui`（supervised: Supervisor -> Core IPC -> Worker）で実行すると、TUI の `2: Logs` に stdout/stderr/progress が表示されない。

期待する挙動:

- TUI の `2: Logs` で、エージェント/ワーカーが実行中に出力する stdout/stderr/progress をリアルタイムに追跡できる
- `3: Diffs` で、実行中に生成された patch/diff を（可能なら）リアルタイムに見える

現状の挙動:

- supervised では `2: Logs` がほぼ常に空のまま（"No logs yet"）
- TUI は `phase` と最終 `Result`（`job_completed` の `result`）だけが主な情報源になる

対象ファイル（TUI 表示側）:

- `src/tui/components/tabs/logs-tab.ts`
- `src/tui/state-store.ts`
- `src/tui/exec-event.ts`

## 根本原因（要点）

1) supervised 経路で `ExecEvent: worker_event` が発生しない

- `TuiStateStore` は `ExecEvent` の `worker_event` を受け取って `step.logs.stdout/stderr/progress` を更新する（`src/tui/state-store.ts`）。
- しかし supervised の StepRunner である `CoreIpcStepRunner` は、Core から最終結果（`job_completed`）しか受け取れず、実行中の stdout/stderr/progress をイベントとして受け取る経路がない。

2) IPC プロトコルに「ジョブのストリームイベント」が存在しない

- `src/types/ipc-messages.ts` の OutboundMessage（Core -> Supervisor）には `job_completed` はあるが、stdout/stderr/progress/patch のストリーミング通知がない。

3) Core 側も WorkerAdapter の `streamEvents()` を消費していない

- Core は `src/worker/worker-gateway.ts` を通じて `adapter.awaitResult()` を待つだけで、`adapter.streamEvents()` を回していない。
- そのため、たとえ adapter がストリーミング可能でも、supervised では利用されない。

補足:

- `OutputMode` に `STREAM` は存在する（`src/types/worker-task.ts`）が、supervised 経路の job payload は現状 `BATCH` 固定で使われている（`src/workflow/core-ipc-step-runner.ts`）。

## 目標

- supervised のまま（`--direct` なし）TUI の `2: Logs` をリアルタイムに更新する
- `stdout/stderr/progress/patch` のイベントを、Core -> Supervisor IPC で安全に転送する
- stdout はあくまで JSONL IPC 専用（非 JSON を混ぜない）という原則を維持する
- 後方互換を維持する（新 Core/旧 Runner、新 Runner/旧 Core で破綻しない）

## 非目標

- stdout/stderr の内容を完全に秘匿/自動マスキングする（一般に不可能）
- 全てのログを無制限に転送する（IPC/メモリ/表示が破綻する）
- TUI の UI 仕様の全面改修（まずは既存 Logs/Diffs 表示を埋める）

## 提案: Core -> Supervisor へジョブイベントを非同期ストリーミング

### 追加する IPC メッセージ（Core -> Supervisor）

新規 OutboundMessage（例: `job_event`）を追加する。

重要:

- `requestId` を含めない（`IpcProtocol` の request/response 相関は `requestId` ベースのため、非同期イベントは相関対象外にする）

案（型イメージ）:

```ts
// src/types/ipc-messages.ts
import type { WorkerEvent } from "../worker/worker-adapter.js";

export interface JobEventMessage {
  type: "job_event";
  jobId: UUID;
  ts: number;
  seq: number;
  event: WorkerEvent;
}
```

設計メモ:

- `seq` は jobId 単位の単調増加。IPC の write 順が崩れた場合でも並びを復元しやすい。
- `WorkerEvent` は既存の `src/worker/worker-adapter.ts` と同一の shape を転送する。

### データフロー（概要）

- Supervisor（Runner）
  - `submit_job` / `request_permit` / `cancel_job` を送る（既存）
  - `job_event`（新規）を受けて step にルーティングし、TUI sink に流す
  - `job_completed`（既存）を受けて最終結果を確定

- Core
  - job を受けて Worker を delegate する（既存）
  - worker 実行中に `adapter.streamEvents()` を消費し、都度 `job_event` を送る（新規）
  - 実行完了時に `job_completed` を送る（既存）

## 実装設計（コンポーネント別）

### A) IPC レイヤ

- `src/types/ipc-messages.ts`
  - `JobEventMessage` を追加し `OutboundMessage` に含める
- `src/ipc/protocol.ts`
  - `sendJobEvent(jobId, ts, seq, event)` の薄い helper を追加（`transport.write`）
  - `validateMessage()` に `job_event` の必須フィールド検証を追加（安全性のため）

互換性:

- 旧 Runner は未知メッセージを無視する（handler 未登録）ため、新 Core が `job_event` を送っても破綻しない
- 旧 Core は `job_event` を送らないだけで、新 Runner は従来通り動く

### B) Core 側（ストリーミングの発生源）

現状 Core の実行経路（`src/core/agentcore.ts`）は `workerGateway.delegateTask(...)` による「最終結果待ち」のみで、イベントを生成していない。

提案:

1) `src/worker/worker-gateway.ts` にイベント付き実行 API を追加

- 例: `delegateTaskWithEvents(task, permit, { onEvent })`
- 実装は `adapter.startTask()` の直後に、並行で `for await (adapter.streamEvents(handle)) onEvent(ev)` を回し、最後に `adapter.awaitResult(handle)` を待つ
- workspace lock / abort wiring / deadline timer の既存責務は WorkerGateway に集約したままにする

2) `src/core/agentcore.ts` から `delegateTaskWithEvents` を呼ぶ

- `WorkerTask.outputMode === OutputMode.STREAM` のときだけイベント転送を有効化
- `onEvent` の中で `protocol.sendJobEvent(jobId, ...)` を行う

メモ:

- `job_event` の送信で `await` を多用すると Core の処理が詰まり得るため、Core 側にジョブ単位の送信キュー/上限を持たせる（後述）

### C) Supervisor 側（TUI への橋渡し）

対象:

- `src/workflow/core-ipc-step-runner.ts`

提案:

- IPC ハンドラを登録: `ipc.onMessage("job_event", (msg) => ...)`
- `runWorkerTask` のスコープで `jobId -> stepId` Map を保持
- `job_event` を受けたら Map で stepId を引き、TUI sink に `ExecEvent: worker_event` として emit する:

```ts
this.sink.emit({
  type: "worker_event",
  stepId,
  ts: msg.ts,
  event: msg.event,
});
```

これにより `src/tui/state-store.ts` が `step.logs.*` を更新し、`src/tui/components/tabs/logs-tab.ts` が表示できる。

### D) `OutputMode.STREAM` をいつ有効化するか

最小の方針:

- `--tui` かつ `--supervised` のとき、Core に投げる job payload の `outputMode` を `STREAM` にする

実装箇所候補:

- `src/workflow/core-ipc-step-runner.ts` の `buildWorkerJob()` で `payload.outputMode` を切り替え（現状は `BATCH` 固定）

オプション設計（将来）:

- `ROBOPPI_TUI_STREAM_STDIO=0` のように stdout/stderr 転送を明示 opt-out にする（TUI では既定で ON）
- progress/patch は常に ON（stdout/stderr は必要に応じて OFF にできる）

## バックプレッシャ / 制限 / セキュリティ

stdout/stderr の無制限ストリーミングは以下を引き起こす:

- IPC の詰まり（JSONL write が遅延）
- メモリ増（キューやバッファ）
- TUI 側のリングバッファが溢れ続ける（最終的には捨てられるが、転送コストは発生する）

推奨の制御（最低限）:

1) 送信サイズ上限（Core 側）

- 1イベントの `data/message/diff` を上限で truncate（例: 16KB）
- `patch.diff` は別上限（例: 256KB）

2) 送信キュー上限（Core 側）

- jobId ごとにキュー上限（例: 500イベント）を持ち、溢れたらドロップ
- ドロップ発生時は progress で "(logs dropped)" を 1 回だけ通知（スパム抑止）

3) progress の間引き（Core 側）

- N ms ごとに最新のみ送る（例: 100ms）

4) stdout/stderr の既定ON（ただし opt-out 可能）

- supervised TUI では `stdout/stderr/progress/patch` を転送する
- `ROBOPPI_TUI_STREAM_STDIO=0` で stdout/stderr を OFF（progress/patch のみ）

理由:

- stdout/stderr には秘密情報（トークン、鍵、顧客データ）が混入し得る
- Roboppi 側で確実な redact は困難

## テスト計画（案）

- 単体テスト:
  - `validateMessage(job_event)` が必須フィールドを検証できる
  - 送信サイズ truncate / キュー溢れドロップが期待通り

- 統合テスト（supervised）:
  - 疑似 worker が一定間隔で progress/stdout を出す
  - Runner が `job_event` を受信し `sink.emit(worker_event)` を呼ぶ
  - `TuiStateStore` にログが蓄積されることを確認

## 受け入れ条件

- supervised + TUI で、実行中に `2: Logs` が更新される
- `progress` が最低 1 秒以内に反映される（体感としてリアルタイム）
- 大量ログでもプロセスがハングしない（IPC タイムアウト/メモリ暴走を起こさない）
- `--no-tui` 既定挙動（BATCH）を維持できる

## 実装ステップ（推奨）

1) IPC に `job_event` を追加（型 + protocol helper + validateMessage）
2) Core: WorkerGateway に `delegateTaskWithEvents` を追加し、AgentCore で `OutputMode.STREAM` 時に `job_event` を送る
3) Runner: `CoreIpcStepRunner` で `job_event` を購読し、`ExecEvent: worker_event` に変換して sink に流す
4) Runner: TUI 時に `outputMode=STREAM` を有効化（既定は progress/patch のみ）
5) 体感改善（任意）: `OpenCodeAdapter` / `ClaudeCodeAdapter` の stderr 逐次 yield 化（現状はまとめて最後に出る実装がある）

## 関連資料

- `docs/wip/tui/ipc-streaming.md`（WIP: supervised ストリーミング拡張のたたき台）
