# Agent Catalog（再利用できるエージェント定義）

ワークフローの各ステップで、同じ設定を何度も書きたくなることがあります。

- worker 種別（OPENCODE / CLAUDE_CODE / CODEX_CLI / CUSTOM）
- model
- capabilities（権限）
- 共通の基本指示（base instructions）

Roboppi では、これらを **ワークフロー外の YAML（Agent Catalog）** に定義し、ワークフロー内では `agent: <id>` で参照できます。

## 1) Agent Catalog の例

`agents.yaml` を作成します。

```yaml
version: "1"
agents:
  research:
    worker: OPENCODE
    model: openai/gpt-5.2
    capabilities: [READ]
    base_instructions: |
      あなたはリサーチ担当です。
      - 読むだけ。編集しない。
```

## 2) ワークフローから参照

```yaml
steps:
  investigate:
    agent: research
    instructions: |
      コードベースを調査して、短いメモを docs/research.md にまとめてください。
    outputs:
      - name: report
        path: docs/research.md
```

`completion_check` 側でも `agent` を指定できます。

## 3) 解決ルール（継承/上書き）

- `agent` を指定すると、ステップ側で省略した項目（`worker`/`model`/`capabilities`/`workspace`/`timeout`/`max_steps`/`max_command_time` など）を Agent Catalog から補完します。
- Agent Catalog に `base_instructions` がある場合、それを `instructions` の前に連結します。
- ステップ側に明示した値が優先（上書き）です。

## 4) どこから読み込むか

Workflow runner:

- 明示: `ROBOPPI_AGENTS_FILE=/a.yaml:/b.yaml`（コロン区切り）と `--agents <path>`（複数回指定可）
- 暗黙: 明示指定がない場合、workflow YAML と同じディレクトリの `agents.yaml` / `agents.yml` を自動探索

Daemon:

- daemon 設定で `agents_file: "./agents.yaml"` を指定可能（相対パスは `workspace` 基準）
- さらに `ROBOPPI_AGENTS_FILE` を環境変数（または trigger の `context.env`）で指定可能

同じ agent id が複数の catalog に定義されている場合、後から読み込んだ定義が上書きされます。
