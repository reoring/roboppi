# CLI/バイナリ統合 テスト計画（roboppi）

## 1. 目的
- 単一バイナリ `roboppi` に統合したコマンド体系（server/run/workflow/daemon/agent）が仕様どおりに動作することを確認する。
- supervised 実行（Supervisor -> Core -> Worker）が、dev（`bun run`）/ compiled（`./roboppi`）双方で成立することを確認する。
- `RangeError: Out of memory` の再発防止として、低メモリ環境でのビルド/実行手順と検証観点を明文化する。

## 2. 対象（スコープ）
- CLI ルーティング/サブコマンド: `src/cli.ts`
- Core 起動（stdio/socket/tcp）: `src/core/core-runtime.ts`, `src/index.ts`
- Workflow runner（`roboppi workflow`）: `src/workflow/run.ts`（`runWorkflowCli`）
- Daemon runner（`roboppi daemon`）: `src/daemon/cli.ts`（`runDaemonCli`）
- supervised child の起動方式: `src/scheduler/supervisor.ts`
- ビルド/配布: `Makefile`, `package.json`（`bin`）

## 3. 非対象
- 外部 worker CLI（OpenCode/Claude/Codex）の正当性・安定性（本プロジェクト外）
- OS 依存の watcher/webhook の詳細な網羅（必要に応じて個別計画を追加）

## 4. テスト戦略
### 4.1 自動テスト（CI で回す）
- 既存: `make typecheck`, `make test`, `make test-at`, `make test-branch`, `make test-all`
- 追加（推奨）: `tests/at/cli-subcommands.test.ts` を新設し、`bun run src/cli.ts workflow ...` 等の起動を最低限カバー

### 4.2 手動/任意（ローカルで回す）
- compiled バイナリの E2E（`make build` -> `./roboppi ...`）
- 外部 worker CLI を使う `roboppi run` 成功系

## 5. 前提条件
- `bun` が利用可能
- workflow の `CUSTOM` step 実行のため `bash` が利用可能
- `/tmp` へのディレクトリ作成が可能
- daemon の短時間起動検証で `timeout` が使える（Linux）。macOS は `gtimeout` か Ctrl-C で代替

## 6. テスト観点
- サブコマンド分岐: `roboppi workflow`/`roboppi daemon`/`roboppi run`/`roboppi agent`
- `agent` は `run` のエイリアスとして同等のエラー/終了コードになる
- Core IPC: stdout（または socket）には JSON Lines のみ、ログは stderr
- supervised transport: `ROBOPPI_SUPERVISED_IPC_TRANSPORT` の解決
- compiled 時の Core 起動: Core entrypoint が `process.execPath`（=同一バイナリ）でも動作する
- OOM 対策: `BUN_FLAGS=--smol`（ビルド/テスト時）、`BUN_BUILD_FLAGS=--compile-exec-argv=--smol`（compiled の子 Core）

## 7. テストケース

### TC-CLI-01: ルート help
- コマンド: `bun run src/cli.ts --help`
- 期待: Usage に `run`/`workflow`/`daemon`/`agent` が表示される、exit code = 0

### TC-CLI-02: workflow help
- コマンド: `bun run src/cli.ts workflow --help`
- 期待: `roboppi workflow <workflow.yaml>` の Usage が表示される、exit code = 0

### TC-CLI-03: daemon help
- コマンド: `bun run src/cli.ts daemon --help`
- 期待: `roboppi daemon <daemon.yaml>` の Usage が表示される、exit code = 0

### TC-CLI-04: agent は run のエイリアス
- コマンド: `bun run src/cli.ts run` と `bun run src/cli.ts agent` をそれぞれ（必須引数なしで）実行
- 期待: 両者とも `--worker is required` エラーになり、exit code != 0

### TC-WF-01: workflow（supervised 既定）で hello-world を実行
- コマンド: `bun run src/cli.ts workflow examples/hello-world.yaml --verbose`
- 期待:
  - exit code = 0
  - 結果に `PASS  greet` が含まれる

### TC-WF-02: workflow（direct）で hello-world を実行
- コマンド: `bun run src/cli.ts workflow examples/hello-world.yaml --direct --verbose`
- 期待:
  - exit code = 0
  - 結果に `PASS  greet` が含まれる

### TC-DMN-01: daemon を短時間起動して即停止できる
- コマンド（Linux）:
  - `timeout 2s bun run src/cli.ts daemon examples/daemon/simple-cron.yaml --workspace examples/daemon --direct --verbose`
- 期待:
  - パース/起動ログが出る（例: `Event loop started`）
  - 例外で落ちない

### TC-SRV-01: Core IPC server の最低限の健全性
- 手順:
  1) `bun run src/cli.ts` をサブプロセスとして起動（stdin/stdout を pipe）
  2) `submit_job` を JSONL で投入
  3) `ack`（または `error`）が JSONL で返ることを確認
- 期待:
  - stdout に非 JSON が混入しない
  - exit code が異常終了しない

### TC-BIN-01: compiled バイナリで workflow が動く（任意）
- コマンド:
  - `make clean && make build`
  - `./roboppi workflow examples/hello-world.yaml --verbose`
- 期待: exit code = 0

### TC-MEM-01: 低メモリ向けビルド（任意/再現時）
- コマンド:
  - `make clean && make build BUN_FLAGS=--smol`
- 期待: `RangeError: Out of memory` を回避してビルドが完了する

### TC-MEM-02: compiled の子 Core を smol で動かす（任意/再現時）
- コマンド:
  - `make clean && make build BUN_BUILD_FLAGS=--compile-exec-argv=--smol`
  - `./roboppi workflow examples/hello-world.yaml --verbose`
- 期待: supervised 実行が `Out of memory` で停止しない

## 8. 実行方法（まとめ）
- 自動（推奨）: `make test-all`
- 変更点（CLI 統合）を重点確認: `bun run src/cli.ts workflow examples/hello-world.yaml --verbose`
- compiled E2E: `make build && ./roboppi workflow examples/hello-world.yaml --verbose`
