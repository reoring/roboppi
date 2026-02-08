# AgentCore 実行制御 設計書

**Core / Scheduler 分離 ＋ Worker Delegation ＋ Scheduler 起動版**

---

## はじめに ― この設計書が解決すること

AI エージェントをイベントループで動かすと、よくある問題にぶつかります。LLM への同じリクエストが何度も飛んで処理が詰まる、リトライが止まらなくなる、障害が連鎖してシステム全体が止まる、といったものです。

この設計書は、そうした問題を **仕組みとして防ぐ** ためのアーキテクチャを定義します。

### 解決する課題

| 課題 | 設計上のアプローチ |
|------|-------------------|
| 同一 LLM リクエストの重複実行・スタック | Idempotency Key ＋ 重複制御ポリシー |
| 無限リトライ | 回数上限・バックオフ・ジッター・エラー分類 |
| 致命的障害の連鎖 | Circuit Breaker ＋ エスカレーション ＋ 隔離 |
| 重い処理がエージェント本体を巻き込む | Worker への委譲（プロセス分離） |
| エージェント自体のクラッシュ・ハング | Scheduler による子プロセス監督 |

### 設計の前提

- 実行系を **Core（mechanism）** と **Scheduler（policy）** に分離し、ポリシーだけを差し替え可能にする
- AgentCore は計画・許可・中断・観測に集中し、実作業は **Worker（OpenCode / Codex CLI / Claude Code）** に委譲する
- **Scheduler が AgentCore を子プロセスとして起動・監督**する

---

## 1. 設計原則

### 1.1 mechanism と policy の分離

この設計の根幹は「仕組み（mechanism）」と「判断（policy）」を分けることにあります。

**Core（mechanism）** は「止める」「制限する」「観測する」「隔離する」といった原語を提供し、安全性の不変条件を強制します。どんなポリシーに差し替えても、Core が守る制約は破れません。

**Scheduler（policy）** は「どの順番で実行するか」「重複をどう扱うか」「リトライをどう判断するか」といった意思決定を担います。運用方針に合わせて差し替えられます。

### 1.2 "実行を抱えない" 原則（delegation-first）

AgentCore は **計画・許可・中断・観測** に専念します。

リポジトリ操作、コマンド実行、コード生成・修正・検証といった実作業はすべて **外部 Worker** に委譲します。重い処理をプロセス境界で分離することで、詰まりの伝搬を遮断できます。

---

## 2. コンポーネント構成

システムは 3 つの層で構成されます。

```
┌─────────────────────────────────────────────────┐
│  Scheduler（親プロセス / Supervisor）              │
│  ┌───────────────────────────────────────────┐   │
│  │  AgentCore（子プロセス / Runtime）          │   │
│  │  ┌─────────────┐  ┌─────────────────────┐│   │
│  │  │ Permit Gate  │  │ Worker Delegation   ││   │
│  │  │ Watchdog     │  │ Gateway             ││   │
│  │  │ CB           │  │  ┌───┐ ┌───┐ ┌───┐ ││   │
│  │  │ Escalation   │  │  │W1 │ │W2 │ │W3 │ ││   │
│  │  └─────────────┘  │  └───┘ └───┘ └───┘ ││   │
│  │                    └─────────────────────┘│   │
│  └───────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘

W1 = Codex CLI / W2 = Claude Code / W3 = OpenCode
```

### 2.1 Scheduler（親プロセス / Supervisor）

Scheduler は AgentCore を「1 つのワーカープロセス」として扱います。差し替え可能ですが、起動監督の役割は必須に近い位置づけです。

**責務一覧：**

- **AgentCore プロセスの起動・監督**
  - プロセスの起動、stdin/stdout の IPC 接続
  - ヘルスチェック（応答遅延・メモリ・CPU しきい値）
  - ハング・高負荷・異常終了時の再起動
  - ログ回収、クラッシュダンプ回収（任意）
- **JobQueue の管理** ― 優先度、フェアネス、遅延実行
- **InFlightRegistry** ― 重複制御（coalesce / latest-wins / reject）
- **RetryPolicy** ― エラー分類に基づくリトライ判断（ただし上限は Core が強制）
- **DLQ / 再投入戦略** ― 保存先・復旧フロー

> **補足：** Out-of-process 構成の場合、Scheduler は複数の AgentCore を水平起動してスケールアウトや障害分離を担当することもできます。

### 2.2 Core（AgentCore Runtime / 子プロセス）

Core が持つ責務は固定です。ポリシーに依存せず、安全性の不変条件を守ります。

| # | 責務 | 概要 |
|---|------|------|
| 1 | **Cancellation** | AbortSignal / AbortController による中断の統一 |
| 2 | **Execution Budget Gate** | timeout / maxAttempts / concurrency / RPS / cost の強制 |
| 3 | **Backpressure API** | 混雑時の拒否・延期・縮退の統一応答 |
| 4 | **Watchdog** | 詰まり・遅延・失敗集中の検知 |
| 5 | **Circuit Breaker（CB）** | 外部依存（LLM Provider / Worker Provider 等）の連鎖障害遮断。最終権限を持つ |
| 6 | **Escalation Manager** | 致命度に応じた隔離・停止・通知イベント発行 |
| 7 | **Observability** | 構造化ログ、traceId、メトリクス必須フィールド定義 |
| 8 | **Worker Delegation Gateway** | 外部 Worker への委譲（実行要求・中断伝搬・結果回収） |

> **重要：** Core はキューを持つ必要はありませんが、**Permit（実行許可）の発行権限** と **中断権限** は必ず握ります。Worker 実行も「Permit が無い限り走らない」を徹底します。

### 2.3 Worker（外部エージェント群）

Worker は「実行環境」と「能力」を提供し、AgentCore がそれらを統一プロトコルで呼び出します。

| Worker | 特徴 |
|--------|------|
| **Codex CLI** | ローカル端末上でコード読解・編集・コマンド実行を行うエージェント |
| **Claude Code** | ターミナル / IDE / CI 等で動作するコーディング支援エージェント |
| **OpenCode** | primary agent から subagents を呼び出す構造を持ち、サブエージェントで分業が可能 |

---

## 3. 起動モデル ― Scheduler が AgentCore を起動する

### 3.1 親子プロセスの関係

```
Scheduler（親）
  │
  ├─ spawn(agentcore, args...)
  ├─ stdin/stdout で JSON Lines IPC
  ├─ heartbeat / health を定期監視
  │
  └─→ AgentCore（子）
        ├─ 外部から与えられたジョブを処理
        ├─ Permit を発行し、Worker へ委譲
        └─ 監視・遮断・エスカレーションを担う
```

Scheduler は AgentCore を子プロセスとして `spawn` し、stdin/stdout を保持して **JSON Lines** で双方向通信します。heartbeat による応答遅延の監視、メモリ・CPU しきい値の確認を定期的に行います。

AgentCore は「外部から与えられたジョブ」を処理するランタイムとして振る舞い、Permit を発行し、必要に応じて Worker を起動して仕事を委譲します。

### 3.2 クラッシュ・ハング時の扱い（Supervisor ポリシー）

| 状況 | 対応 |
|------|------|
| **子プロセスが落ちた** | 未完了ジョブは Scheduler 側で in-flight を失敗扱いにし、再投入または DLQ へ送る |
| **子がハングした** | 親が SIGTERM → 猶予期間 → SIGKILL（猶予時間はポリシーで設定） |
| **連続クラッシュ** | Circuit Breaker 的に「AgentCore インスタンス自体」を隔離し、別インスタンスへフェイルオーバー |

---

## 4. データモデル

### 4.1 Job ― Scheduler が生成する「要求」

Job は Scheduler が生成し、AgentCore に投入する作業の単位です。

```
Job {
  jobId         : UUID
  type          : LLM | TOOL | WORKER_TASK | PLUGIN_EVENT | MAINTENANCE ...
  priority      : 整数 ＋ クラス（interactive / batch 等）
  key?          : Idempotency Key（重複制御用）
  payload       : 入力（プロンプト、ツール引数、ワーカー指示など）
  limits        : 要求する予算（timeoutMs, maxAttempts, costHint）
  context       : traceId, correlationId, userId?, sessionId?
}
```

### 4.2 Permit ― Core が発行する「実行許可」

Permit は Core が発行する実行許可証です。これが無ければジョブも Worker も実行されません。

```
Permit {
  permitId              : UUID
  jobId                 : UUID
  deadlineAt            : タイムスタンプ
  attemptIndex          : 何回目の試行か
  abortController       : attempt ごとに新規作成
  tokensGranted         : concurrency / RPS / コスト枠
  circuitStateSnapshot  : 発行時点の CB 状態
}
```

### 4.3 WorkerTask ― Core → Worker の委譲単位

WorkerTask は AgentCore から Worker に渡す指示書です。

```
WorkerTask {
  workerTaskId   : UUID
  workerKind     : CODEX_CLI | CLAUDE_CODE | OPENCODE | CUSTOM
  workspaceRef   : 対象リポジトリ / ディレクトリ（マウントや chdir 方針）
  instructions   : 実行指示（自然言語 ＋ 制約）
  capabilities   : 許可する行為（例：read / edit / run_tests）
  outputMode     : stream | batch
  budget         : deadlineAt, maxSteps?, maxCommandTimeMs?
  abortSignal    : Permit 由来（中断伝搬）
}
```

### 4.4 WorkerResult ― Worker → Core の結果

WorkerResult は Worker が返す実行結果です。

```
WorkerResult {
  status        : SUCCEEDED | FAILED | CANCELLED
  artifacts     : パッチ、差分、ログ、生成物参照
  observations  : 実行したコマンド、変更ファイル一覧（監査用）
  cost          : 推定 / 実測（可能なら）
  errorClass?   : retry 判断に使う分類
}
```

---

## 5. インタフェース設計（IPC / SPI）

IPC は **stdin/stdout JSON Lines** を基本とし、将来 gRPC / HTTP に差し替え可能な設計です。

### 5.1 Scheduler → AgentCore（ジョブ投入）

| メソッド | 説明 |
|---------|------|
| `submit_job(job)` → `ack(jobId)` | ジョブを AgentCore に投入 |
| `cancel_job(jobId \| key, reason)` | ジョブのキャンセル要求 |
| `report_queue_metrics(...)` | キューの遅延・バックログ等のメトリクス報告（任意） |

### 5.2 Scheduler → Core（実行許可要求）

| メソッド | 説明 |
|---------|------|
| `request_permit(job, attemptIndex)` → `Permit \| Rejected(reason)` | 実行許可を Core に要求 |

**Rejected の理由として返り得る値：**

`QUEUE_STALL` / `CIRCUIT_OPEN` / `RATE_LIMIT` / `GLOBAL_SHED` / `FATAL_MODE`

### 5.3 Core → Scheduler（結果通知）

| メソッド | 説明 |
|---------|------|
| `on_job_completed(jobId, outcome, metrics, errorClass?)` | ジョブ完了の通知 |
| `on_job_cancelled(jobId, reason)` | ジョブキャンセルの通知 |
| `on_escalation(event)` | エスカレーションイベントの通知 |

### 5.4 Core → Worker（委譲プロトコル：WorkerAdapter 経由）

Core 内に **WorkerAdapter 層** を設けて、外部ツールごとの差異を吸収します。

| メソッド | 説明 |
|---------|------|
| `start_worker_task(workerTask)` → `handle` | Worker タスクの開始 |
| `stream_events(handle)` → `{stdout, stderr, progress, patches...}` | イベントストリーム受信 |
| `cancel(handle)` | タスク中断（Permit の abort と連動） |
| `await_result(handle)` → `WorkerResult` | 結果の待機・回収 |

> WorkerAdapter は「プロセス起動 / 入出力 / 中断」を統一し、Codex CLI / Claude Code / OpenCode を同じ契約で扱います。

---

## 6. Worker Delegation 設計

### 6.1 なぜ Worker 委譲が必要か ― 暴走・詰まり対策として

AgentCore 内で「巨大 JSON 処理」「長時間 LLM 呼び出し」「外部コマンド実行」を直接抱えると、イベントループの遅延や詰まりが本体に直撃します。

Worker を **別プロセス** にすることで、次の効果が得られます。

- **影響範囲の局所化** ― CPU / メモリ / FD 枯渇が AgentCore に波及しない
- **OS レベルの強制停止** ― ハング時に kill できる
- **同時実行数の制御** ― Permit で絞れる

### 6.2 各 Worker の扱い

**Codex CLI の場合：**
`workspaceRef` を作業ディレクトリに固定してそこで起動します。変更は diff / patch で回収し、必要なら PR / コミットを別ジョブで実施します。

**Claude Code の場合：**
system prompt やエージェント設定を注入して起動します。再現性のためファイル指定を推奨します。

**OpenCode の場合：**
subagent をタスク種別ごとに割り当てます（例：Explore＝調査、General＝編集）。複数の subagent を段階的に呼び出す構成（計画 → 探索 → 実装 → 検証）が取れます。

### 6.3 中断伝搬の仕組み

中断がシステム全体を貫通することが、この設計の重要なポイントです。

```
Job 中断（latest-wins / cancel / timeout）
  ↓
Permit.abort が発火
  ↓
Core が WorkerAdapter.cancel を呼び出す
  ↓
Worker プロセスを安全停止（不可なら強制 kill）
```

> **設計方針：**「止められない Worker」は設計上の欠陥として扱います。採用しないか、サンドボックス隔離します。

### 6.4 セキュリティ・安全境界（推奨）

| 対策 | 内容 |
|------|------|
| **workspace の限定** | 専用ディレクトリに読み書き範囲を制約 |
| **コマンドの allowlist** | 実行可能コマンドを限定（例：`go test`, `cargo test`, `npm test`） |
| **秘密情報の隔離** | 環境変数で渡さず、vault 参照ジョブを別系統で管理 |
| **監査ログ必須** | 実行コマンド、変更ファイル、差分要約、実行時間を記録 |

---

## 7. 同一内容 LLM 実行のスタック抑止

同じ内容のリクエストが繰り返し飛ぶ問題を **Idempotency Key** で防ぎます。

### 7.1 Idempotency Key の構成

**LLM リクエストの場合：**

```
{provider}:{model}:{promptHash}:{toolStateHash}:{userTurnId?}
```

**Worker タスクの場合：**

```
{workerKind}:{workspaceHash}:{taskHash}:{inputsHash}
```

### 7.2 重複制御の流れ

Scheduler 側の InFlightRegistry が Idempotency Key をもとに重複を検出し、ポリシー（coalesce / latest-wins / reject）を適用します。

Core 側は Idempotency Key の有無にかかわらず **Budget / Circuit Breaker / Watchdog** を必ず enforce します。

---

## 8. リトライ制御 ― 無限リトライ防止

### 8.1 Core が強制する制約（不変条件）

Core は以下を常に enforce します。Scheduler のポリシーがどう設定されていても、この制約は破れません。

- `maxAttempts` ― 試行回数の絶対上限
- `timeoutMs` ― 1 回の試行のタイムアウト
- `retryBudget` ― 全体としての暴走制御（時間・コスト）

WorkerTask についても同様に enforce します。「テストが落ち続ける無限ループ」もここで止まります。

### 8.2 Scheduler が判断するポリシー（差し替え可能）

- **エラー分類によるリトライ可否の判定**
  - 429（レートリミット）/ 5xx（サーバーエラー）/ ネットワーク障害 → retryable
  - Worker 起因の恒常的失敗（lint / test が常に失敗）→ 通常 non-retryable 寄り（方針で調整）
- **バックオフ戦略**
  - exponential backoff ＋ full jitter を推奨

---

## 9. Circuit Breaker（対象の拡張）

Core が保持する Circuit Breaker の対象を、LLM Provider だけでなく Worker Provider まで拡張します。

### 9.1 対象一覧

| 対象 | CB が反応する例 |
|------|-----------------|
| LLM Provider 単位 / モデル単位 | 特定モデルの応答エラーが集中 |
| **Worker Provider 単位** | Codex CLI が頻繁にクラッシュする |
| | Claude Code が一定時間応答しない |
| | OpenCode が異常に遅い / 暴走する |

### 9.2 動作

CB が OPEN になると `request_permit` が拒否されます。Scheduler は別の Worker へフォールバックできます。

---

## 10. Watchdog ― 詰まり検知

Core が観測する指標に Worker 関連のものを追加します。

### 10.1 観測指標

| 指標 | 何を見ているか |
|------|---------------|
| `worker_inflight_count` | 現在実行中の Worker タスク数 |
| `worker_queue_lag_ms` | Worker キューの遅延 |
| `worker_timeout_rate` | Worker タスクのタイムアウト率 |
| `worker_cancel_latency_ms` | 中断指示が効くまでの時間 |
| `workspace_lock_wait_ms` | 同一 workspace の同時編集による競合待ち時間 |

### 10.2 自動防御

しきい値を超えた場合、段階的に防御が発動します。shed（負荷カット）→ throttle（流量制限）→ CB OPEN → escalation の順に進みます。

---

## 11. エスカレーション ― 致命的障害への対応

### 11.1 FATAL 条件（Worker を含む）

従来の FATAL 条件に加えて、Worker 関連の条件を追加します。

- Worker が短時間に連続クラッシュ（N 回 / 分）
- cancel が効かず「幽霊プロセス」が残る
- 同一 workspace に対する latest-wins が過多（変更が収束しない）

### 11.2 アクション

| スコープ | アクション例 |
|---------|-------------|
| `scope=workerKind` | 特定 Worker の隔離（その Worker 種別を停止） |
| `scope=workspace` | 対象 workspace のロック・隔離（該当リポジトリ操作を停止） |
| `scope=global` | システム全体の安全停止 |

---

## 12. 分離境界の整理 ― 何をどこに置くか

### 12.1 Scheduler 側に外出しできるもの

- JobQueue / InFlightRegistry / Retry strategy / DLQ
- AgentCore の起動監督（Supervisor）
- 複数 AgentCore の水平管理（pooling / sharding）

### 12.2 Core に残すもの（不変条件）

- Permit と Budget の enforce
- AbortSignal による中断（Worker へも伝搬）
- Circuit Breaker の最終権限（LLM / Worker とも）
- Watchdog と Escalation
- 観測の最低限共通フィールド

### 12.3 Worker に押し出すもの（実作業）

- コード編集、コマンド実行、テスト、静的解析、差分生成
- 必要に応じた作業ログの要約生成（ただし最終判断は Core / Scheduler）

---

## 13. 実装メモ（Bun 前提 ＋ プロセス境界）

- AgentCore は「入力＝ジョブ、出力＝イベント」の JSON Lines サーバとして実装するのが自然です
- WorkerAdapter は Bun の `spawn` / `AbortSignal` / タイムアウトで統一管理します
- Worker の stdout / stderr は **ストリームとして観測** し、Watchdog が詰まり検知に使います
- workspace をロックする仕組み（同一リポジトリの同時編集防止）は、WorkerAdapter か Scheduler policy のどちらかに配置します。推奨は「ポリシーは Scheduler、強制は Core」の分担です

---

## 14. テスト計画

| # | テスト項目 | 検証内容 |
|---|-----------|---------|
| 1 | **Worker 委譲** | WORKER_TASK が Permit 無しでは実行されないこと |
| 2 | **中断伝搬** | cancel / latest-wins で Worker プロセスが停止し、残留しないこと |
| 3 | **Worker CB** | 特定 Worker の失敗集中 → OPEN → 他 Worker へフォールバックが行われること |
| 4 | **workspace 競合** | 同一リポジトリ編集が衝突せず、ポリシー通り（reject / coalesce / serialize）に処理されること |
| 5 | **Supervisor 再起動** | AgentCore を kill → Scheduler が再起動 → 未完了ジョブが正しく再投入 / DLQ に振り分けられること |

---

## 15. 設計の妥当性検証

以下は、この設計書を検証した結果の所見です。

### 15.1 強み（妥当と判断できる点）

**mechanism / policy 分離は健全です。** Core が握る不変条件（Permit、中断、CB 最終権限）と、Scheduler が担うポリシー（優先度、リトライ判断、DLQ）の分離は明確で、差し替え可能性が確保されています。

**Worker のプロセス分離は爆心隔離として有効です。** CPU/メモリ枯渇やハングの影響範囲を Worker プロセスに局所化できる点は、イベントループ型エージェントの詰まり対策として理にかなっています。

**中断伝搬の一貫性が確保されています。** Job → Permit → WorkerAdapter → Worker プロセスと中断が一貫して伝搬する設計は、「止められない処理」が残留するリスクを最小化します。

**Circuit Breaker の対象拡張は妥当です。** LLM Provider だけでなく Worker Provider にも CB を適用することで、特定 Worker の不調がシステム全体に波及するのを防げます。

### 15.2 注意点・検討が必要な箇所

**Scheduler と Core の間の Permit 発行フローに曖昧さがあります。** Scheduler が `request_permit` を呼び、Core が Permit を返す流れは定義されていますが、Scheduler が `submit_job` でジョブを投入する経路と `request_permit` の経路が 2 本あり、いつどちらを使うのかの判断基準がやや不明確です。ジョブ投入と Permit 要求のタイミングを明確にするシーケンス図の追加を推奨します。

**JSON Lines IPC のエラーハンドリングが未定義です。** IPC 自体が壊れるケース（パース失敗、途中切断、バッファ溢れ）の扱いが記述されていません。IPC レベルの障害は Scheduler の Supervisor ロジックで検知・対処するのが自然ですが、プロトコルとしての仕様化が必要です。

**WorkerAdapter の「安全停止→強制 kill」の猶予時間が未定義です。** cancel 後に Worker が応答しない場合の猶予時間（grace period）が具体的に定義されていません。`worker_cancel_latency_ms` を Watchdog で監視する設計はありますが、しきい値と段階（SIGTERM → 猶予 → SIGKILL）の具体値は実装時に決定が必要です。

**workspace ロックの責任分担が「推奨」止まりです。** 「ポリシーは Scheduler、強制は Core」と推奨されていますが、具体的にどの操作がロックを取り、どのタイミングで解放するかの仕様がありません。同一リポジトリへの同時編集は実運用で頻発しうるため、ロックの粒度（ファイル単位 / ディレクトリ単位 / リポジトリ単位）と取得・解放プロトコルの定義を推奨します。

**DLQ からの復旧フローが抽象的です。** DLQ に送られたジョブをどう再投入するか（手動 / 自動 / 条件付き）が明確でありません。運用上、DLQ に溜まったジョブの可視化と再投入判断のインタフェースが必要です。

### 15.3 総合評価

全体としてアーキテクチャの方向性は妥当です。特に「Core が安全性の不変条件を強制し、Scheduler がポリシーを担う」という分離と、「重い処理をプロセス境界で隔離する」という Worker 委譲の考え方は、イベントループ型 AI エージェントの実運用で起こりうる問題に対して適切に設計されています。上記の注意点は実装フェーズで順次解決可能な範囲のものです。

---

## 付録：引用と根拠

### A) Codex CLI はローカルでコードを読み・変更し・実行できる

> "Codex CLI is OpenAI's coding agent that you can run locally from your terminal. It can read, change, and run code on your machine in the selected directory."

**出典：** [OpenAI Developers - Codex CLI](https://developers.openai.com/codex/cli/)

AgentCore が実作業（編集・実行）を抱える代わりに、Codex CLI を外部 Worker として起動し、workspace を限定して処理を委譲できることの根拠です。

### B) Claude Code はターミナル等で動作するエージェント

> "Claude Code is also available on the web, as a desktop app, in VS Code and JetBrains IDEs, in Slack, and in CI/CD with GitHub Actions and GitLab."

**出典：** [Claude Code - Quickstart](https://code.claude.com/docs/en/quickstart)

Worker を CLI だけに固定せず、将来 IDE / CI に拡張する余地があります。本設計ではまずプロセス境界で呼べる CLI を基準に WorkerAdapter を設計します。

### C) OpenCode には subagents がある

> "Subagents are specialized assistants that primary agents can invoke for specific tasks."

**出典：** [OpenCode - Agents](https://opencode.ai/docs/agents/)

AgentCore からの委譲先を「単一の万能 Worker」にせず、OpenCode の subagent を使って探索・実装・検証を分業させる設計が取りやすくなることの根拠です。

### D) Codex CLI はリポジトリを読み、編集し、コマンドを実行できる

> "Codex launches into a full-screen terminal UI that can read your repository, make edits, and run commands as you iterate together."

**出典：** [OpenAI Developers - Codex CLI features](https://developers.openai.com/codex/cli/features/)

Worker を「対話 UI」で使う場合でも、AgentCore 側は Permit / 中断 / 監査 / 結果回収を担えばよく、実行の重さを本体に持ち込まずに済むことの根拠です。
