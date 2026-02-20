# ブランチガイド

このガイドは、Roboppi が workflow を実行する際の **ブランチ安全仕様**（base branch 解決、Branch Lock、保護ブランチガード）をまとめたものです。

Roboppi は git workspace 上で動かすことが多く（例: Agent PR Loop）、

- 間違ったブランチで走る
- 実行中に worktree/ブランチが変わる
- work branch を作るつもりが `main` に直接変更してしまう

といった事故が起こりやすいです。

Roboppi は以下でこれを防ぎます。

1. **base branch 解決**: `effective_base_branch` を決定し、起動時点の commit SHA も固定して記録する
2. **Branch Lock**: 実行中に repo/branch が想定からずれたら step 実行前に fail-fast する

加えて、`main` などへの直接変更を防ぐ **保護ブランチガード** を提供します。

---

## 用語

これらは workflow 起動時に `src/workflow/branch-context.ts` で解決され、runner/executor に渡されます。

- `startup_toplevel`: 起動時点の `git rev-parse --show-toplevel`
- `startup_branch`: 起動時点の `git rev-parse --abbrev-ref HEAD`
- `startup_head_sha`: 起動時点の `git rev-parse HEAD`
- `effective_base_branch`: 解決された base branch 名
- `effective_base_branch_source`: `effective_base_branch` の由来（`cli | env | current`）
- `effective_base_sha`: 起動時点の `git rev-parse <effective_base_branch>^{commit}`
- `expected_work_branch`: workflow が **実際に変更を加えるはずのブランチ**
- `expected_current_branch`: **各 step 実行直前**に runner がいるべきブランチ
- `protected_branches`: 「直接変更を避けたい」ブランチパターン
- `protected_branches_source`: `protected_branches` の由来（`default | env | cli`）
- `allow_protected_branch`: 保護ブランチガードを明示的に無効化する override

---

## Base Branch の解決

base branch は起動時に一度だけ決定されます。

### 入力

- CLI: `--base-branch <name>`
- env: `BASE_BRANCH=<name>`
- 未指定時: 起動時の現在ブランチ（`startup_branch`）

### 優先順位

1. CLI `--base-branch`
2. env `BASE_BRANCH`
3. `startup_branch`（detached でない場合のみ）

`startup_branch` が `HEAD`（detached HEAD）の場合、CLI/env でも base branch が指定されていなければ fail-fast します。

### 起動時 SHA の固定

`effective_base_branch` が決まったら、起動時点の `effective_base_sha` を解決して記録します。

### override の warning

CLI/env で base branch を上書きしており、それが `startup_branch` と異なる場合、runner は warning を出して「今いるブランチ」と「base」が違うことを明示します。

---

## Workflow YAML のブランチ関連フィールド

以下は workflow YAML のトップレベルフィールドです（`src/workflow/parser.ts` が検証）。

```yaml
create_branch: true|false
branch_transition_step: "branch"   # optional
expected_work_branch: "my-branch"  # optional
```

### `create_branch`（boolean）

workflow が work branch を作成/切替することを前提にするか。

- `false`（既定）: 現在ブランチ上で動作
- `true`: 実行中に work branch へ遷移する前提

注意: Roboppi 自体がブランチを作るわけではありません。workflow の step が行う checkout/branch 作成に対して、安全上の期待値を強制します。

### `branch_transition_step`（string）

work branch への遷移が発生する step id。

- 省略かつ `create_branch: true` の場合、`branch` という step が存在すれば既定で `branch` になります。
- この step が成功した直後に、Roboppi は現在のブランチ名を読み取り、
  - `expected_work_branch`
  - `expected_current_branch`

  を更新します。

### `expected_work_branch`（string）

起動時点で期待する work branch を明示できます。

特定のブランチでしか走ってほしくない workflow（例: `release/v1` 限定の保守作業）で、起動時に間違ったブランチなら即 fail-fast させたい場合に使います。

---

## Branch Lock（ドリフト検知）

workspace が git repo の場合、Branch Lock は自動で有効になります。

### 何を検証するか

各 step の **実行前**に executor（`src/workflow/executor.ts`）が以下を検証します。

1. **repo/worktree の一致**: 現在の `git rev-parse --show-toplevel` が `startup_toplevel` と一致
2. **ブランチ一致**: 現在の `git rev-parse --abbrev-ref HEAD` が以下と一致
   - `expected_current_branch`（優先）
   - `expected_work_branch`
   - `startup_branch`

不一致なら、その step を実行する前に workflow を失敗させます。

### ブランチ遷移

`create_branch: true` かつ `branch_transition_step` が設定されている場合、その step の成功直後に現在のブランチ名を読み取り、期待ブランチを更新します。

これにより `bootstrap -> branch -> implement -> review` のようなフローで、branch step 以降は確実に work branch 上で実行できます。

### git でない workspace

workspace が git repo でない場合は Branch Lock は無効になり、runner は warning を出します。

---

## 保護ブランチガード

保護ブランチガードは、重要ブランチへの直接変更を防ぐための fail-fast です。

### 既定値

既定の `protected_branches`:

```text
main, master, release/*
```

### パターン仕様

- `*` を含まないパターンは完全一致
- `*` を含む場合は簡易 glob として扱う（特別扱いは `*` のみ）。`*` は `/` を含む任意文字列にマッチします。

例:

- `main` は `main` のみに一致
- `release/*` は `release/v1`, `release/2026-02` などに一致

### ブロック条件

起動時に以下すべてを満たす場合、workflow 開始前に Roboppi が停止します。

- `create_branch: false`
- `expected_work_branch` が `protected_branches` に一致
- `allow_protected_branch` が有効でない

`create_branch: false` は「現在ブランチに直接変更する」前提のため、ここは意図的に厳しくしています。

### 設定方法

保護ブランチリストの上書き:

- CLI: `--protected-branches <csv>`
- env: `ROBOPPI_PROTECTED_BRANCHES=<csv>`
- 優先順位: CLI > env > default

ガードの明示無効化（危険）:

- CLI: `--allow-protected-branch`
- env: `ROBOPPI_ALLOW_PROTECTED_BRANCH=1`

override 有効時は warning を出し、workflow メタデータにも記録します。

---

## Step に渡される環境変数

workflow 実行時、runner は各 step に以下の env を渡します（`src/workflow/run.ts` / `src/daemon/daemon.ts`）。

base / startup:

- `BASE_BRANCH`（`effective_base_branch` に設定）
-- `ROBOPPI_EFFECTIVE_BASE_BRANCH`
-- `ROBOPPI_EFFECTIVE_BASE_BRANCH_SOURCE`（`cli|env|current`）
-- `ROBOPPI_EFFECTIVE_BASE_SHA`
-- `ROBOPPI_STARTUP_BRANCH`
-- `ROBOPPI_STARTUP_HEAD_SHA`
-- `ROBOPPI_STARTUP_TOPLEVEL`

Branch Lock の期待値:

-- `ROBOPPI_CREATE_BRANCH`（`1` または `0`）
-- `ROBOPPI_EXPECTED_WORK_BRANCH`
-- `ROBOPPI_EXPECTED_CURRENT_BRANCH`

保護ブランチガード:

-- `ROBOPPI_PROTECTED_BRANCHES`（CSV）
-- `ROBOPPI_ALLOW_PROTECTED_BRANCH`（`1` または `0`）

---

## 可観測性（ログ / 成果物）

### CLI runner の出力

`src/workflow/run.ts` は実行前に Branch Lock のサマリを出力します。

- startup branch / SHA / toplevel
- effective base branch / source / SHA
- protected branches / source
- allow override 状態

### context 成果物

workflow のメタデータは `context/_workflow.json` に書かれます（`src/workflow/context-manager.ts`）。
ブランチ情報もトップレベルのキーとして含まれます。

```json
{
  "branch_lock_enabled": true,
  "startup_branch": "main",
  "effective_base_branch": "main",
  "effective_base_sha": "<sha>",
  "protected_branches": ["main", "master", "release/*"],
  "allow_protected_branch": false
}
```

### daemon モード

daemon モードでは `src/daemon/daemon.ts` が同等の情報をログに出します。

---

## 例

現在ブランチを base として実行（既定）:

```bash
roboppi workflow examples/agent-pr-loop.yaml --workspace /path/to/repo --supervised --verbose
```

base branch を明示:

```bash
roboppi workflow examples/agent-pr-loop.yaml --workspace /path/to/repo \
  --base-branch main --supervised --verbose
```

保護ブランチを main/master のみに絞る:

```bash
roboppi workflow examples/agent-pr-loop.yaml --workspace /path/to/repo \
  --protected-branches main,master --supervised --verbose
```

保護ブランチ上での実行を許可（危険）:

```bash
roboppi workflow examples/agent-pr-loop.yaml --workspace /path/to/repo \
  --allow-protected-branch --supervised --verbose
```

---

## 任意ステップのフラグ切り替え（workflow定義）

重い処理や環境依存の処理は、`CUSTOM` script 側で sentinel file（有無フラグ）を見て実行可否を切り替える運用ができます。

例（Appthrust Platform workflow）:
-- `.roboppi-loop/enable_live_validation`: 存在する場合のみ live cluster validation step を実行
-- `.roboppi-loop/live-validation.args`: validation wrapper に追加で渡す引数

挙動:
- ファイルなし -> script は `0` で終了し、step は skip/pass 扱い
- ファイルあり -> validation コマンドを実行し、失敗時は workflow も失敗

重要:
- これらのファイルは workflow/repo 側の約束です。
- AgentCore 本体が `enable_live_validation` を解釈する機能はありません。step のコマンド実行結果（exit code）だけを評価します。

---

## 注意点 / ハマりどころ

- シェルで `BASE_BRANCH` をグローバルに export していると、意図せず既定の「現在ブランチ base」が上書きされます。override が必要なときは `--base-branch` を推奨します。
- detached HEAD で起動した場合、`--base-branch`（または `BASE_BRANCH`）を指定しないと fail-fast します。
- ブランチ遷移 step は *named branch* に checkout する必要があります。遷移後に detached HEAD だとエラーになります。
- 保護ブランチガードは起動時評価です。`branch_transition_step` が保護ブランチへ checkout すると起動時ガードをすり抜け得るため、原則避けてください（必要なら override を明示）。
