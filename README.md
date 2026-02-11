# AgentCore

AIエージェントの「実行」を安全に運用するための実行制御ランタイムです。重い作業（コード編集・コマンド実行・テスト）は OpenCode / Claude Code / Codex CLI などの外部Workerに委譲し、AgentCore は **止める・制限する・観測する・隔離する** を担当します。

ポイントは、エージェントをイベントループで回し続けたときに起きがちな事故（重複実行、無限リトライ、障害の連鎖、ハングでの巻き込み）を「仕組み」で抑えることです。

## ユーザの利点

- エージェントの暴走を前提にした安全装置: タイムアウト/同時実行/RPS/コスト等の予算で必ず止まる
- キャンセルが通る: Job→Permit→Workerまで AbortSignal で中断が一貫して伝搬する
- 障害が連鎖しにくい: Worker/LLM側の失敗集中を Circuit Breaker で遮断できる
- 実行を抱えない: 重い処理は別プロセスのWorkerに逃がし、AgentCore本体の詰まりを防ぐ
- 観測しやすい: stdout/stderr/progress/patch をイベントとして扱い、監査・再現性を上げる

## 代表的なユースケース

- PR自動化の定番ループ: 設計→TODO→実装→レビュー→修正を複数Workerで回して収束させる
- CI/CDのエージェント実行基盤: テスト失敗の修正やリファクタを“止められる形”で委譲する
- 複数エージェントの分業: 調査=OpenCode、実装=Claude Code、修正=Codex など役割を固定して運用
- 手動キックのデーモン: ファイル更新をトリガに、ワークフローを安全に繰り返し実行する

## 使い方（すぐ試す）

前提:

- Bun
- Worker CLI（使うものだけ）: `opencode`, `claude`, `codex`
- （任意）PR作成をするなら GitHub CLI: `gh`

セットアップ:

```bash
bun install
```

### 1) Agent PR Loop（例）

別リポジトリ（TARGET）に対して、設計→TODO→実装→レビュー→修正を回します。

```bash
AGENTCORE_ROOT=/path/to/agentcore
TARGET=/path/to/your/repo

# まず依頼文を書く（初回は雛形が作られます）
mkdir -p "$TARGET/.agentcore-loop"
$EDITOR "$TARGET/.agentcore-loop/request.md"

# 実行
AGENTCORE_ROOT="$AGENTCORE_ROOT" bun run --cwd "$AGENTCORE_ROOT" ./src/workflow/run.ts \
  "$AGENTCORE_ROOT/examples/agent-pr-loop.yaml" --workspace "$TARGET" --verbose
```

- ワークフロー定義: `examples/agent-pr-loop.yaml`
- 補助スクリプト: `scripts/agent-pr-loop/`
- 生成物（ローカル状態）: `.agentcore-loop/`（gitでは無視されます）

PR作成まで自動で行いたい場合は、TARGET側で次を置いてから再実行します。

```bash
touch "$TARGET/.agentcore-loop/enable_pr"
```

### 2) デーモン（手動キック）

```bash
bun run src/daemon/cli.ts examples/daemon/agent-pr-loop.yaml --verbose
```

別端末からキック:

```bash
mkdir -p .agentcore-loop
date +%s > .agentcore-loop/kick.txt
```

### 3) ワンショット実行（CLI）

AgentCoreの `run` サブコマンドで、単発のWorkerタスクを予算つきで実行できます。

```bash
bun run src/cli.ts run --worker opencode --workspace /tmp/demo \
  --capabilities READ,EDIT --timeout 60000 "Write a README for this repo"
```

## 何が入っているか

- AgentCore CLI: `src/cli.ts`（IPC server / one-shot run）
- Workflow Runner: `src/workflow/run.ts`（YAMLワークフロー実行）
- Multi-worker step runner: `src/workflow/multi-worker-step-runner.ts`（`worker: OPENCODE | CLAUDE_CODE | CODEX_CLI | CUSTOM` を直接実行）
- 設計ドキュメント: `docs/design.md`

## ステータス

実装はまだ探索段階で、API/挙動は変更される可能性があります。設計思想は `docs/design.md` を参照してください。

## 開発

```bash
bun test
bun run typecheck
```
