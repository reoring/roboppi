# Quickstart — チームで Roboppi ワークフローを運用する

このガイドでは、チームプロジェクトに Roboppi ワークフローを導入し、AI エージェントによる設計・実装・レビューの自動化パイプラインを回す方法を説明します。

実例として `examples/appthrust-dashboard/workflow.yaml`（AppThrust Dashboard プロジェクト向けの本番ワークフロー）を使います。

[English](quickstart.md) | 日本語

---

## 目次

1. [前提条件](#1-前提条件)
2. [Roboppi のインストール](#2-roboppi-のインストール)
3. [ワークフローの全体像](#3-ワークフローの全体像)
4. [プロジェクトにワークフローを組み込む](#4-プロジェクトにワークフローを組み込む)
5. [request.md を書く](#5-requestmd-を書く)
6. [ワークフローを実行する](#6-ワークフローを実行する)
7. [ステップの詳細解説](#7-ステップの詳細解説)
8. [成果物とディレクトリ構造](#8-成果物とディレクトリ構造)
9. [ブランチ安全性](#9-ブランチ安全性)
10. [チーム運用のベストプラクティス](#10-チーム運用のベストプラクティス)
11. [トラブルシューティング](#11-トラブルシューティング)
12. [次のステップ](#12-次のステップ)

---

## 1. 前提条件

### 必須

| ツール | 用途 | インストール |
|--------|------|------------|
| [Bun](https://bun.sh/) v1.0+ | ランタイム / パッケージマネージャ | `curl -fsSL https://bun.sh/install \| bash` |
| [Git](https://git-scm.com/) | ブランチ管理・diff 生成 | OS のパッケージマネージャ |

### ワーカー CLI（ワークフローが使用するもの）

| ツール | ワークフローでの役割 | インストール |
|--------|-------------------|------------|
| [OpenCode](https://opencode.ai/) | 設計 (design)・TODO 作成 | `bun install -g opencode` |
| [Claude Code](https://claude.ai/code) | 実装 (implement) | `npm install -g @anthropic-ai/claude-code` |

ワークフローの `worker:` フィールドに応じて必要なツールが変わります。`CUSTOM` ステップはシェルスクリプトを直接実行するため、追加のインストールは不要です。

### オプション

| ツール | 用途 |
|--------|------|
| `gh` (GitHub CLI) | PR 作成ステップを追加する場合 |
| `codex` (Codex CLI) | ワーカーとして Codex CLI を使う場合 |

---

## 2. Roboppi のインストール

### プリビルドバイナリ（推奨）

```bash
curl -fsSL https://raw.githubusercontent.com/reoring/roboppi/main/install.sh | bash
roboppi --help
```

### ソースからビルド

```bash
git clone https://github.com/reoring/roboppi.git
cd roboppi
bun install
make build
./roboppi --help
```

開発中は `bun run src/workflow/run.ts` で直接実行することもできます（ビルド不要）。

---

## 3. ワークフローの全体像

AppThrust Dashboard ワークフロー (`examples/appthrust-dashboard/workflow.yaml`) は、以下のパイプラインを自動実行します。

```
bootstrap ─→ branch ─→ deps ─→ design ─→ todo ─→ implement ─→ validate
   │            │         │        │         │         │            │
   │  環境検証  │ ブランチ │ 依存   │ 設計書  │ TODO   │ 実装+検証  │ lint/
   │  + 初期化  │ 作成/   │ install│ 作成   │ 作成   │ + review  │ format/
   │           │ 復帰    │        │ (AI)   │ (AI)  │ inputs    │ build
   └───────────┴─────────┴────────┴────────┴───────┴───────────┴────────
```

### 各ステップの役割

| ステップ | ワーカー | 説明 |
|----------|---------|------|
| `bootstrap` | CUSTOM | git リポジトリの検証、`roboppi/request.md` の存在確認、前回のアーティファクトをクリア |
| `branch` | CUSTOM | 作業ブランチを作成または復帰（`roboppi/branch.txt` で永続化） |
| `deps` | CUSTOM | `bun install` で依存パッケージをインストール |
| `design` | OPENCODE (GPT-5.2) | `request.md` を読み、設計書 `roboppi/design.md` を生成 |
| `todo` | OPENCODE (GPT-5.2) | 設計書をもとに実装チェックリスト `roboppi/todo.md` を生成（completion_check 付き） |
| `implement` | CLAUDE_CODE (Opus 4.6) | TODO を実装し、lint/format/build を通し、レビュー用 diff を生成 |
| `validate` | CUSTOM | 最終的な `bun run lint` / `bun run format:check` / `bun run build` |

### ワーカーの使い分け

このワークフローでは **設計・計画は OpenCode (GPT-5.2)**、**実装は Claude Code (Opus 4.6)** と意図的に分けています。

- **OpenCode** — 読み取り専用のステップに向いている。コードを書かずに設計や TODO を整理する
- **Claude Code** — 実装力が高い。コード編集 + コマンド実行 + テスト修正を一貫して行う
- **CUSTOM** — シェルスクリプトで確実に動く操作（ブランチ切替、lint、build など）

---

## 4. プロジェクトにワークフローを組み込む

### ディレクトリ構成

対象プロジェクトのリポジトリに、以下の構造を作ります。

```
your-project/
├── roboppi/
│   ├── request.md          # 実装リクエスト（チームメンバーが書く）
│   ├── workflow.yaml        # ワークフロー定義（コピーまたはシンボリックリンク）
│   ├── base-branch.txt      # ベースブランチ名（自動生成）
│   ├── branch.txt           # 作業ブランチ名（自動生成）
│   └── context/             # ステップ間のアーティファクト（自動生成）
├── .gitignore
└── ...（既存のソースコード）
```

### セットアップ手順

```bash
cd /path/to/your-project

# 1. roboppi ディレクトリを作成
mkdir -p roboppi

# 2. ワークフローをコピー（またはシンボリックリンク）
cp /path/to/roboppi/examples/appthrust-dashboard/workflow.yaml roboppi/workflow.yaml

# 3. .gitignore に追加（ワークフローの中間成果物を追跡しない）
cat >> .gitignore << 'EOF'

# Roboppi workflow artifacts
roboppi/design.md
roboppi/todo.md
roboppi/fix.md
roboppi/review.*
roboppi/validate.ok
roboppi/bootstrap.ok
roboppi/context/
EOF
```

`roboppi/request.md` と `roboppi/workflow.yaml` はリポジトリにコミットしておくことを推奨します。これにより、チーム全員が同じワークフローとリクエストを共有できます。

---

## 5. request.md を書く

`roboppi/request.md` はワークフロー全体の入力です。AI エージェントはこのファイルを読んで設計・実装を行います。

### 良い request.md のテンプレート

```markdown
# 機能名（短く、明確に）

## ゴール
何を達成したいかを 1-3 文で。

## 要件
- 具体的な要件を箇条書き
- UI があるなら見た目やインタラクションの説明
- データの流れ（API / ローカルモック / 既存コードとの連携）

## 非スコープ（今回やらないこと）
- 明示的に除外するもの

## 受け入れ基準
- [ ] チェックリスト形式で
- [ ] `bun test` がパスする
- [ ] `bun run lint` がパスする
- [ ] `bun run build` がパスする

## 参考資料
- 関連するドキュメントやファイルパスがあればここに
```

### ポイント

- **200 バイト以上** ないと bootstrap ステップで弾かれます（空っぽの request を防ぐため）
- 受け入れ基準はチェックリスト（`- [ ]`）で書くと、design/todo ステップがそのまま引用してくれます
- ファイルパスや API の形式など、具体的であるほどエージェントの出力品質が上がります

---

## 6. ワークフローを実行する

### 基本的な実行方法

```bash
# AGENTCORE_ROOT を Roboppi のクローン先に設定
export AGENTCORE_ROOT="$HOME/roboppi"

# ワークフローを実行
bun run --cwd "$AGENTCORE_ROOT" src/workflow/run.ts \
  /path/to/your-project/roboppi/workflow.yaml \
  --workspace /path/to/your-project \
  --base-branch main \
  --supervised --verbose
```

### 引数の説明

| 引数 | 説明 |
|------|------|
| `--cwd "$AGENTCORE_ROOT"` | Roboppi のソースルートから実行（`bun run` はここで `src/workflow/run.ts` を解決） |
| 第 1 引数 | ワークフロー YAML のパス |
| `--workspace` | 対象プロジェクトのルートディレクトリ |
| `--base-branch` | ベースブランチ（デフォルト: 現在のブランチ） |
| `--supervised` | Supervisor -> Core -> Worker の 3 層モードで実行（デフォルト） |
| `--verbose` | 各ステップの出力を表示 |

### ビルド済みバイナリを使う場合

```bash
roboppi workflow /path/to/your-project/roboppi/workflow.yaml \
  --workspace /path/to/your-project \
  --base-branch main \
  --verbose
```

### 便利なエイリアス

チームで頻繁に使う場合は、プロジェクトの `Makefile` や `package.json` にスクリプトを追加しておくと便利です。

```makefile
# Makefile
AGENTCORE_ROOT ?= $(HOME)/roboppi

roboppi:
	bun run --cwd "$(AGENTCORE_ROOT)" src/workflow/run.ts \
	  roboppi/workflow.yaml \
	  --workspace "$(PWD)" \
	  --base-branch main \
	  --supervised --verbose
```

```bash
make roboppi
```

---

## 7. ステップの詳細解説

### bootstrap — 環境検証

```yaml
bootstrap:
  worker: CUSTOM
  instructions: |
    set -euo pipefail
    # git リポジトリかチェック
    # roboppi/request.md の存在と最小サイズを検証
    # 前回の中間成果物をクリア
    # 必要なコマンド（bun, opencode, claude）の存在を確認
```

**失敗する場合:**
- `roboppi/request.md` がない → 先に書く
- `roboppi/request.md` が 200 バイト未満 → 内容を充実させる
- `bun` / `opencode` / `claude` が PATH にない → インストールする

### branch — ブランチ管理

ブランチの状態を 3 つのケースで扱います。

| ケース | 動作 |
|--------|------|
| `roboppi/branch.txt` にブランチ名がある + ローカルに存在 | そのブランチに checkout |
| `roboppi/branch.txt` にブランチ名がある + リモートのみ | track して checkout |
| ブランチ名がない（初回実行） | `roboppi/features-YYYYMMDD-HHMMSS` を作成 |

`roboppi/branch.txt` をコミットしておけば、チームメンバー間で同じブランチを共有できます。

### design — AI による設計書生成

OpenCode (GPT-5.2) が `roboppi/request.md` と既存ドキュメントを読み、`roboppi/design.md` を生成します。

生成される設計書の内容:
- MVP スコープ宣言
- ルートマップ
- UI コンポーネント一覧
- データ取得戦略
- 認証の考慮事項
- エッジケースとリスク
- 検証計画
- 受け入れ基準チェックリスト

**`on_failure: retry` + `max_retries: 1`** — 失敗時に 1 回リトライ。

### todo — completion_check 付きループ

OpenCode が設計書から TODO チェックリストを生成します。

```yaml
completion_check:
  worker: CUSTOM
  instructions: |
    # 10 項目以上あるか？
    # lint/format/build コマンドが含まれているか？
    # ファイルパスのヒントがあるか？
```

**`max_iterations: 3`** — チェックに通らなければ最大 3 回やり直し。3 回で通らなければ abort。

これにより「TODO が薄すぎる」「検証ステップが抜けている」状態を機械的に防ぎます。

### implement — 実装の本体

Claude Code (Opus 4.6) が TODO リストに沿って実装します。

このステップの特徴:
- `roboppi/fix.md` がある場合はそこに書かれた修正のみ適用（レビューループ用）
- `bun run lint` / `bun run format:check` / `bun run build` を必ず通す
- 終了時にレビュー入力ファイル群を生成:
  - `roboppi/review.base_ref` — diff の基準コミット
  - `roboppi/review.diff` — ベースからの全 diff
  - `roboppi/review.status` — `git status --porcelain`
  - `roboppi/review.untracked` — 未追跡ファイル一覧
  - `roboppi/review.untracked.diff` — 未追跡ファイルの diff（サイズ制限付き）

### validate — 最終チェック

シェルスクリプトで `bun run lint` / `bun run format:check` / `bun run build` を実行し、すべて通れば `roboppi/validate.ok` を出力します。

---

## 8. 成果物とディレクトリ構造

ワークフロー実行後のディレクトリ:

```
your-project/
├── roboppi/
│   ├── request.md              # 入力（チームが書いた）
│   ├── workflow.yaml            # ワークフロー定義
│   ├── base-branch.txt          # ベースブランチ名
│   ├── branch.txt               # 作業ブランチ名
│   ├── bootstrap.ok             # bootstrap 成功マーカー
│   ├── design.md                # AI が生成した設計書
│   ├── todo.md                  # AI が生成した TODO（チェック済み項目あり）
│   ├── validate.ok              # validate 成功マーカー
│   ├── review.base_ref          # レビュー用: ベース参照
│   ├── review.diff              # レビュー用: 全 diff
│   ├── review.status            # レビュー用: git status
│   ├── review.untracked         # レビュー用: 未追跡ファイル一覧
│   ├── review.untracked.diff    # レビュー用: 未追跡ファイル diff
│   └── context/                 # ステップ間コンテキスト
│       ├── _workflow.json
│       ├── design/
│       │   └── _meta.json
│       ├── todo/
│       │   └── _meta.json
│       └── validate/
│           └── _meta.json
└── （実装された変更）
```

### チームでの活用

- `roboppi/design.md` — PR のレビュー前に設計意図を確認できる
- `roboppi/todo.md` — 実装の進捗を確認できる（チェック済みの `[x]` と未完了の `[ ]`）
- `roboppi/review.diff` — 手動レビューの入力として使える
- `roboppi/context/` — 各ステップの実行メタデータ（所要時間、リトライ回数など）

---

## 9. ブランチ安全性

このワークフローは `create_branch: true` と `branch_transition_step: "branch"` を設定しています。

### Roboppi が保証すること

1. **ベースブランチの確定的な解決** — 起動時にベースコミット SHA を記録し、以降のステップで一貫した基準を使う
2. **Branch Lock** — ステップ実行前にワークツリーとブランチが期待通りか検証。途中で別のブランチに切り替わっていたら fail-fast
3. **保護ブランチガード** — `main`, `master`, `release/*` への直接編集をデフォルトで禁止

### 安全な実行パターン

```bash
# main ブランチ上で実行 → branch ステップが作業ブランチを切る → 以降はそのブランチで作業
roboppi workflow roboppi/workflow.yaml \
  --workspace . \
  --base-branch main \
  --verbose
```

### 中断からの再開

ワークフローが途中で失敗しても、`roboppi/branch.txt` に作業ブランチ名が残っているので、再実行時に同じブランチが復帰されます。

```bash
# 再実行 — branch ステップが既存のブランチを checkout する
roboppi workflow roboppi/workflow.yaml \
  --workspace . \
  --base-branch main \
  --verbose
```

詳細: [docs/guides/branch.md](./guides/branch.md) / [docs/guides/branch.ja.md](./guides/branch.ja.md)

---

## 10. チーム運用のベストプラクティス

### ワークフロー管理

| やること | 理由 |
|----------|------|
| `roboppi/workflow.yaml` をリポジトリにコミット | チーム全員が同じワークフローを使える |
| `roboppi/request.md` を PR と一緒にコミット | 何を依頼したかが記録に残る |
| `roboppi/design.md` / `roboppi/todo.md` は `.gitignore` に入れる | 毎回再生成されるため |
| `roboppi/branch.txt` はケースバイケース | 共有したいならコミット、個人作業なら `.gitignore` |

### request.md の書き方チーム規約

```
1. 1 つの request.md に 1 つの機能（スコープを絞る）
2. 受け入れ基準を必ずチェックリストで書く
3. 既存コードへの影響範囲を明記する
4. 非スコープを明示する（エージェントの暴走を防ぐ）
```

### ワークフローのカスタマイズ

プロジェクトの要件に合わせてワークフローを調整できます。

**タイムアウトの調整:**

```yaml
timeout: "240m"         # ワークフロー全体
# 各ステップの timeout も個別に設定可能
```

**ステップの追加・削除:**

例えば、レビューループを追加する場合:

```yaml
  implement:
    # ...
    completion_check:
      worker: OPENCODE
      model: "openai/gpt-5.2"
      decision_file: "roboppi/review.verdict"
      instructions: |
        # レビュー指示...
      capabilities: [READ, EDIT, RUN_COMMANDS]
      timeout: "15m"
    max_iterations: 5
    on_iterations_exhausted: abort
```

**convergence（収束制御）の追加:**

implement ステップでレビューループが空回りするのを防ぐ:

```yaml
  implement:
    # ...
    convergence:
      enabled: true
      stall_threshold: 2       # 同じ問題が 2 回繰り返されたらエスカレーション
      max_stage: 3             # 最大 3 段階
      fail_on_max_stage: true  # 最終段階で fail-fast
```

### CI/CD との統合

GitHub Actions で Roboppi ワークフローを実行する例:

```yaml
# .github/workflows/roboppi.yml
name: Roboppi Workflow
on:
  push:
    paths:
      - 'roboppi/request.md'

jobs:
  run-workflow:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install Roboppi
        run: |
          curl -fsSL https://raw.githubusercontent.com/reoring/roboppi/main/install.sh | bash

      - name: Run workflow
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: |
          roboppi workflow roboppi/workflow.yaml \
            --workspace . \
            --base-branch main \
            --verbose
```

### 複数のリクエストを並行して扱う

チームメンバーがそれぞれ異なる機能を実装する場合:

```bash
# メンバー A: 認証機能
git checkout -b feat/auth
vim roboppi/request.md  # 認証機能のリクエストを書く
roboppi workflow roboppi/workflow.yaml --workspace . --base-branch main --verbose

# メンバー B: ダッシュボード機能
git checkout -b feat/dashboard
vim roboppi/request.md  # ダッシュボードのリクエストを書く
roboppi workflow roboppi/workflow.yaml --workspace . --base-branch main --verbose
```

各メンバーが別ブランチで作業することで、ワークフローの成果物が衝突しません。

---

## 11. トラブルシューティング

### bootstrap が失敗する

| エラーメッセージ | 原因 | 対処 |
|-----------------|------|------|
| `roboppi/request.md not found` | request.md がない | `roboppi/request.md` を作成する |
| `roboppi/request.md is too small` | 内容が 200 バイト未満 | リクエストを充実させる |
| `bun not found in PATH` | Bun がインストールされていない | Bun をインストールする |
| `opencode not found in PATH` | OpenCode がインストールされていない | `bun install -g opencode` |
| `claude not found in PATH` | Claude Code がインストールされていない | `npm install -g @anthropic-ai/claude-code` |

### todo ステップが max_iterations に達する

`completion_check` が以下を検証しています:

- `roboppi/todo.md` に `- [ ]` が 10 項目以上あるか
- `bun run lint` / `bun run format:check` / `bun run build` のいずれかが含まれているか
- ファイルパス（`.ts`, `.tsx`, `.md` など）が含まれているか

3 回のイテレーションで通らない場合は、`request.md` の内容がエージェントにとって曖昧すぎる可能性があります。より具体的な要件を書いてください。

### implement ステップが失敗する

1. **lint/format/build エラー** — implement ステップは自力で修正を試みますが、修正しきれない場合があります。ログを確認して手動で対処するか、`roboppi/fix.md` に修正指示を書いて再実行してください。

2. **タイムアウト** — `timeout: "120m"` を超えた場合。タスクが大きすぎる可能性があります。`request.md` のスコープを絞ってください。

### ブランチ関連のエラー

| エラー | 原因 | 対処 |
|--------|------|------|
| Branch Lock drift detected | ステップ間でブランチが変わった | 手動でブランチを戻す |
| Protected branch guard | main/master に直接編集しようとした | `--base-branch` を指定して作業ブランチを切る |

### デバッグ用の環境変数

```bash
# IPC トレースを有効化
ROBOPPI_IPC_TRACE=1 roboppi workflow ...

# 詳細ログ
ROBOPPI_VERBOSE=1 roboppi workflow ... --verbose

# IPC リクエストタイムアウトを延長
ROBOPPI_IPC_REQUEST_TIMEOUT=5m roboppi workflow ...
```

---

## 12. 次のステップ

### ドキュメント

- [docs/guide/workflow.md](./guide/workflow.md) — ワークフロー YAML の完全なスキーマリファレンス
- [docs/guide/daemon.md](./guide/daemon.md) — デーモンモード（イベント駆動の自動実行）
- [docs/guide/architecture.md](./guide/architecture.md) — 内部アーキテクチャの詳細
- [docs/guides/branch.md](./guides/branch.md) — ブランチ安全性の詳細
- [docs/guides/agents.md](./guides/agents.md) — エージェントカタログ（再利用可能なプロファイル）
- [docs/design.md](./design.md) — コア設計ドキュメント

### 発展的な使い方

- **レビューループの追加** — implement ステップに `completion_check` を追加して、AI レビュー → 修正のループを回す（`examples/agent-pr-loop.yaml` を参考）
- **デーモンモード** — `roboppi/request.md` の変更を検知して自動実行（`examples/daemon/agent-pr-loop.yaml` を参考）
- **エージェントカタログ** — ワーカーの設定を再利用（`docs/guides/agents.md` を参考）
- **PR 自動作成** — implement 後に `create_pr` ステップを追加（`examples/agent-pr-loop.yaml` を参考）

### カスタムワークフローの作成

このワークフローをベースに、チームの開発フローに合わせたワークフローを作成できます。

```bash
# 例: テスト付きのフルループ
cp examples/appthrust-dashboard/workflow.yaml my-team/workflow.yaml
# 必要に応じてステップを追加・編集
```

ワークフローの YAML スキーマについては [docs/guide/workflow.md](./guide/workflow.md) を参照してください。
