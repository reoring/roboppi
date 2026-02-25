# Supervised IPC: submit_job ACK タイムアウト (非対話)

ステータス: 解決済み (supervised IPC における socket transport; Unix socket + TCP フォールバック)
（stdio 側の根本原因は環境依存のまま）

## 問題

`--supervised` モード（Supervisor -> Core IPC -> Worker）でワークフローを実行すると、一部の非対話実行で最初のステップ（`bootstrap`）で
`submit_job` の ACK 待機中に IPC タイムアウトが発生して失敗します。

観測された失敗:

```
Core IPC submit_job timed out after <N>ms (jobId=... requestId=...)
```

IPC トレースで見えた主な症状:

- Runner のログに `tx submit_job` が出る
- Core が起動し、stderr に起動ログを出力する
- Core 側で `rx submit_job` が出ず、ACK を送信しない

つまり壊れているのは Runner -> Core の stdin 経路（Core 側でメッセージが見えない）です。

対処: socket ベースの supervised IPC transport（`ROBOPPI_SUPERVISED_IPC_TRANSPORT=socket`）を使い、stdio パイプを完全に迂回します。

もし環境側で Unix ドメインソケット作成が禁止されている（例: `listen` が `EPERM` / `EACCES` で失敗する）場合は、TCP ループバックを使います:

- `ROBOPPI_SUPERVISED_IPC_TRANSPORT=tcp`

## 再現

典型的な再現手順（stdio を強制。影響を受ける環境では失敗する可能性あり）:

```bash
ROBOPPI_SUPERVISED_IPC_TRANSPORT=stdio \
  ROBOPPI_IPC_TRACE=1 ROBOPPI_IPC_REQUEST_TIMEOUT=45s VERBOSE=0 \
  bash examples/agent-pr-loop-demo/run-in-tmp.sh
```

Socket transport（成功を想定）:

```bash
ROBOPPI_SUPERVISED_IPC_TRANSPORT=socket \
  ROBOPPI_IPC_TRACE=1 ROBOPPI_IPC_REQUEST_TIMEOUT=2m VERBOSE=0 \
  bash examples/agent-pr-loop-demo/run-in-tmp.sh
```

TCP transport（Unix socket がブロックされている環境向け）:

```bash
ROBOPPI_SUPERVISED_IPC_TRANSPORT=tcp \
  ROBOPPI_IPC_TRACE=1 ROBOPPI_IPC_REQUEST_TIMEOUT=2m VERBOSE=0 \
  bash examples/agent-pr-loop-demo/run-in-tmp.sh
```

注記: `src/workflow/run.ts` では非対話の `--supervised` 実行時に
`ROBOPPI_SUPERVISED_IPC_TRANSPORT=socket` がデフォルトになっています（`stdio|socket|tcp` で上書き可）。

補足:

- この問題はワークフロー YAML の `timeout` ではなく、IPC の request/response に関するものです。
- Keepalive 出力は「無出力監視による強制終了」を防ぐことはできますが、IPC のリクエストタイムアウトを修正するものではありません。

## 調査サマリ

1) Keepalive とタイムアウト

- `src/workflow/run.ts` に keepalive 出力を追加し、無出力でプロセスを kill される環境を回避。
- 非 supervised 実行では keepalive が有効なことを確認。
- supervised 実行では、失敗の原因が IPC リクエストタイムアウトであり、watchdog SIGTERM ではないことを確認。

2) IPC リクエストタイムアウト

- デフォルトの IPC リクエストタイムアウトが 30 秒（`DEFAULT_REQUEST_TIMEOUT_MS = 30_000`）であることを確認。
- IPC リクエストタイムアウトを設定可能にし、supervised runner の既定値を `2m` に引き上げ:
  - CLI: `--ipc-request-timeout <DurationString>`
  - 環境変数: `ROBOPPI_IPC_REQUEST_TIMEOUT` / `ROBOPPI_IPC_REQUEST_TIMEOUT_MS`

3) ステップタイムアウトとの関係

- `bootstrap: timeout: 2m` などのステップレベルタイムアウトが、長めの IPC タイムアウトより先に発火していた事例を確認。
- supervised runner の step timeout が Core の起動/ACK 待ちではなく、*Worker 実行時間*（ACK 取得後）に適用されるよう調整。

4) 停止した IPC 操作の特定

- タイムアウトした操作を `submit_job` / `request_permit` / `cancel_job` で識別できるようエラー情報を強化。
- 失敗経路では一貫して `submit_job` の ACK タイムアウトでした。

5) IPC トレース機能

- `src/ipc/json-lines-transport.ts` に `ROBOPPI_IPC_TRACE=1` のサポートを追加:
  - `tx` / `rx` を `pid` / `type` / `requestId` / `jobId` と共に出力。
- デモトレース補助を追加:
  - `examples/agent-pr-loop-demo/run-in-tmp.sh` が `ROBOPPI_ROOT` と git SHA を表示。

6) トランスポートレベルのエラー

- `src/ipc/protocol.ts` で切断時に保留中リクエストが即座に失敗するよう close/error 処理を追加。
- 失敗例では、トランスポートのパース失敗/切断エラーは観測されませんでした。

7) Core 起動 / stdio ブリッジ

- `src/scheduler/supervisor.ts` を `node:child_process.spawn` を使うよう変更。
- Core の stderr を親の stderr にパイプ接続して可視化。
- child の環境変数を明示的に引き継ぎ（Bun.spawn では更新済み `process.env` が継承されないため）。
- Core への stdin 書き込みを常にコールバックベース `write()` に変更し、完了待機を追加。
- Core IPC の stdin 取得元を調整:
  - `src/index.ts` では Core IPC 入力に `Bun.stdin.stream()` を優先使用（必要に応じて `process.stdin` にフォールバック）。

これらの変更で多くの環境で supervised IPC は改善しましたが、一部の環境では stdio メッセージが完全に消失します（Runner `tx` だけ発生し Core `rx` なし）。

8) socket ベースの supervised IPC transport

- supervised IPC に socket transport を追加し、stdio パイプを回避: `ROBOPPI_SUPERVISED_IPC_TRANSPORT=socket`。
  - 既定は Unix ドメインソケット。Unix socket が許可されない場合は TCP ループバックへフォールバック。
  - 明示的に TCP を使う場合は `ROBOPPI_SUPERVISED_IPC_TRANSPORT=tcp`。
- `src/workflow/run.ts` は非対話の `--supervised` 実行で既定値を `socket` に設定（`ROBOPPI_SUPERVISED_IPC_TRANSPORT=stdio|socket|tcp` で上書き可）。
- Core は Supervisor がセットする `ROBOPPI_IPC_SOCKET_PATH`（Unix）または `ROBOPPI_IPC_SOCKET_HOST` + `ROBOPPI_IPC_SOCKET_PORT`（TCP）へ接続します。

## 関連作業（Agent PR Loop デモ）

調査中に agent PR loop のデモ/ワークフローも強化:

- `examples/agent-pr-loop.yaml`: review 結果に応じて `implement`（Claude Code）をループするよう変更し、`completion_check` を使用。
- `completion_check` の判断を `decision_file` によるファイルベース判定へ対応し、stdout マーカー依存を排除。
- `scripts/agent-pr-loop/review-inputs.sh`: `.roboppi-loop/review.untracked.diff` を生成し、レビューに未追跡差分を含める。
- `examples/agent-pr-loop-demo/request.md`: 具体的な境界ケースを追加して品質基準を引き上げ。
- `examples/agent-pr-loop-demo/run-in-tmp.sh`: ワークフロー完了後の検証を追加（ブラックボックス確認）。

## 現在の状況 / 次のステップ

- 根本原因: supervised stdio パイプで、特定の非対話環境で Runner -> Core 方向のメッセージが落ちて `submit_job` の ACK タイムアウトにつながる。
- 実装済み対策: supervised IPC を `ROBOPPI_SUPERVISED_IPC_TRANSPORT=socket` に変更。非対話 `--supervised` 実行では `src/workflow/run.ts` により既定で socket になります。
- 旧挙動が必要な場合、または元の問題を再現したい場合は次を指定:
  - `ROBOPPI_SUPERVISED_IPC_TRANSPORT=stdio`

## 2026-02-14 フォローアップ

非対話 supervised 起動で Supervisor -> Core stdin が黙って落ちる可能性をさらに下げるため、stdio の堅牢性を追加で向上しました。

### 変更内容

- `src/index.ts`: Core stdin 選択での互換フォールバックを追加。
  - 利用可能なら `Bun.stdin.stream()` を使用。
  - 利用不可時は `Readable.toWeb(process.stdin)` にフォールバック。
- `src/scheduler/supervisor.ts`: Core `stdin` トランスポート初期化を強化。
  - `proc.stdin.setDefaultEncoding("utf8")` を best-effort で呼び出し。
  - `proc.stdin.setNoDelay(true)` を best-effort で呼び出し。
  - Core の stdin エラーをログ出力 (`[IPC][core-stdin-error]`)。

### stdio transport の残タスク

- 再度再現コマンドを `ROBOPPI_IPC_TRACE=1` で実行。
- トレースに以下が含まれることを確認:
  - `tx submit_job`（Runner）
  - `rx submit_job`（Core）
  - `tx ack`（Core）
  - `rx ack`（Runner）
- それでも欠落する場合、次は外部実行環境の子プロセスグループ/セッションラッピングを確認し、Core 起動前にラッピングを無効化。

### 2026-02-14 (stdio) 再実行結果

- 再現コマンド（stdio 強制）:
  - `ROBOPPI_SUPERVISED_IPC_TRANSPORT=stdio ROBOPPI_IPC_TRACE=1 ROBOPPI_IPC_REQUEST_TIMEOUT=45s VERBOSE=0 bash examples/agent-pr-loop-demo/run-in-tmp.sh`
  - `ROBOPPI_SUPERVISED_IPC_TRANSPORT=stdio ROBOPPI_IPC_TRACE=1 ROBOPPI_IPC_REQUEST_TIMEOUT=20s bun run src/workflow/run.ts examples/hello-world.yaml --supervised`
- 両方のコマンドで、いずれも以下を確認:
  - Runner `tx submit_job`
  - Core 起動ログ（`AgentCore starting`, `AgentCore started, awaiting IPC messages`）
  - Core 側の `[IPC][rx]` / `ack` は **未観測**
  - 20〜45 秒でタイムアウトし、ワークフロー失敗
- 追加の分離検証:
  - `ROBOPPI_IPC_TRACE=1 bun /home/reoring/roboppi/src/index.ts` をシェルパイプ経由（`printf ... | bun src/index.ts`）で実行すると `Core [IPC][rx] submit_job` と `ack` を確認。
  - Bun runtime + `node:child_process` で子 bun プロセスへ書き込む supervisor 経路では、最小化した writer スクリプトでも Core の `[IPC][rx]` は得られない。
- stdio に関する最新仮説:
  - 本環境では Bun runtime のプロセス生成 + pipe transport が子 bun プロセスの stdin をトランスポート層で破棄する可能性。
  - stdio は一部環境で依然不安定。タイムアウト再試行に費やすより、トランスポートの堅牢化まで待つべき。

### 2026-02-14 (socket) 再実行結果

- socket transport での問題解消を end-to-end で確認:
  - `ROBOPPI_SUPERVISED_IPC_TRANSPORT=socket ROBOPPI_IPC_REQUEST_TIMEOUT=2m VERBOSE=0 bash examples/agent-pr-loop-demo/run-in-tmp.sh`
    -> ワークフロー `SUCCEEDED`、デモの事後チェック完了
  - `ROBOPPI_IPC_TRACE=1 bun run src/workflow/run.ts examples/hello-world.yaml --supervised`
    -> Core `[IPC][rx] submit_job` と `ack` を確認、ワークフロー `SUCCEEDED`
- 全テスト通過: `bun test`（949 件）
- 結論: 非対話 supervised 実行では socket transport を利用。stdio はフォールバック / デバッグ用。
