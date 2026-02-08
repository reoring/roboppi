# ワークフローガイド

AgentCore のワークフロー機能を使うと、複数のステップを YAML で宣言的に定義し、自動で実行できます。ステップ間の依存関係（DAG）、コンテキストの受け渡し、失敗時のリトライや継続など、実際の開発フローで必要な制御をシンプルに記述できます。

## 目次

1. [ワークフローとは](#ワークフローとは)
2. [YAML スキーマ](#yaml-スキーマ)
3. [ステップの定義](#ステップの定義)
4. [DAG による依存関係](#dag-による依存関係)
5. [コンテキストの受け渡し](#コンテキストの受け渡し)
6. [完了チェック（ループ実行）](#完了チェックループ実行)
7. [失敗ハンドリング](#失敗ハンドリング)
8. [Worker の種類](#worker-の種類)
9. [ワークフローの実行](#ワークフローの実行)
10. [サンプル解説](#サンプル解説)

---

## ワークフローとは

ワークフローは「複数のステップを順番に（または並列に）実行する」ための仕組みです。

たとえば「ビルド → テスト → レポート作成」のように、複数の作業を決まった順序で行いたい場合に使います。手動で1つずつ実行する代わりに、YAML ファイルに書いておけば AgentCore が依存関係を解決しながら自動で実行します。

**ワークフローが便利な場面:**

- 実装 → レビュー → 修正の一連の流れ
- 複数のテストスイートを並列に実行して結果を集約
- タスクリストの項目を1つずつ完了するまでループ
- 失敗したステップを自動リトライしつつ、任意のステップは失敗を無視して続行

---

## YAML スキーマ

### トップレベルの構造

```yaml
name: my-workflow          # ワークフロー名
version: "1"               # スキーマバージョン（現在は "1" 固定）
description: "説明文"       # 任意
timeout: "30m"             # ワークフロー全体のタイムアウト
concurrency: 2             # ステップの最大同時実行数（省略時は制限なし）
context_dir: "./context"   # コンテキストディレクトリ（省略時は "./context"）

steps:
  step-a:
    # ... ステップ定義
  step-b:
    # ... ステップ定義
```

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `name` | string | はい | ワークフロー名 |
| `version` | `"1"` | はい | スキーマバージョン |
| `description` | string | いいえ | 説明文 |
| `timeout` | DurationString | はい | 全体のタイムアウト（例: `"30m"`, `"2h"`） |
| `concurrency` | number | いいえ | 最大同時実行数 |
| `context_dir` | string | いいえ | コンテキストディレクトリのパス |
| `steps` | Record | はい | ステップの定義（キーがステップ ID） |

**DurationString の書き方:** `"30s"`（30秒）、`"5m"`（5分）、`"2h"`（2時間）、`"1h30m"`（1時間30分）のように指定します。

---

## ステップの定義

各ステップは `steps` の下にキー（ステップ ID）と値（定義）のペアで記述します。

```yaml
steps:
  build:
    description: "ソースコードをビルドする"
    worker: CUSTOM
    instructions: |
      mkdir -p dist
      echo 'console.log("hello")' > dist/main.js
    capabilities: [EDIT]
    timeout: "5m"
```

### ステップの全フィールド

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `description` | string | いいえ | ステップの説明 |
| `worker` | enum | はい | 使用する Worker（後述） |
| `instructions` | string | はい | Worker に渡す指示テキスト |
| `capabilities` | enum[] | はい | Worker に許可する操作 |
| `workspace` | string | いいえ | 作業ディレクトリ（デフォルト: `"."`） |
| `depends_on` | string[] | いいえ | 先行ステップ ID のリスト |
| `inputs` | InputRef[] | いいえ | 先行ステップの成果物参照 |
| `outputs` | OutputDef[] | いいえ | このステップの出力定義 |
| `timeout` | DurationString | いいえ | ステップのタイムアウト |
| `max_retries` | number | いいえ | 最大リトライ回数（デフォルト: 0） |
| `max_steps` | number | いいえ | Worker の最大ステップ数 |
| `max_command_time` | DurationString | いいえ | コマンド実行タイムアウト |
| `completion_check` | object | いいえ | 完了チェック定義（後述） |
| `max_iterations` | number | いいえ | 完了チェックループの上限（デフォルト: 1） |
| `on_iterations_exhausted` | enum | いいえ | ループ上限到達時の動作: `abort` / `continue` |
| `on_failure` | enum | いいえ | 失敗時の動作: `retry` / `continue` / `abort`（デフォルト: `abort`） |

### capabilities（権限）

Worker に許可する操作を配列で指定します。

| 値 | 意味 |
|-----|------|
| `READ` | ファイルの読み取り |
| `EDIT` | ファイルの作成・編集 |
| `RUN_TESTS` | テストの実行 |
| `RUN_COMMANDS` | 任意のコマンド実行 |

```yaml
capabilities: [READ, EDIT, RUN_TESTS]
```

---

## DAG による依存関係

`depends_on` を使うと、ステップ間の実行順序を制御できます。依存するステップが全て完了してから、そのステップが実行されます。

### 直列実行

```yaml
steps:
  build:
    worker: CUSTOM
    instructions: "ビルドする"
    capabilities: [EDIT]

  test:
    worker: CUSTOM
    depends_on: [build]          # build の完了後に実行
    instructions: "テストする"
    capabilities: [READ, RUN_TESTS]

  deploy:
    worker: CUSTOM
    depends_on: [test]           # test の完了後に実行
    instructions: "デプロイする"
    capabilities: [RUN_COMMANDS]
```

実行順: `build` → `test` → `deploy`

### 並列実行と合流

`depends_on` が同じステップを共有するステップは、並列に実行されます。複数の先行ステップを持つステップは、全ての先行ステップが完了するまで待機します。

```yaml
steps:
  build:
    worker: CUSTOM
    instructions: "ビルドする"
    capabilities: [EDIT]

  test-unit:
    depends_on: [build]           # build 後に開始
    worker: CUSTOM
    instructions: "ユニットテスト"
    capabilities: [RUN_TESTS]

  test-e2e:
    depends_on: [build]           # build 後に開始（test-unit と並列）
    worker: CUSTOM
    instructions: "E2E テスト"
    capabilities: [RUN_TESTS]

  report:
    depends_on: [test-unit, test-e2e]   # 両方の完了を待つ
    worker: CUSTOM
    instructions: "結果をまとめる"
    capabilities: [READ, EDIT]
```

DAG 構造:

```
build
  ├── test-unit  ──┐
  └── test-e2e   ──┴── report
```

`test-unit` と `test-e2e` は `build` 完了後に **同時に実行** されます。`report` は両方が終わるまで待ちます。`concurrency: 2` を設定すれば、同時に動くステップ数が最大 2 に制限されます。

---

## コンテキストの受け渡し

ステップ間でファイルを受け渡すには `outputs` と `inputs` を使います。

### outputs（成果物の定義）

ステップの実行結果としてファイルを公開します。

```yaml
outputs:
  - name: build-output       # アーティファクト名（後続ステップから参照するキー）
    path: "dist"             # ファイルまたはディレクトリのパス
    type: code               # 種別のヒント（任意）
```

### inputs（成果物の参照）

先行ステップの成果物を取り込みます。

```yaml
inputs:
  - from: build              # 参照元のステップ ID
    artifact: build-output   # outputs の name に対応
    as: build-files          # ローカルでの参照名（省略時は artifact と同じ）
```

### 実例: ビルド成果物をテストで使う

```yaml
steps:
  build:
    worker: CUSTOM
    instructions: |
      mkdir -p dist
      echo 'export function add(a, b) { return a + b; }' > dist/math.js
    capabilities: [EDIT]
    outputs:
      - name: build-output
        path: "dist"
        type: code

  test:
    worker: CUSTOM
    depends_on: [build]
    instructions: |
      # inputs で取り込んだ成果物が参照可能
      cat build-output/dist/math.js
      echo "PASS: テスト通過"
    capabilities: [READ, RUN_TESTS]
    inputs:
      - from: build
        artifact: build-output
```

### コンテキストディレクトリの構造

実行時にはワークフロー全体のコンテキストディレクトリが以下のように作成されます。

```
<workspace>/
└── context/
    ├── _workflow.json              # ワークフロー実行メタデータ
    ├── build/
    │   ├── _meta.json             # ステップの実行結果
    │   └── build-output/          # outputs で定義した成果物
    │       └── dist/math.js
    └── test/
        └── _meta.json
```

`_meta.json` にはステップの実行状態（ステータス、所要時間、試行回数など）が記録されます。

---

## 完了チェック（ループ実行）

`completion_check` を使うと、ステップの実行後に「本当に完了したか」を判定し、未完了なら再実行するループを作れます。

これは「Worker の実行自体は成功したが、目的のタスクがまだ残っている」ケースに対応します。たとえば、タスクリストの項目を1つずつ処理し、全項目が完了するまで繰り返す場合に使います。

### 基本的な書き方

```yaml
steps:
  process:
    worker: CUSTOM
    instructions: |
      # 未完了タスクを1つ処理する
      ...
    capabilities: [READ, EDIT]
    timeout: "5m"

    completion_check:
      worker: CUSTOM
      instructions: |
        # 全タスクが完了しているか確認する
        REMAINING=$(grep -c '^\- \[ \]' todo.txt || true)
        if [ "$REMAINING" -eq 0 ]; then
          exit 0   # 完了 → ループ終了
        else
          exit 1   # 未完了 → メイン Worker を再実行
        fi
      capabilities: [READ]
      timeout: "1m"

    max_iterations: 10                # 最大ループ回数
    on_iterations_exhausted: abort    # 上限到達時: abort or continue
```

### 実行フロー

```
ステップ開始 (iteration 1)
  │
  ├─→ メイン Worker 実行
  │     ├── 失敗 → on_failure ポリシーで処理
  │     └── 成功 ↓
  │
  ├─→ completion_check 実行
  │     ├── exit 0 (完了) → ステップ完了
  │     └── exit 1 (未完了) ↓
  │
  ├─→ iteration < max_iterations ?
  │     ├── Yes → iteration++ → メイン Worker を再実行
  │     └── No  → on_iterations_exhausted で処理
  │
  └─→ ステップ timeout 到達 → キャンセル
```

### retry との違い

| | `on_failure: retry` | `completion_check` ループ |
|---|---|---|
| トリガー | Worker が**失敗**した | Worker は**成功**したがタスクが**未完了** |
| 上限 | `max_retries` | `max_iterations` |
| 判定 | 自動（終了コード） | チェッカー Worker が判定 |

### completion_check フィールド

| フィールド | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| `worker` | enum | はい | チェックに使う Worker |
| `instructions` | string | はい | チェック内容の指示 |
| `capabilities` | enum[] | はい | チェッカーの権限（通常は `[READ]` で十分） |
| `timeout` | DurationString | いいえ | チェック1回あたりのタイムアウト |

---

## 失敗ハンドリング

ステップが失敗した場合の動作を `on_failure` で制御します。

### on_failure ポリシー

| ポリシー | 動作 |
|---------|------|
| `abort`（デフォルト） | ワークフロー全体を中断する。未実行ステップはスキップされる |
| `retry` | `max_retries` 回までリトライする。上限を超えたら中断 |
| `continue` | 失敗を記録して後続ステップの実行を続ける |

### retry の例

```yaml
steps:
  flaky-api-call:
    worker: CUSTOM
    instructions: "外部 API を呼び出す"
    capabilities: [RUN_COMMANDS]
    max_retries: 3         # 最大3回リトライ
    on_failure: retry      # 失敗時にリトライ
    timeout: "2m"
```

リトライは指数バックオフ（待ち時間が徐々に増える）で実行されます。

### continue の例

```yaml
steps:
  lint:
    worker: CUSTOM
    instructions: "lint チェックを実行"
    capabilities: [READ]
    on_failure: continue   # 失敗しても後続に影響しない
    outputs:
      - name: lint-report
        path: "lint-result.txt"

  build:
    depends_on: [lint]     # lint が失敗しても実行される
    worker: CUSTOM
    instructions: "ビルドする"
    capabilities: [EDIT]
```

`continue` を使うと、そのステップが失敗しても後続ステップは実行されます。ただし、失敗したステップの成果物（outputs）は利用できない場合があります。

### abort の例

```yaml
steps:
  critical-setup:
    worker: CUSTOM
    instructions: "必須の初期設定"
    capabilities: [EDIT]
    on_failure: abort      # 失敗したらワークフロー全体を停止

  work:
    depends_on: [critical-setup]
    worker: CUSTOM
    instructions: "メイン作業"
    capabilities: [READ, EDIT]
```

`critical-setup` が失敗すると、`work` はスキップされ、ワークフロー全体が `FAILED` になります。

---

## Worker の種類

`worker` フィールドで、ステップの実行に使う Worker を指定します。

| Worker | 説明 | 用途 |
|--------|------|------|
| `CUSTOM` | シェルコマンドを直接実行 | スクリプト、ビルドコマンド、テスト実行 |
| `CLAUDE_CODE` | Claude Code をエージェントとして起動 | コードレビュー、分析、生成 |
| `CODEX_CLI` | Codex CLI をエージェントとして起動 | コード実装、リファクタリング |
| `OPENCODE` | OpenCode をエージェントとして起動 | コード生成、テスト修正 |

### CUSTOM Worker

もっとも基本的な Worker です。`instructions` にシェルスクリプトを書くと、そのまま実行されます。

```yaml
steps:
  hello:
    worker: CUSTOM
    instructions: |
      echo "Hello from CUSTOM worker!"
      date > timestamp.txt
    capabilities: [EDIT]
```

`CUSTOM` は追加のツールのインストールが不要で、すぐに使い始められます。ワークフローの動作確認やシェルスクリプトベースのタスクに最適です。

### AI エージェント Worker

`CLAUDE_CODE`、`CODEX_CLI`、`OPENCODE` は AI エージェントを起動して作業を行います。`instructions` には自然言語でタスクを指示できます。

```yaml
steps:
  implement:
    worker: CODEX_CLI
    instructions: |
      src/utils.ts に配列のユニーク化関数を追加してください。
      型安全に実装し、テストも書いてください。
    capabilities: [READ, EDIT, RUN_TESTS]
    timeout: "15m"

  review:
    worker: CLAUDE_CODE
    depends_on: [implement]
    instructions: |
      src/utils.ts の変更をレビューしてください。
      パフォーマンス、エッジケース、型安全性の観点で確認してください。
    capabilities: [READ]
    timeout: "10m"
```

これらの Worker を使うには、対応するツールが事前にインストールされている必要があります（[クイックスタート](./quickstart.md) の前提条件を参照）。

---

## ワークフローの実行

### 基本的な実行方法

```bash
bun run src/workflow/run.ts <workflow.yaml>
```

### オプション

| オプション | 短縮形 | 説明 | デフォルト |
|-----------|--------|------|----------|
| `--workspace <dir>` | `-w` | 作業ディレクトリ | 一時ディレクトリ |
| `--verbose` | `-v` | ステップの出力を表示 | オフ |
| `--help` | `-h` | ヘルプを表示 | — |

### 実行例

```bash
# 最小構成で実行（一時ディレクトリを自動作成）
bun run src/workflow/run.ts examples/hello-world.yaml

# 作業ディレクトリを指定して実行
bun run src/workflow/run.ts examples/build-test-report.yaml --workspace /tmp/my-work

# 詳細出力つきで実行
bun run src/workflow/run.ts examples/todo-loop.yaml --verbose
```

### 実行結果の見方

実行すると以下のような出力が表示されます。

```
Workflow: /home/user/agentcore/examples/build-test-report.yaml
Name:     build-test-report
Steps:    build, test-math, test-greet, report
Timeout:  5m

─── Results ───

  PASS  build
  PASS  test-math
  PASS  test-greet
  PASS  report

Workflow: SUCCEEDED  (2.3s)
Context:  /tmp/my-work/context
```

各ステップのステータス:

| 表示 | 意味 |
|------|------|
| `PASS` | 正常に完了 |
| `FAIL` | 失敗（リトライ上限超過含む） |
| `SKIP` | 先行ステップの失敗によりスキップ |
| `INCOMPLETE` | 完了チェックの上限到達（`on_iterations_exhausted: continue`） |
| `CANCELLED` | キャンセルされた |

ループ実行したステップには `(N iterations)` と表示されます。

---

## サンプル解説

`examples/` ディレクトリに 4 つのサンプルが用意されています。

### hello-world.yaml — 最小構成

もっとも単純なワークフローです。1ステップだけで、シェルコマンドを実行してファイルを作成します。

```yaml
name: hello-world
version: "1"
timeout: "1m"

steps:
  greet:
    description: "Hello World ファイルを作成する"
    worker: CUSTOM
    instructions: |
      echo "Hello from AgentCore Workflow!" > hello.txt
      echo "Timestamp: $(date)" >> hello.txt
      cat hello.txt
    capabilities: [EDIT]
    timeout: "30s"
    outputs:
      - name: greeting
        path: "hello.txt"
        type: text
```

実行:

```bash
bun run src/workflow/run.ts examples/hello-world.yaml --verbose
```

**ポイント:** ワークフローの基本構造（`name`, `version`, `timeout`, `steps`）を理解するのに最適です。

### build-test-report.yaml — 並列実行と合流

ビルド → テスト（2つ並列）→ レポート作成の流れを実演します。

```yaml
name: build-test-report
version: "1"
timeout: "5m"
concurrency: 2

steps:
  build:
    worker: CUSTOM
    instructions: |
      mkdir -p dist
      echo 'export function add(a, b) { return a + b; }' > dist/math.js
      echo 'export function greet(name) { return "Hello, " + name; }' > dist/greet.js
    capabilities: [EDIT]
    outputs:
      - name: build-output
        path: "dist"
        type: code

  test-math:
    depends_on: [build]
    worker: CUSTOM
    instructions: |
      echo "PASS: add(1, 2) === 3" > test-math-result.txt
    capabilities: [READ, RUN_TESTS]
    inputs:
      - from: build
        artifact: build-output
    on_failure: continue
    outputs:
      - name: math-results
        path: "test-math-result.txt"

  test-greet:
    depends_on: [build]
    worker: CUSTOM
    instructions: |
      echo "PASS: greet('World') === 'Hello, World'" > test-greet-result.txt
    capabilities: [READ, RUN_TESTS]
    inputs:
      - from: build
        artifact: build-output
    on_failure: continue
    outputs:
      - name: greet-results
        path: "test-greet-result.txt"

  report:
    depends_on: [test-math, test-greet]
    worker: CUSTOM
    instructions: |
      echo "# Test Report" > report.md
      cat math-results/test-math-result.txt >> report.md
      cat greet-results/test-greet-result.txt >> report.md
    capabilities: [READ, EDIT]
    inputs:
      - from: test-math
        artifact: math-results
      - from: test-greet
        artifact: greet-results
    outputs:
      - name: final-report
        path: "report.md"
```

DAG 構造:

```
build
  ├── test-math  ──┐
  └── test-greet ──┴── report
```

**ポイント:**
- `test-math` と `test-greet` は `build` 完了後に**並列実行**される
- `report` は両テストの完了を待ってから実行される
- `concurrency: 2` で並列数を制限している
- テストステップは `on_failure: continue` なので、失敗してもレポートは作成される

### todo-loop.yaml — 完了チェックによるループ

タスクリストの全項目が完了するまでステップを繰り返す例です。

```yaml
name: todo-loop
version: "1"
timeout: "5m"

steps:
  setup:
    worker: CUSTOM
    instructions: |
      cat > todo.txt << 'TASKS'
      - [ ] Create src directory
      - [ ] Write hello.ts
      - [ ] Write goodbye.ts
      TASKS
    capabilities: [EDIT]
    outputs:
      - name: todo-file
        path: "todo.txt"

  process-tasks:
    depends_on: [setup]
    worker: CUSTOM
    instructions: |
      # 最初の未完了タスクを見つけて処理する
      TASK=$(grep -m1 '^\- \[ \]' todo.txt || true)
      # ... タスクを実行して完了マークを付ける
    capabilities: [READ, EDIT, RUN_COMMANDS]

    completion_check:
      worker: CUSTOM
      instructions: |
        REMAINING=$(grep -c '^\- \[ \]' todo.txt || true)
        if [ "$REMAINING" -eq 0 ]; then
          exit 0   # 全完了
        else
          exit 1   # まだ残りあり
        fi
      capabilities: [READ]
      timeout: "30s"

    max_iterations: 10
    on_iterations_exhausted: abort

  verify:
    depends_on: [process-tasks]
    worker: CUSTOM
    instructions: "成果物を検証する"
    capabilities: [READ]
```

実行フロー:

```
setup → process-tasks (iteration 1)
           │
           ├─ Worker: タスク1を処理
           ├─ Check: 残り2個 → 未完了
           │
         process-tasks (iteration 2)
           │
           ├─ Worker: タスク2を処理
           ├─ Check: 残り1個 → 未完了
           │
         process-tasks (iteration 3)
           │
           ├─ Worker: タスク3を処理
           ├─ Check: 残り0個 → 完了!
           │
         verify
```

**ポイント:**
- `completion_check` でループの終了条件を判定する
- `max_iterations: 10` が安全弁として機能する（無限ループ防止）
- メイン Worker とチェッカーは同じ workspace 上で動作するため、ファイルの変更が自然に引き継がれる

### failure-recovery.yaml — 失敗ハンドリング

`retry`、`continue`、`abort` の各ポリシーの動作を確認できるサンプルです。

```yaml
name: failure-recovery
version: "1"
timeout: "3m"
concurrency: 2

steps:
  flaky-step:
    description: "不安定なステップ（1回目失敗、2回目成功）"
    worker: CUSTOM
    instructions: |
      # 1回目は失敗し、2回目で成功するシミュレーション
      ...
    max_retries: 2
    on_failure: retry
    outputs:
      - name: flaky-output
        path: "flaky-result.txt"

  optional-lint:
    description: "Lint チェック（失敗しても続行）"
    worker: CUSTOM
    instructions: |
      echo "Lint failed"
      exit 1
    on_failure: continue
    outputs:
      - name: lint-report
        path: "lint-result.txt"

  summary:
    depends_on: [flaky-step, optional-lint]
    worker: CUSTOM
    instructions: |
      # 両方の結果を集約する
      ...
    inputs:
      - from: flaky-step
        artifact: flaky-output
      - from: optional-lint
        artifact: lint-report
```

**ポイント:**
- `flaky-step` は `on_failure: retry` で自動リトライ。1回目失敗→2回目成功で続行
- `optional-lint` は `on_failure: continue` で、失敗しても後続の `summary` に影響しない
- `summary` は両方に依存するが、`optional-lint` が `continue` なので実行される

---

## ステップのステータス一覧

ワークフロー実行中、各ステップは以下のステータスを遷移します。

| ステータス | 意味 |
|-----------|------|
| `PENDING` | 依存するステップの完了を待機中 |
| `READY` | 依存が解決済み、実行待ち |
| `RUNNING` | メイン Worker が実行中 |
| `CHECKING` | `completion_check` の Worker が実行中 |
| `SUCCEEDED` | 正常に完了 |
| `FAILED` | 失敗（リトライ上限超過を含む） |
| `INCOMPLETE` | `max_iterations` の上限到達（`on_iterations_exhausted: continue` の場合） |
| `SKIPPED` | 先行ステップの失敗により実行されなかった |
| `CANCELLED` | タイムアウトまたは外部キャンセル |

ワークフロー全体のステータス:

| ステータス | 意味 |
|-----------|------|
| `SUCCEEDED` | 全ステップが完了 |
| `FAILED` | いずれかのステップが失敗で中断 |
| `TIMED_OUT` | ワークフロー全体のタイムアウト |
| `CANCELLED` | 外部からのキャンセル |

---

## DAG バリデーション

ワークフロー実行前に、以下の項目が自動で検証されます。問題がある場合はエラーメッセージとともに実行が中止されます。

- **循環参照**: `depends_on` にサイクルがないこと
- **参照整合性**: `depends_on` で指定したステップ ID が `steps` に存在すること
- **入力整合性**: `inputs[].from` が `depends_on` に含まれていること
- **出力名の一意性**: 同一ステップ内で `outputs[].name` が重複しないこと
- **Worker 種別の有効性**: `worker` の値が有効な Worker 種別であること
- **completion_check の整合性**: `completion_check` がある場合、`max_iterations` が 2 以上であること

---

## 次のステップ

- 設計の詳細 → [`docs/workflow-design.md`](../workflow-design.md)
- クイックスタート → [`docs/guide/quickstart.md`](./quickstart.md)
- サンプルファイル → `examples/` ディレクトリ
