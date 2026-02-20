# Roboppi

[English](README.md) | 日本語

Roboppi（ろぼっぴ）は、エージェント（worker）の実行を安全に制御するための「実行制御ランタイム」です。

Roboppi 自身が「エージェントとして仕事をする」ことは目的にしません。外部の worker CLI（OpenCode / Claude Code / Codex CLI / シェル）に重い作業（編集/コマンド/テスト）を委譲し、Roboppi は安全の不変条件（止める/制限する/観測する/隔離する）を強制します。

注意: 主な CLI/バイナリ名は `roboppi` です。
- 環境変数/状態ディレクトリ: `ROBOPPI_` / `.roboppi-loop/` を使います。

## Roboppiでできること（Capabilities）

実行制御（Core ランタイム）:

- ハードな予算制約: timeout / max attempts / concurrency / RPS /（任意で）cost cap
- エンドツーエンドのキャンセル: Job -> Permit -> Worker を AbortSignal で伝播（best-effort で SIGTERM -> SIGKILL）
- 失敗の封じ込め: circuit breaker + backpressure（過負荷時の reject/defer/degrade）
- プロセス隔離: heavy work を別プロセスに委譲して blast radius を限定
- 監査性: 構造化ログ + アーティファクト（stdout/stderr の要約、diff/patch、実行コマンド、時間など）

ワークフロー（YAML オーケストレーション）:

- 複数ステップの DAG 実行（`depends_on`）と並列度制御（`concurrency`）
- `context/` を使ったファイルベースの成果物受け渡し（`outputs` / `inputs`）
- 失敗ポリシー（`retry` / `continue` / `abort`）と自動リトライ
- `completion_check` + `max_iterations` による「完了するまでループ」
- （任意）ループ収束ガード: 停滞検知 + スコープ/差分予算（`allowed_paths`, `max_changed_files`）

自動化（Daemon モード）:

- interval/cron/fswatch/webhook/command のイベントで workflow を常駐実行
- evaluate/analyze ゲート（条件成立時だけ LLM/worker を走らせる）
- supervised 実行: Supervisor -> Core -> Worker のプロセスツリーを IPC で維持（socket transport あり）

リポジトリ安全（git workspace）:

- base branch の決定を固定化し、起動時 SHA を記録（追跡/再現性）
- Branch Lock: 実行中の repo/branch ドリフトを step 実行前に fail-fast
- Protected branch guard: `main` などへの直接編集をデフォルトでブロック（明示 override が必要）

拡張性:

- `WorkerAdapter` インタフェースで worker を追加
- agent catalog（`agents.yaml`）で `step.agent` による再利用プロファイル

スケジューリング（参照実装）:

- 優先度付きジョブキュー（interactive vs batch）
- idempotency key による重複制御（`coalesce` / `latest-wins` / `reject`）
- リトライポリシー（指数バックオフ + jitter）と DLQ
- Core を起動/監視する Supervisor（クラッシュ/ハング対策）

## アーキテクチャ（概要）

Roboppi は 3 層構造として設計されています。

```
Supervisor / Runner（policy, 親プロセス）
  -> Core（mechanism, 子プロセス）
      -> Worker プロセス（外部 CLI）
```

- Core が安全の不変条件（permits, budgets, cancellation, cutoffs）を保持します。
- policy（順序、リトライ、重複制御など）は Supervisor/Runner 側に寄せて差し替え可能にします。
- Core と Supervisor は JSON Lines IPC で通信します。

設計資料:

- `docs/design.md`
- `docs/guide/architecture.md`

## インストール

前提:

- Bun（CI は Bun 1.3.8）

任意（委譲したい worker に応じて）:

- OpenCode: `opencode`
- Claude Code: `claude`
- Codex CLI: `codex`
- （デモで PR 作成する場合）`gh`

依存インストール:

```bash
bun install
```

バイナリをビルド（任意）:

```bash
make build
./roboppi --help
./roboppi workflow --help
./roboppi daemon --help
```

## クイックスタート

### 0) IPC サーバーモード（`roboppi`）

JSON Lines IPC サーバーを起動します（stdin を読み、stdout に応答。ログは stderr）。

```bash
./roboppi
```

自前の Supervisor/Scheduler を作る場合、この Core プロセスに対して IPC を話します。

### 1) one-shot 実行（`roboppi run`）

1 回の worker タスクを、timeout/budget 付きで委譲します。

```bash
./roboppi run --worker opencode --workspace /tmp/demo \
  --capabilities READ,EDIT --timeout 60000 \
  "Write a README for this repo"
```

### 2) workflow YAML を実行する

workflow runner で実行します。デフォルトは supervised 実行（Core IPC 経由）です。
Core を介さず runner が直接 worker を spawn する場合は `--direct` を使います。

```bash
./roboppi workflow examples/hello-world.yaml --verbose
# (dev) bun run src/workflow/run.ts examples/hello-world.yaml --verbose
```

```bash
ROBOPPI_VERBOSE=1 bun run src/workflow/run.ts examples/agent-pr-loop.yaml \
  --workspace /tmp/my-work --verbose
```

ドキュメント:

- `docs/guide/workflow.md`
- `docs/workflow-design.md`

### 3) daemon モード（常駐実行）

```bash
./roboppi daemon examples/daemon/agent-pr-loop.yaml --verbose
# (dev) bun run src/daemon/cli.ts examples/daemon/agent-pr-loop.yaml --verbose
```

ドキュメント:

- `docs/guide/daemon.md`

### 4) Agent PR Loop デモ

`/tmp` 配下にスクラッチ git repo を作り、次のループを最後まで実行します。

`design -> todo -> (implement <-> review/fix)* -> (optional) create_pr`

```bash
bash examples/agent-pr-loop-demo/run-in-tmp.sh
```

デモの PR 作成を有効化するには、対象 repo にマーカーファイルを置きます。

```bash
touch "/path/to/target/.roboppi-loop/enable_pr"
```

自分の repo に対して実行（推奨: Roboppi 側と編集対象 workspace を分ける）:

```bash
ROBOPPI_ROOT=/path/to/roboppi
TARGET=/path/to/your/repo

mkdir -p "$TARGET/.roboppi-loop"
$EDITOR "$TARGET/.roboppi-loop/request.md"

ROBOPPI_ROOT="$ROBOPPI_ROOT" bun run --cwd "$ROBOPPI_ROOT" src/workflow/run.ts \
  "$ROBOPPI_ROOT/examples/agent-pr-loop.yaml" \
  --workspace "$TARGET" --verbose
```

注意:

- workflow は target workspace 内に `.roboppi-loop/` と `context/` を作ります（通常は gitignore 推奨）。
- PR 作成は `.roboppi-loop/enable_pr` による opt-in です。

## Workflow YAML の最小例

```yaml
name: build-test
version: "1"
timeout: "10m"

steps:
  build:
    worker: CUSTOM
    instructions: "make build"
    capabilities: [RUN_COMMANDS]

  test:
    depends_on: [build]
    worker: CUSTOM
    instructions: "make test"
    capabilities: [RUN_TESTS]
```

ループさせたい場合:

- `completion_check` + `max_iterations` を使う
- 判定は stdout 文字列より `decision_file`（ファイルベース）を推奨

詳細: `docs/guide/workflow.md`

## Agent Catalog（再利用できるエージェント定義）

同じ worker/model/capabilities/base-instructions を繰り返す場合、外部 YAML（agent catalog）にまとめられます。

```yaml
version: "1"
agents:
  research:
    worker: OPENCODE
    model: openai/gpt-5.2
    capabilities: [READ]
    base_instructions: |
      You are a research agent.
      - Only read files. Do not edit.
```

workflow から参照:

```yaml
steps:
  investigate:
    agent: research
    instructions: "Investigate the codebase and write notes."
```

ドキュメント:

- `docs/guides/agents.md`
- `docs/guides/agents.ja.md`

## ブランチ安全（git workspace）

git repo に対する workflow 実行向けに、base branch 解決 / Branch Lock / 保護ブランチガードを提供します。

便利なフラグ:

- `--base-branch <name>`（`BASE_BRANCH` を上書き）
- `--protected-branches <csv>`（既定: `main,master,release/*`）
- `--allow-protected-branch`（危険: 明示 override）

ドキュメント:

- `docs/guides/branch.md`
- `docs/guides/branch.ja.md`

## Supervised IPC transport（supervised 実行）

supervised 実行では runner/daemon が Core 子プロセスを起動し、IPC 経由で step を委譲します。

- 既定: 対話実行は stdio、非対話実行は socket transport が既定
- transport 切替: `ROBOPPI_SUPERVISED_IPC_TRANSPORT=stdio|socket|tcp`
- IPC デバッグ: `ROBOPPI_IPC_TRACE=1`
- request timeout 調整: `ROBOPPI_IPC_REQUEST_TIMEOUT=2m`（または `ROBOPPI_IPC_REQUEST_TIMEOUT_MS=120000`）

supervised 実行を無効化（direct 実行）:

- workflow runner: `--direct`
- daemon CLI: `--direct`

## ドキュメント

- `docs/guide/quickstart.md`
- `docs/guide/workflow.md`
- `docs/guide/daemon.md`
- `docs/guide/architecture.md`
- `docs/design.md`
- `docs/guides/agents.md`
- `docs/guides/branch.md`

## 開発

```bash
make typecheck
make test
make test-all
```

## ステータス

このプロジェクトは進化中で、API/挙動（CLI フラグや YAML スキーマ）は今後も改善される可能性があります。一方で設計の核（mechanism/policy 分離 + permits + プロセス隔離）は安定させる方針です。
