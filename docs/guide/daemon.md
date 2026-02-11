# Daemon ガイド

Daemon（デーモン）は AgentCore の常駐プロセスです。イベントソースを監視し、条件を満たしたときにワークフローを自動実行します。cron スケジュール、ファイル変更、Webhook、外部コマンドなど、さまざまなイベントに反応して動作します。

## 目次

- [ユースケース](#ユースケース)
- [最小構成で始める](#最小構成で始める)
- [YAML スキーマ](#yaml-スキーマ)
- [イベントソース](#イベントソース)
  - [interval — 固定間隔](#interval--固定間隔)
  - [cron — cron 式スケジュール](#cron--cron-式スケジュール)
  - [fswatch — ファイル変更検知](#fswatch--ファイル変更検知)
  - [webhook — HTTP Webhook](#webhook--http-webhook)
  - [command — 外部コマンド実行](#command--外部コマンド実行)
- [トリガー](#トリガー)
  - [基本設定](#基本設定)
  - [フィルタリング](#フィルタリング)
  - [レート制御](#レート制御)
  - [失敗ハンドリング](#失敗ハンドリング)
- [インテリジェントレイヤー](#インテリジェントレイヤー)
  - [evaluate — 実行ゲート](#evaluate--実行ゲート)
  - [analyze — 結果分析](#analyze--結果分析)
  - [テンプレート変数](#テンプレート変数)
- [コンテキスト注入](#コンテキスト注入)
- [状態管理](#状態管理)
- [CLI の使い方](#cli-の使い方)
- [実践例ウォークスルー](#実践例ウォークスルー)

---

## ユースケース

- **定期監視**: 30 秒ごとにシステムのヘルスチェックを実行する
- **自動テスト**: ソースファイルの変更を検知して自動テストを走らせる
- **インテリジェントレビュー**: 新しいコミットがあるときだけ LLM にコードレビューを依頼する
- **Webhook 連携**: GitHub の Push イベントを受け取り CI パイプラインを起動する
- **外部 API 監視**: API の状態変化を検知してアラートワークフローを実行する

---

## 最小構成で始める

最もシンプルな Daemon は、interval イベントとワークフロー 1 つだけで構成できます。

```yaml
# my-daemon.yaml
name: my-first-daemon
version: "1"

workspace: "/tmp/my-daemon"
state_dir: "/tmp/my-daemon/.daemon-state"

events:
  tick:
    type: interval
    every: "30s"

triggers:
  health:
    on: tick
    workflow: ./workflows/health-check.yaml
    on_workflow_failure: ignore
```

起動:

```bash
bun run src/daemon/cli.ts my-daemon.yaml --verbose
```

出力:

```
Daemon: my-first-daemon
Events: 1
Triggers: 1

[daemon] Event loop started, waiting for events...
[daemon] Event received: tick (interval)
[daemon] Workflow completed: SUCCEEDED
```

`Ctrl+C` で安全に停止します（Graceful Shutdown）。

---

## YAML スキーマ

Daemon の設定は 1 つの YAML ファイルで完結します。

```yaml
name: string                        # Daemon 名（識別用）
version: "1"                        # スキーマバージョン（現在は "1" 固定）
description?: string                # 説明文

workspace: string                   # 作業ディレクトリ（全トリガー共通）
log_dir?: string                    # ログ出力先（デフォルト: ./logs）
state_dir?: string                  # 状態保存先（デフォルト: <workspace>/.daemon-state）
max_concurrent_workflows?: number   # 同時実行ワークフロー数の上限（デフォルト: 5）

events:                             # イベントソース定義
  <event_id>:
    type: cron | interval | fswatch | webhook | command
    ...

triggers:                           # トリガー定義（イベント → ワークフロー）
  <trigger_id>:
    on: <event_id>
    workflow: <path>
    ...
```

### トップレベルフィールド

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `name` | Yes | Daemon の識別名 |
| `version` | Yes | `"1"` 固定 |
| `description` | No | 説明文 |
| `workspace` | Yes | ワークフロー実行時の作業ディレクトリ |
| `log_dir` | No | ログ出力先ディレクトリ |
| `state_dir` | No | 実行状態の保存先 |
| `max_concurrent_workflows` | No | 同時に実行するワークフローの上限（デフォルト: 5） |
| `events` | Yes | イベントソースの定義（1 つ以上） |
| `triggers` | Yes | トリガーの定義（1 つ以上） |

---

## イベントソース

Daemon は 5 種類のイベントソースをサポートします。`events` セクションで定義し、`triggers` の `on` フィールドで参照します。

### interval — 固定間隔

最もシンプルなイベントソース。指定した間隔で定期的にイベントを発火します。

```yaml
events:
  tick:
    type: interval
    every: "30s"      # 30 秒ごと
```

`every` には DurationString を指定します。使用可能な形式:

| 形式 | 例 | 意味 |
|------|----|----|
| `Nms` | `"200ms"` | 200 ミリ秒 |
| `Ns` | `"30s"` | 30 秒 |
| `Nm` | `"5m"` | 5 分 |
| `Nh` | `"1h"` | 1 時間 |

発火するペイロード:

```json
{
  "type": "interval",
  "firedAt": 1705312200000
}
```

### cron — cron 式スケジュール

標準的な cron 式でスケジュールを指定します。

```yaml
events:
  every-5min:
    type: cron
    schedule: "*/5 * * * *"     # 5 分ごと

  daily-morning:
    type: cron
    schedule: "0 9 * * *"       # 毎朝 9 時

  weekday-night:
    type: cron
    schedule: "0 22 * * 1-5"    # 平日 22 時
```

cron 式のフォーマット:

```
┌───────────── 分 (0-59)
│ ┌───────────── 時 (0-23)
│ │ ┌───────────── 日 (1-31)
│ │ │ ┌───────────── 月 (1-12)
│ │ │ │ ┌───────────── 曜日 (0-7, 0・7 = 日曜)
│ │ │ │ │
* * * * *
```

発火するペイロード:

```json
{
  "type": "cron",
  "schedule": "*/5 * * * *",
  "firedAt": 1705312200000
}
```

### fswatch — ファイル変更検知

ファイルシステムの変更を監視します。glob パターンでファイルを指定し、変更があったときにイベントを発火します。

```yaml
events:
  src-change:
    type: fswatch
    paths:                        # 監視対象（glob パターン）
      - "src/**/*.ts"
      - "src/**/*.tsx"
    ignore:                       # 除外パターン（任意）
      - "**/*.test.ts"
      - "**/*.spec.ts"
      - "**/node_modules/**"
      - "**/dist/**"
    events: [create, modify]      # 監視するイベント種別（任意）
```

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `paths` | Yes | 監視対象の glob パターン配列 |
| `ignore` | No | 除外パターン配列 |
| `events` | No | `create`, `modify`, `delete` の組み合わせ。省略時は全て |

短時間に大量の変更が発生した場合、200ms のウィンドウでバッチ化されて 1 つのイベントとして発火します。

発火するペイロード:

```json
{
  "type": "fswatch",
  "changes": [
    { "path": "src/index.ts", "event": "modify" },
    { "path": "src/utils.ts", "event": "create" }
  ]
}
```

### webhook — HTTP Webhook

HTTP エンドポイントで外部からのイベントを受信します。Daemon 内の全 Webhook ソースで 1 つの HTTP サーバーを共有します。

```yaml
events:
  github-push:
    type: webhook
    path: "/hooks/github"         # エンドポイントパス
    port: 8080                    # リッスンポート（任意、デフォルト: 8080）
    secret: "${GITHUB_WEBHOOK_SECRET}"  # HMAC-SHA256 署名検証キー（任意）
    method: "POST"                # HTTP メソッド（任意、デフォルト: POST）
```

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `path` | Yes | URL パス（例: `/hooks/github`） |
| `port` | No | リッスンポート（デフォルト: 8080） |
| `secret` | No | HMAC-SHA256 署名検証キー。`${ENV_VAR}` 形式で環境変数を参照可能 |
| `method` | No | 許可する HTTP メソッド（デフォルト: `POST`） |

`secret` を設定すると、`X-Hub-Signature-256` ヘッダーを使って HMAC-SHA256 署名を検証します。検証に失敗したリクエストは拒否されます。

発火するペイロード:

```json
{
  "type": "webhook",
  "method": "POST",
  "path": "/hooks/github",
  "headers": { "content-type": "application/json", "x-github-event": "push" },
  "body": { "ref": "refs/heads/main", "commits": [...] }
}
```

### command — 外部コマンド実行

外部コマンドを定期実行し、その結果（または変化）をイベントとして発火します。

```yaml
events:
  api-status:
    type: command
    command: "curl -s -o /dev/null -w '%{http_code}' https://api.example.com/health"
    interval: "1m"                # 実行間隔
    trigger_on: change            # change | always
```

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `command` | Yes | 実行するシェルコマンド |
| `interval` | Yes | コマンドの実行間隔（DurationString） |
| `trigger_on` | No | `change` = 前回と出力が変わったとき発火（デフォルト）、`always` = 毎回発火 |

`trigger_on: change` の場合、初回実行は比較対象がないため発火しません。2 回目以降、前回の stdout と異なる場合にイベントが発火します。

発火するペイロード:

```json
{
  "type": "command",
  "stdout": "200",
  "exitCode": 0,
  "changed": true
}
```

---

## トリガー

トリガーはイベントとワークフローを結びつけます。フィルタリング、レート制御、失敗ハンドリングを設定できます。

### 基本設定

```yaml
triggers:
  auto-test:
    on: src-change                # 紐づけるイベント ID
    workflow: ./workflows/test.yaml  # 実行するワークフロー YAML パス
    enabled: true                 # 有効/無効（デフォルト: true）
```

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `on` | Yes | イベント ID（`events` セクションのキー） |
| `workflow` | Yes | ワークフロー YAML のパス（workspace からの相対パス） |
| `enabled` | No | `false` でトリガーを無効化（デフォルト: `true`） |

### フィルタリング

`filter` でイベントペイロードに対する条件を指定します。すべての条件を満たしたときだけワークフローを実行します。

```yaml
triggers:
  pr-check:
    on: github-push
    workflow: ./workflows/ci.yaml
    filter:
      # 単純一致: 値が等しい
      action: "opened"

      # ドット記法: ネストしたフィールドにアクセス
      pull_request.base.ref: "main"

      # 正規表現: パターンにマッチ
      ref:
        pattern: "^refs/heads/(main|develop)$"

      # リスト: いずれかの値に一致
      sender.login:
        in: ["user-a", "user-b", "bot-ci"]
```

フィルタ条件の種類:

| 形式 | 例 | 意味 |
|------|----|----|
| 単純一致 | `action: "opened"` | 値が一致する |
| 正規表現 | `ref: { pattern: "^refs/heads/main$" }` | 正規表現にマッチする |
| リスト | `login: { in: ["a", "b"] }` | リスト内のいずれかの値に一致する |

ドット記法（`pull_request.base.ref` など）でネストしたオブジェクトのフィールドにアクセスできます。

### レート制御

イベントの発火頻度を制御します。

```yaml
triggers:
  auto-test:
    on: src-change
    workflow: ./workflows/test.yaml
    debounce: "5s"       # 連続イベントを抑制（最後のイベントから 5 秒待つ）
    cooldown: "30s"      # ワークフロー完了後 30 秒は再実行しない
    max_queue: 5         # 未実行キューの上限（超過分は破棄、デフォルト: 10）
```

| フィールド | 説明 |
|-----------|------|
| `debounce` | 前回のイベントから指定時間が経過するまで新しいイベントを無視 |
| `cooldown` | ワークフロー完了後、指定時間が経過するまで再実行しない |
| `max_queue` | 実行待ちキューの上限。超過分は古い方から破棄 |

`debounce` はファイル変更の連続イベントを集約するのに便利です。`cooldown` はワークフロー完了後の再実行を防ぐために使います。

### 失敗ハンドリング

ワークフローが失敗したときの挙動を指定します。

```yaml
triggers:
  ci-check:
    on: github-push
    workflow: ./workflows/ci.yaml
    on_workflow_failure: retry     # ignore | retry | pause_trigger
    max_retries: 2                # retry 時の最大回数（デフォルト: 3）
```

| 値 | 意味 |
|----|------|
| `ignore` | 失敗を無視して次のイベントを待つ |
| `retry` | `max_retries` 回まで再実行する |
| `pause_trigger` | 連続失敗が `max_retries` 回に達したらトリガーを一時停止する |

---

## インテリジェントレイヤー

Daemon の特徴的な機能として、LLM やシェルスクリプトによるインテリジェントな判断を組み込めます。

### evaluate -- 実行ゲート

ワークフローを実行する前に「本当に実行すべきか」を判断するゲートです。

```yaml
triggers:
  code-review:
    on: periodic
    workflow: ./workflows/review.yaml

    evaluate:
      worker: CUSTOM              # CUSTOM | CLAUDE_CODE | CODEX_CLI | OPENCODE
      instructions: |
        cd {{workspace}} 2>/dev/null || exit 1
        CURRENT=$(git rev-parse HEAD 2>/dev/null || echo "none")
        LAST=$(cat ".daemon-state/.last-review-commit" 2>/dev/null || echo "")
        if [ "$CURRENT" = "$LAST" ]; then
          exit 1    # スキップ
        else
          mkdir -p .daemon-state
          echo "$CURRENT" > ".daemon-state/.last-review-commit"
          exit 0    # 実行
        fi
      capabilities: [READ, RUN_COMMANDS]
      timeout: "15s"
```

#### worker 種別ごとの判定方法

| worker | 判定方法 |
|--------|---------|
| `CUSTOM` | シェルスクリプトとして実行。exit 0 = 実行、exit 1 = スキップ |
| `CLAUDE_CODE` | Claude Code CLI を起動。出力に "run" を含めば実行、"skip" を含めばスキップ |
| `CODEX_CLI` | Codex CLI を起動。判定は CLAUDE_CODE と同じ |
| `OPENCODE` | OpenCode CLI を起動。判定は CLAUDE_CODE と同じ |

LLM Worker（CLAUDE_CODE 等）の場合、出力の最後の非空行を見て判定します。"run" も "skip" も含まない場合は安全側に倒してスキップします。

#### evaluate のフィールド

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `worker` | Yes | Worker 種別 |
| `instructions` | Yes | 実行する指示（テンプレート変数使用可能） |
| `capabilities` | Yes | 必要な権限 |
| `timeout` | No | タイムアウト（デフォルト: `"30s"`） |

### analyze -- 結果分析

ワークフロー完了後に結果を分析し、レポートやサマリーを生成します。

```yaml
triggers:
  code-review:
    on: periodic
    workflow: ./workflows/review.yaml

    analyze:
      worker: CUSTOM
      instructions: |
        echo "=== Review Summary ===" > summary.md
        echo "Status: {{workflow_status}}" >> summary.md
        echo "Time: $(date)" >> summary.md
        cat summary.md
      capabilities: [READ, EDIT]
      timeout: "30s"
      outputs:
        - name: review-summary
          path: summary.md
```

| フィールド | 必須 | 説明 |
|-----------|------|------|
| `worker` | Yes | Worker 種別 |
| `instructions` | Yes | 分析の指示（テンプレート変数使用可能） |
| `capabilities` | Yes | 必要な権限 |
| `timeout` | No | タイムアウト（デフォルト: `"2m"`） |
| `outputs` | No | 分析結果の出力先ファイル定義 |

`analyze` はワークフローが `SUCCEEDED` で完了したときに実行されます。Worker はワークフローの `context/` ディレクトリにアクセスでき、各ステップの実行結果を参照できます。

### テンプレート変数

`evaluate` と `analyze` の `instructions` 内で `{{変数名}}` 形式のテンプレート変数を使用できます。

| 変数 | 説明 | 使用可能箇所 |
|------|------|-------------|
| `{{event}}` | イベントペイロード（JSON 文字列） | evaluate, analyze |
| `{{event.type}}` | イベント種別 | evaluate, analyze |
| `{{last_result}}` | 前回実行結果（JSON 文字列） | evaluate |
| `{{last_result.status}}` | 前回のステータス | evaluate |
| `{{timestamp}}` | 現在時刻（ISO 8601 形式） | evaluate, analyze |
| `{{trigger_id}}` | トリガー ID | evaluate, analyze |
| `{{workspace}}` | 作業ディレクトリのパス | evaluate |
| `{{execution_count}}` | このトリガーの累計実行回数 | evaluate, analyze |
| `{{workflow_status}}` | ワークフロー実行結果ステータス | analyze |
| `{{steps}}` | 各ステップの実行結果（JSON） | analyze |
| `{{context_dir}}` | コンテキストディレクトリパス | analyze |

ドット記法でネストしたフィールドにアクセスできます:

```yaml
instructions: |
  イベント種別: {{event.type}}
  前回のステータス: {{last_result.status}}
```

テンプレートエンジンは `{{key}}` 形式のプレースホルダーを解決します。解決順:

1. 完全キー一致（`vars["event.type"]` に直接マッチ）
2. ドット記法による JSON パス走査（`vars["event"]` を JSON パースして `.type` にアクセス）
3. 未解決の場合はそのまま残す（`{{unknown_var}}`）

---

## コンテキスト注入

トリガーの `context` セクションで、ワークフローに追加情報を渡せます。

```yaml
triggers:
  review:
    on: periodic
    workflow: ./workflows/review.yaml
    context:
      env:                        # 環境変数を設定
        REVIEW_MODE: "strict"
        TARGET_BRANCH: "main"
      last_result: true           # 前回実行結果を注入
      event_payload: true         # イベントペイロードを注入
```

### env -- 環境変数

ワークフロー実行時に指定した環境変数が `process.env` に設定されます。ワークフロー完了後に元の値に復元されます。

### last_result -- 前回実行結果

`true` にすると、前回のワークフロー実行結果が `.daemon-context/last-result.json` に書き出されます。ワークフロー内のステップからこのファイルを読み取れます。

```json
// .daemon-context/last-result.json
{
  "workflowId": "review-1705312200000",
  "name": "code-review",
  "status": "SUCCEEDED",
  "steps": { ... },
  "startedAt": 1705312200000,
  "completedAt": 1705312260000
}
```

### event_payload -- イベントペイロード

`true` にすると、トリガーの発火原因となったイベントのペイロードが `.daemon-context/event.json` に書き出されます。

```json
// .daemon-context/event.json
{
  "type": "cron",
  "schedule": "*/5 * * * *",
  "firedAt": 1705312200000
}
```

---

## 状態管理

Daemon は `state_dir`（デフォルト: `<workspace>/.daemon-state`）にファイルベースで状態を永続化します。

### ディレクトリ構造

```
.daemon-state/
├── daemon.json                  # Daemon メタ情報（PID, 起動時刻, 状態）
└── triggers/
    ├── auto-test/
    │   ├── state.json           # enabled, lastFiredAt, cooldownUntil, executionCount
    │   ├── last-result.json     # 最後のワークフロー実行結果
    │   └── history/
    │       ├── 1705312200000.json
    │       └── 1705312500000.json
    └── periodic-review/
        ├── state.json
        ├── last-result.json
        └── history/
            └── ...
```

### daemon.json

```json
{
  "pid": 12345,
  "startedAt": 1705312200000,
  "configName": "my-daemon",
  "status": "running"
}
```

### triggers/\<id\>/state.json

```json
{
  "enabled": true,
  "lastFiredAt": 1705312200000,
  "cooldownUntil": null,
  "executionCount": 42,
  "consecutiveFailures": 0
}
```

`consecutiveFailures` は `on_workflow_failure: pause_trigger` と組み合わせて使います。連続失敗が `max_retries` 回に達すると `enabled` が `false` に切り替わります。

### triggers/\<id\>/history/

実行履歴は `<completedAt>.json` ファイルとして保存されます。各ファイルにはイベント情報、ワークフロー実行結果、タイムスタンプが含まれます。

---

## CLI の使い方

### Daemon の起動

```bash
bun run src/daemon/cli.ts <daemon.yaml> [オプション]
```

| オプション | 説明 |
|-----------|------|
| `--workspace`, `-w` | `workspace` を CLI で上書きする（起動ディレクトリに依存させたくない場合に便利） |
| `--verbose`, `-v` | 詳細ログを有効にする |
| `--help`, `-h` | ヘルプを表示 |

補足:

- `command` イベントのコマンド実行ディレクトリ（cwd）と `fswatch.paths` の相対パス解決は `workspace` を基準に行われます。
- `workspace` / `state_dir` / `log_dir` / `triggers.*.workflow` では `${ENV_VAR}` 形式の環境変数展開が利用できます（未設定の場合は起動時にエラー）。

例:

```bash
# 基本的な起動
bun run src/daemon/cli.ts my-daemon.yaml

# 詳細ログ付きで起動
bun run src/daemon/cli.ts my-daemon.yaml --verbose
```

### 停止

`Ctrl+C`（SIGINT）または `SIGTERM` を送信すると、Daemon は Graceful Shutdown を行います:

1. 新規イベントの受信を停止
2. 全イベントソースを停止
3. 実行中のワークフローの完了を待機（30 秒タイムアウト）
4. Webhook サーバーを停止
5. 状態をフラッシュして終了

---

## 実践例ウォークスルー

`examples/daemon/` ディレクトリにサンプル設定が用意されています。

### 例 1: シンプルな定期実行（simple-cron.yaml）

30 秒ごとにヘルスチェックワークフローを実行する最小構成です。

```yaml
name: simple-cron
version: "1"
description: "30 秒ごとにヘルスチェックを実行するシンプルな daemon"

workspace: "/tmp/agentcore-daemon-simple"
state_dir: "/tmp/agentcore-daemon-simple/.daemon-state"

events:
  tick:
    type: interval
    every: "30s"

triggers:
  health-check:
    on: tick
    workflow: ./workflows/health-check.yaml
    on_workflow_failure: ignore
```

実行:

```bash
bun run src/daemon/cli.ts examples/daemon/simple-cron.yaml --verbose
```

ヘルスチェックのワークフロー（`workflows/health-check.yaml`）はディスク使用量、メモリ、ロードアベレージを確認する 1 ステップのワークフローです。

### 例 2: LLM ゲート付きスマートレビュー（smart-reviewer.yaml）

5 分ごとに cron で発火し、evaluate ゲートで「新しいコミットがあるかどうか」をシェルスクリプトで判定します。新しいコミットがある場合だけレビューワークフローを実行し、完了後に analyze で結果サマリーを生成します。

```yaml
name: smart-reviewer
version: "1"
workspace: "/tmp/agentcore-daemon-reviewer"
state_dir: "/tmp/agentcore-daemon-reviewer/.daemon-state"
max_concurrent_workflows: 1

events:
  periodic:
    type: cron
    schedule: "*/5 * * * *"

triggers:
  code-review:
    on: periodic
    workflow: ./workflows/code-review.yaml
    cooldown: "5m"

    evaluate:
      worker: CUSTOM
      instructions: |
        cd {{workspace}} 2>/dev/null || exit 1
        git rev-parse --git-dir > /dev/null 2>&1 || exit 1

        MARKER=".daemon-state/.last-review-commit"
        CURRENT=$(git rev-parse HEAD 2>/dev/null || echo "none")
        LAST=$(cat "$MARKER" 2>/dev/null || echo "")

        if [ "$CURRENT" = "$LAST" ]; then
          exit 1    # 新しいコミットなし → スキップ
        else
          mkdir -p .daemon-state
          echo "$CURRENT" > "$MARKER"
          exit 0    # 新しいコミットあり → 実行
        fi
      capabilities: [READ, RUN_COMMANDS]
      timeout: "15s"

    context:
      last_result: true

    analyze:
      worker: CUSTOM
      instructions: |
        echo "=== Review Summary ===" > summary.md
        echo "Status: {{workflow_status}}" >> summary.md
        echo "Time: $(date)" >> summary.md
        cat summary.md
      capabilities: [READ, EDIT]
      timeout: "30s"
      outputs:
        - name: review-summary
          path: summary.md
```

ポイント:

- `evaluate` の `worker: CUSTOM` でシェルスクリプトによる条件判定
- `{{workspace}}` テンプレート変数で作業ディレクトリを参照
- `context.last_result: true` で前回結果をワークフローに渡す
- `analyze` でレビュー結果のサマリーを自動生成

### 例 3: ファイル変更検知（file-watcher.yaml）

TypeScript ファイルの変更を検知して自動テストを実行します。

```yaml
name: file-watcher
version: "1"
workspace: "/tmp/agentcore-daemon-watcher"
state_dir: "/tmp/agentcore-daemon-watcher/.daemon-state"

events:
  src-change:
    type: fswatch
    paths:
      - "src/**/*.ts"
      - "src/**/*.tsx"
    ignore:
      - "**/*.test.ts"
      - "**/*.spec.ts"
      - "**/node_modules/**"
      - "**/dist/**"
    events: [create, modify]

triggers:
  auto-test:
    on: src-change
    workflow: ./workflows/test-suite.yaml
    debounce: "5s"
    cooldown: "30s"
    on_workflow_failure: ignore
```

ポイント:

- `debounce: "5s"` で連続的なファイル保存イベントを集約
- `cooldown: "30s"` でテスト完了後 30 秒間は再実行を抑制
- テスト失敗は `ignore` して次の変更を待つ

### 例 4: 複数イベント + 複数トリガー（multi-trigger.yaml）

interval、cron、command の 3 つのイベントソースを使い、異なるワークフローを条件付きで起動する構成です。

```yaml
name: multi-trigger
version: "1"
workspace: "/tmp/agentcore-daemon-multi"
state_dir: "/tmp/agentcore-daemon-multi/.daemon-state"
max_concurrent_workflows: 2

events:
  heartbeat:
    type: interval
    every: "30s"

  hourly:
    type: cron
    schedule: "0 * * * *"

  api-status:
    type: command
    command: "curl -s -o /dev/null -w '%{http_code}' https://httpbin.org/status/200"
    interval: "1m"
    trigger_on: change

triggers:
  # ハートビート → ヘルスチェック
  health:
    on: heartbeat
    workflow: ./workflows/health-check.yaml
    on_workflow_failure: ignore

  # 毎時 → evaluate 付きレビュー
  hourly-review:
    on: hourly
    workflow: ./workflows/code-review.yaml
    cooldown: "30m"
    evaluate:
      worker: CUSTOM
      instructions: |
        if git rev-parse --git-dir > /dev/null 2>&1; then
          RECENT=$(git log --since="1 hour ago" --oneline 2>/dev/null | wc -l)
          if [ "$RECENT" -gt 0 ]; then
            exit 0
          fi
        fi
        exit 1
      capabilities: [READ, RUN_COMMANDS]
      timeout: "10s"
    context:
      last_result: true
      event_payload: true

  # API 状態変化 → テスト実行
  api-change:
    on: api-status
    workflow: ./workflows/test-suite.yaml
    debounce: "30s"
    cooldown: "5m"
    max_retries: 1
    on_workflow_failure: retry
```

ポイント:

- `max_concurrent_workflows: 2` で同時実行を 2 つまでに制限
- 3 種類のイベントソースがそれぞれ異なるトリガーに紐づく
- `command` ソースの `trigger_on: change` で API レスポンスの変化だけを検知
- トリガーごとに異なる失敗ハンドリング（`ignore` / `retry`）

---

## 次のステップ

- ワークフローの書き方は [`docs/guide/workflow.md`](./workflow.md) を参照
- 設計の詳細は [`docs/daemon-design.md`](../daemon-design.md) を参照
- サンプル設定は `examples/daemon/` ディレクトリにあります
