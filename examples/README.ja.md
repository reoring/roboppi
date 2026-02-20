# Examples（例）

このディレクトリには、Roboppi の workflow / daemon を動かすための設定例（YAML）が入っています。

## 前提条件

- `bun`
- （例によっては必要）worker CLI: `opencode` / `claude` / `codex`

## workflow を実行する

```bash
./roboppi workflow examples/hello-world.yaml --verbose
# (dev)
bun run src/workflow/run.ts examples/hello-world.yaml --verbose
```

補足:

- workflow runner はデフォルトで supervised（Supervisor -> Core -> Worker）で実行します。
- Core IPC を使わずに直接 worker を起動する場合は `--direct` を使います。

## daemon を実行する

```bash
./roboppi daemon examples/daemon/simple-cron.yaml --verbose
# (dev)
bun run src/daemon/cli.ts examples/daemon/simple-cron.yaml --verbose
```

停止は `Ctrl+C`（graceful shutdown）です。短時間だけ動作確認するなら `timeout` が便利です:

```bash
timeout 10s ./roboppi daemon examples/daemon/simple-cron.yaml --verbose
```

## workflow の例

- `examples/hello-world.yaml`: 最小の 1 ステップ workflow
- `examples/build-test-report.yaml`: build -> test（並列）-> report
- `examples/failure-recovery.yaml`: 失敗時の挙動（retry/continue など）
- `examples/todo-loop.yaml`: 反復ループの最小パターン
- `examples/agent-pr-loop.yaml`: 大きめのエージェントループ（デモは `examples/agent-pr-loop-demo/`）
- `examples/appthrust-dashboard/workflow.yaml`: チームプロジェクト向けの本番ワークフロー（design -> todo -> implement -> validate）

## daemon の例

- `examples/daemon/simple-cron.yaml`: interval イベント -> workflow
- `examples/daemon/smart-reviewer.yaml`: cron + `evaluate`（実行ゲート）+ `analyze`（要約）
- `examples/daemon/multi-trigger.yaml`: interval + cron + command の複合
- `examples/daemon/file-watcher.yaml`: fswatch の例（設定リファレンス；実装は planned）

### ディレクトリを 1 分ごとに精査してレポートする

設定:

- `examples/daemon/dir-scan-report.yaml`
- `examples/daemon/workflows/dir-scan-report.yaml`

実行:

```bash
ROBOPPI_ROOT="$PWD" \
SCAN_DIR="$ROBOPPI_ROOT/docs" \
REPORT_DIR=/tmp/roboppi-dir-scan-report \
./roboppi daemon examples/daemon/dir-scan-report.yaml --verbose
```

出力:

- `$REPORT_DIR/latest.md`: 人向けの要約
- `$REPORT_DIR/latest.json`: 機械読み用の JSON
- `$REPORT_DIR/last-snapshot.json`: 前回スナップショット（差分検出に使用）

調整用の環境変数:

- `SCAN_MAX_ENTRIES`（デフォルト: `20000`）
- `SCAN_TOP_N`（デフォルト: `20`）
- `SCAN_IGNORE`（デフォルト: `.git,node_modules,.daemon-state`）
