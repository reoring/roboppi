# Branch Lock / Base Branch テスト仕様書

## 1. 目的
`BASE_BRANCH` 未指定時の current branch 採用、branch drift の fail-fast、保護ブランチガード、`create_branch=true` 時の遷移許容が仕様どおりに動作することを確認する。

## 2. 対象
- `src/workflow/branch-context.ts`
- `src/workflow/run.ts`
- `src/workflow/executor.ts`
- `src/daemon/daemon.ts`（本スクリプトは `workflow run` を直接実行）

## 3. 前提条件
- `bun` と `git` が利用可能
- このリポジトリのルートで `bun run src/workflow/run.ts ...` を実行可能
- `/tmp` 配下に検証用ディレクトリを作成可能

## 4. テスト観点
1. `BASE_BRANCH` 未指定時に `startup_branch` が `effective_base_branch` になる
2. step 間でブランチが変更された場合、次 step 開始前に drift 検知して停止する
3. `create_branch=true` かつ `branch_transition_step` 指定時、遷移後ブランチで継続できる
4. `create_branch=false` で保護ブランチ（`main`）実行時は fail-fast する
5. `--allow-protected-branch` 指定時のみ保護ブランチ実行を許可する

## 5. テストケース

### TC-01: current branch 既定採用
- 条件: `feature/verify` 上で `create_branch=false`
- 手順: `wf-default.yaml` を実行
- 期待結果:
  - 実行成功
  - ログに `effective_base_branch: feature/verify`
  - ログに `effective_base_branch_source: current`

### TC-02: branch drift fail-fast
- 条件: 1つ目の step で `git checkout main` を実行
- 手順: `wf-drift.yaml` を実行
- 期待結果:
  - 実行失敗
  - `should_not_run` step の開始前に `Branch drift detected` が出力される

### TC-03: branch transition 許容
- 条件: `create_branch=true`, `branch_transition_step=branch`
- 手順: `wf-transition.yaml` を実行
- 期待結果:
  - 実行成功
  - `branch` step で作成した `feature/transition-pass` 上で `work` step が実行される

### TC-04: protected branch ブロック
- 条件: `main` 上で `create_branch=false`
- 手順: `wf-protected.yaml` を実行（override なし）
- 期待結果:
  - 実行失敗
  - `expected_work_branch "main" is protected` エラー

### TC-05: protected branch override 許可
- 条件: TC-04 と同条件
- 手順: `wf-protected.yaml` を `--allow-protected-branch` 付きで実行
- 期待結果:
  - 実行成功
  - ログに `allow_protected_branch: true`

## 6. 実行方法
```bash
bash tests/branch/run-branch-verification.sh
```

引数で検証ディレクトリを指定可能:
```bash
bash tests/branch/run-branch-verification.sh /tmp/my-branch-verify
```

## 7. 自動実行
- Makefile ターゲット: `make test-branch`
- CI ワークフロー: `.github/workflows/ci.yml`（`make test-all` 内で `test-branch` を実行）
