# agent-pr-loop デモ（実際にコードを生成）

この例は、`examples/agent-pr-loop.yaml` がワークフローのメモだけでなく、実際にテスト可能なソースコードを新規のスクラッチリポジトリ（`/tmp` 配下）に生成できることを示します。

Bun + TypeScript の線形代数 CLI プロジェクトを作成し、次のループを最後まで実行します:

- `bootstrap -> branch -> design -> todo -> implement -> (review<->fix)* -> create_pr`（`create_pr` はデフォルトで無効）

## 前提条件

- `bun`
- `git`
- `opencode`（OpenCode）
- `claude`（Claude Code）
- `codex`（Codex CLI）

ワークフローの `bootstrap` ステップは、これらの worker CLI が `PATH` 上に存在することも検証します。

## 実行

Roboppi リポジトリのルートで:

```bash
bash examples/agent-pr-loop-demo/run-in-tmp.sh
```

デフォルトでは、`/tmp/` 配下に一意なワークスペースディレクトリを作成し、そのパスを表示します。

### 固定のワークスペースパスを使う

```bash
TARGET=/tmp/roboppi-prloop-bun-linalg \
  bash examples/agent-pr-loop-demo/run-in-tmp.sh
```

## 生成されるもの

生成されたワークスペースには次が含まれます:

- `src/`（ライブラリ + `src/cli.ts`）
- `test/`（ユニットテスト）
- `package.json`, `tsconfig.json`, `bun.lock`
- `.roboppi-loop/`（ループの design/todo/review の成果物）

## 検証

```bash
cd <表示されたワークスペースパス>
bun test

bun run src/cli.ts solve --A '[[1,2],[3,4]]' --b '[5,6]'
bun run src/cli.ts eigen2x2 --A '[[2,1],[1,2]]'
bun run src/cli.ts project --basis '[[1,1,0],[0,1,1]]' --b '[3,1,2]'
```

## PR 作成

最後の `create_pr` ステップは、次のマーカーファイルを作成しない限り意図的に無効になっています:

```bash
touch .roboppi-loop/enable_pr
```

その後、ワークフローを再実行してください。PR 作成には、`origin` リモートの設定と `gh` が必要です。
