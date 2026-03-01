# Effect 導入（structured concurrency）で Promise.race / AbortSignal / timer の複雑さを減らす

Status: proposal（段階導入。API破壊的な全面書き換えはしない）

## 課題感（いま何がつらいか）

Roboppi はキャンセル・タイムアウト・並行実行を、主に以下の素朴な組み合わせで実装しています。

- `AbortController` / `AbortSignal` の listener
- `setTimeout` / `clearTimeout`
- `Promise.race` と sentinel 値（`null` など）
- `finally` に散らばる後始末（listener / timer / Map の掃除）

現時点でも動いてはいる一方で、実装が増えるほど次の問題が起きやすいです。

1) パターンの重複と微妙な差分
- `waitForAbort`, `sleep(ms, signal)`, `createScopedAbort` などが局所最適で増殖しやすい

2) 後始末の正しさをレビューで担保しにくい
- 早期 return / 例外 / abort / timeout の全経路で listener/timer を外す必要がある
- waiter Map / request Map のリークは「後から分岐が増えたとき」に入りやすい

3) エラー表現が一貫しない
- timeout を例外で表す箇所と、`null` / `"timeout"` などで表す箇所が混在する
- `p.catch(() => {})` のような「未await時の unhandled 回避」が必要になる

4) 並行実行の意味がコードから読み取りにくい
- 親の abort を子に伝播するのが都度手組み
- submit_job -> permit -> execute -> cancel のような複合フローは race と timeout が絡みやすい

特に複雑さが出ている箇所（例）:

- `src/workflow/core-ipc-step-runner.ts`（races + scoped abort + cancel best-effort）
- `src/ipc/protocol.ts`（`pendingRequests` + timer + transport close 時の fast-fail）
- `src/worker/process-manager.ts`（graceful shutdown の多段 race/timeout）
- `src/scheduler/supervisor.ts`（spawn/bridge 周りの `new Promise` ブロックが多い）

## 目的

1) キャンセル・タイムアウトの意味を明示し、合成可能にする
2) リソース解放（listener/timer/Map cleanup）を構造化して一箇所に寄せる
3) `Promise.race` / timer / listener のボイラープレートを減らし、リーク確率を下げる
4) 外部挙動は維持する（公開APIは当面 Promise を返してよい）
5) Bun + ESM 前提で無理なく運用する

## 方針（Effect-TS を内部プリミティブとして段階導入）

`effect` (Effect-TS) の強みを「内部実装」に限定して取り込みます。

- 中断可能な async 境界: `Effect.async((resume, signal) => ...)`
- タイムアウト: `Effect.timeout` / `Effect.timeoutFail`
- race: `Effect.race`
- finalizer による確実な後始末: `Effect.acquireRelease`（Scope）
- リトライ/バックオフ: `Effect.retry` + `Schedule`（指数 + jitter）
- structured concurrency: fibers（`Effect.fork`, `Fiber.interrupt`, `Effect.all/forEach` + concurrency）

重要: 全面 rewrite せず、境界で `Effect.runPromise` して `async/await` の呼び出し方は維持します。

## 移行計画（段階）

### Phase 0: 依存追加と最小ブリッジ

- `bun add effect`
- CI で `make typecheck` / `make test` を通す
- 乱用を避けるため、最小限の内部ヘルパー層（名前 TBD）を用意する
  - `runPromise` ラッパ
  - `sleep`, `waitForAbort`, `withTimeout`, `raceAbort` など

### Phase 1: IPC の waiter（最もレバレッジが大きい）

対象: `src/ipc/protocol.ts` の `waitForResponse()`.

狙い:

- Map 登録・解除、timer の set/clear を finalizer に集約
- transport close で pending を即 fail（待ち続けない）
- `p.catch(() => {})` のような抑制を不要にする（または局所化する）

外部形は維持:

- API は引き続き `Promise<unknown>`
- 内部だけ Effect 化し、最後に `Effect.runPromise`

### Phase 2: Core IPC step の複合フロー整理

対象: `src/workflow/core-ipc-step-runner.ts`.

狙い:

- `Promise.race([...])` の散在を減らし、abort/timeout を interruption/timeout で統一
- listener cleanup を 1 箇所に寄せる
- "best-effort cancel -> 最大 5s 待つ" のような手続きブロックを明示的にする

### Phase 3: プロセス管理（graceful shutdown）

対象: `src/worker/process-manager.ts`.

- abort listener / timeout を `acquireRelease` + `timeoutFail` で表現
- SIGTERM -> SIGKILL -> stuck fallback の多段を読みやすくする

### Phase 4: Supervisor の spawn / transport bridging

対象: `src/scheduler/supervisor.ts`.

- callback ベース（stdin write / server close 等）を `Effect.async` で包む
- temp dir / server / socket の掃除を finalizer に統一

### Phase 5（任意）: workflow レベルの structured concurrency

対象: `src/workflow/executor.ts`.

ここは効果も大きいが変更幅が最大。

- step 実行を fiber 化し、`Effect.forEach(..., { concurrency })` 等で上限を表現
- workflow abort で子 fiber を一括 interrupt
- `ExecEventSink` のイベント順序・意味は維持する

## 受け入れ条件

1) `make typecheck` が通る
2) `make test` が通る
3) キャンセル挙動の回帰がない
- 親 abort で待ちが止まり、listener/timer が残らない
- step deadline の意味（ACK後の worker budget）を維持する
4) Map が増え続けない（`pendingRequests` / waiters 等）
5) 新規ヘルパーは unit test で
- timeout
- interrupt
- finalizer cleanup（全経路）
を担保する

## 非目標

- コードベース全体を関数型に寄せる
- Layer/Service による大規模DI（Effect Context）をいきなり全域に入れる
- ログ/テレメトリを全面置換する

## リスクと軽減

1) 学習コスト・パラダイム混在
- 最初は「内部ヘルパー層に閉じる」ことで拡散を防ぐ

2) 依存追加のフットプリント
- 段階導入・限定的 import で影響を最小化

3) 意味のズレ（timeout と cancel の扱い）
- 既存挙動を boundary でテストし、段階ごとに差分を小さくする

4) デバッグ/スタックトレース
- 既存エラーメッセージを維持し、必要箇所だけトレースを活用する

## 参考

- Effect: https://github.com/Effect-TS/effect
- 関連: `docs/issues/0005-supervised-ipc-submit-job-timeout.md`（IPC timeout/correlation）
