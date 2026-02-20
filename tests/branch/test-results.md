# Branch Lock / Base Branch テスト結果

## 1. 実施情報
- 実施日時 (UTC): 2026-02-15T11:07:11Z
- 実施日時 (Local): 2026-02-15T20:07:11+0900
- 実施環境:
  - `bun 1.3.8`
  - `git version 2.53.0`
- 実行コマンド:
  - `bash tests/branch/run-branch-verification.sh`
- 検証ディレクトリ:
  - `/tmp/agentcore-branch-verify-rT3LQh`
- ログディレクトリ:
  - `/tmp/agentcore-branch-verify-rT3LQh/logs`

## 2. 結果サマリ

| Test Case | 内容 | 期待 | 結果 | 判定 |
|---|---|---|---|---|
| TC-01 | `BASE_BRANCH` 未指定で current branch 採用 | `effective_base_branch=feature/verify` | `out-default.log` で確認 | PASS |
| TC-02 | branch drift fail-fast | `should_not_run` 実行前に停止 | `Branch drift detected` で失敗終了 | PASS |
| TC-03 | `create_branch=true` 遷移許容 | 遷移後ブランチで後続 step 実行 | `branch_transition_step: branch` + Workflow SUCCEEDED | PASS |
| TC-04 | protected branch ブロック | `main` で fail-fast | `expected_work_branch "main" is protected` | PASS |
| TC-05 | protected branch override | `--allow-protected-branch` で実行可 | `allow_protected_branch: true` + Workflow SUCCEEDED | PASS |

## 3. 主要ログ抜粋

### TC-01 (`out-default.log`)
- `effective_base_branch: feature/verify`
- `effective_base_branch_source: current`
- `Workflow: SUCCEEDED`

### TC-02 (`out-drift.log`)
- `Branch drift detected before step "should_not_run" ...`
- `Workflow: FAILED`

### TC-03 (`out-transition.log`)
- `branch_transition_step: branch`
- `Workflow: SUCCEEDED`

### TC-04 (`out-protected-block.log`)
- `Error: blocked: expected_work_branch "main" is protected ...`

### TC-05 (`out-protected-allow.log`)
- `allow_protected_branch: true`
- `[workflow][warn] allow_protected_branch=true ...`
- `Workflow: SUCCEEDED`

## 4. 総合判定
- 全 5 ケース PASS
- 仕様書 (`tests/branch/test-spec.md`) 記載の観点を満たした
