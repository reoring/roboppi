# BASE_BRANCH 指定依存によるブランチドリフトと誤変更リスク

ステータス: 提案

## 問題

controller loop 実行時に `BASE_BRANCH` の手動指定が前提になっており、指定漏れ・指定ミスがあると意図しないブランチ（例: `main`）を基点に workflow が進むことがある。

その結果:

- 実装対象と無関係な差分や削除が発生して見える
- 実行を停止してやり直す運用が発生する
- 「どのブランチを基点に実行されているか」の認知負荷が高い

## 観測された症状

- 実行開始時の想定ブランチと、実際に bootstrap/implement が触るブランチがずれるケースがある
- `BASE_BRANCH` の再指定や run script の再編集を何度も行う必要がある
- ログだけでは「有効な base branch」が即時に分かりづらい

## 根本原因

1. base branch の解決元が分散している（script/env/workflow 既定値）
2. 実行開始時の「現在ブランチ」がデフォルトとして扱われていない
3. 実行中にブランチずれが起きた場合の fail-fast ガードが弱い
4. branch 解決結果の可観測性（起動ログ/メタデータ出力）が不足している
5. `BASE_BRANCH` の意味（差分基点/作業ブランチ親）が曖昧で、実装と運用の解釈が揺れる

## 用語 / 仕様の前提

この issue では、branch drift を「起動時点で想定していた repo/branch/commit と、実行時点のそれが食い違うこと」と定義する。

- `startup_toplevel`: 起動時点の `git rev-parse --show-toplevel` の結果
- `startup_branch`: 起動時点のブランチ名（detached HEAD の場合は `HEAD` になり得る）
- `startup_head_sha`: 起動時点の `HEAD` の commit SHA
- `effective_base_branch`: base branch の解決結果（起動時に一度だけ確定）
- `effective_base_branch_source`: `cli|env|current` のどれで確定したか
- `effective_base_sha`: 起動時点での `effective_base_branch` の commit SHA（再現性のため固定）
- `expected_work_branch`: 実際に編集/コマンド実行を行うブランチ
- `expected_current_branch`: step 実行直前にいるべきブランチ（work branch 遷移を明示するための補助）
- `protected_branches`: 直接変更を原則禁止するブランチ群（例: `main`, `master`, `release/*`）
- `protected_branches_source`: `default|env|cli` のどれで `protected_branches` が確定したか
- `allow_protected_branch`: `protected_branches` ガードを一時的に無効化する明示 override（危険操作のため opt-in）

また `BASE_BRANCH` は、少なくとも以下 2 つの責務を持ち得るため、実装時に明示する。

1. `create_branch=true` の場合の「新規作成ブランチの親」
2. 差分表示/比較/安全ガードの「基点」

（将来的に責務分離が必要になった場合は、別パラメータ化を検討するが本 issue のスコープ外とする。）

## 目標

1. デフォルト動作を安全側に寄せる（起動時の現在ブランチを基点にする）
2. 明示 override（`BASE_BRANCH`）は維持する
3. 実行中のブランチドリフトを早期検知して停止する
4. 有効な branch 設定をログと成果物で追跡可能にする
5. 解決結果の「由来」と「基点 commit（SHA）」も残し、後追いで一意に再現できる

## 解決方針

## 1) BASE_BRANCH の解決順序を明確化

解決優先順位を固定する。

1. 明示指定（CLI オプションまたは `BASE_BRANCH`）
2. 未指定時は `git rev-parse --abbrev-ref HEAD`（起動時の現在ブランチ）

追加で以下を必須にする。

- 解決結果とともに `effective_base_branch_source` を出力/永続化する（`cli|env|current`）
- 起動時点の `effective_base_sha` を取得して context に保存する（branch 名だけに依存しない）
- detached HEAD の場合は、未指定時の `current` 解決を禁止して fail-fast する（通常ブランチ checkout を要求）
- `BASE_BRANCH` が明示指定され、かつ `startup_branch` と異なる場合は warning を出す（「差分基点は X、作業開始ブランチは Y」）

## 2) Branch Lock を導入

- 実行開始時に `effective_base_branch` を確定し context に保存する
- bootstrap / implement など各 step 前に現在ブランチを検証する
- 不一致時は即 `FAILED`（理由と復旧手順付き）

検証対象を branch 名だけに限定しない。

- 起動時に `startup_toplevel` / `startup_branch` / `startup_head_sha` を採取し保存する
- step 実行前フックで `startup_toplevel` と一致する repo 上で走っているかを検証する（worktree 取り違い検知）
- `expected_work_branch`（もしくは step ごとの `expected_current_branch`）を context に持ち、step 前に一致を検証する
- `create_branch=true` で正当にブランチ遷移する場合は、遷移点で `expected_*` を更新し、許容される遷移を明示する

## 3) ブランチ作成ポリシーを明示

- `create_branch` の既定値と挙動を workflow ごとに明記する
- `create_branch=false` の場合、既存ブランチ上でのみ実行
- `create_branch=true` の場合、作成先・親ブランチを起動時に明示ログ出力

安全ガードを追加する。

- `create_branch=false` かつ `expected_work_branch` が `protected_branches` に一致する場合はデフォルトで停止する（明示 override がある場合のみ許可）
- `create_branch=true` の場合、親ブランチ名だけでなく `effective_base_sha` から作成したことをログ/成果物で保証する

`protected_branches` の既定と override 手段をここで固定する。

- 既定値: `protected_branches = ["main", "master", "release/*"]`
  - 目的: main/master 直変更事故を防ぎつつ、release 系ブランチの誤変更も抑止する
  - 判定対象: `effective_base_branch` ではなく **`expected_work_branch`**（実際に変更を加えるブランチ）
- パターン仕様: `*` を含む場合は glob として扱う（例: `release/*`）。それ以外は完全一致。
- 設定（リスト上書き）:
  - CLI: `--protected-branches <csv>`（例: `main,master,release/*`）
  - env: `ROBOPPI_PROTECTED_BRANCHES=<csv>`
  - 優先順位: CLI > env > default
- 一時 override（ガード無効化; 危険操作なので明示が必要）:
  - CLI: `--allow-protected-branch`
  - env: `ROBOPPI_ALLOW_PROTECTED_BRANCH=1`
  - override 有効時も、起動ログ/context に `allow_protected_branch: true` を残し、強い warning を出す

## 4) 可観測性の強化

起動直後に最低限以下を出力する。

- `startup_branch`
- `startup_head_sha`
- `startup_toplevel`
- `effective_base_branch`
- `effective_base_branch_source`
- `effective_base_sha`
- `create_branch`
- `expected_work_branch`（必要に応じて）
- `protected_branches` / `protected_branches_source`
- `allow_protected_branch`（必要に応じて）

あわせて `context/_workflow.json` などにも同情報を残し、後追い調査を容易にする。

## 実装計画

1. run 起動時の branch 解決処理を共通化
2. `effective_base_branch` を workflow context に永続化
3. step 実行前の branch 検証フックを追加
4. mismatch 時のエラーメッセージを定型化
5. run script / docs を「現在ブランチ既定」前提に更新
6. `effective_base_branch_source` / `effective_base_sha` / `startup_head_sha` / `startup_toplevel` の schema を追加し、成果物に含める
7. `protected_branches` resolver（既定 + `ROBOPPI_PROTECTED_BRANCHES` + `--protected-branches`）を追加
8. `protected_branches` ガードと明示 override（`ROBOPPI_ALLOW_PROTECTED_BRANCH` / `--allow-protected-branch`）を追加し、ログに理由を残す

## 受け入れ条件

1. `BASE_BRANCH` 未指定で起動した場合、起動時の現在ブランチが自動採用される
2. 実行中に branch が想定とずれたら、実装 step に入る前に停止する
3. 起動ログと context から有効 branch 設定（branch 名/由来/SHA）を一意に確認できる
4. `BASE_BRANCH` 明示指定時は override される（必要なら warning を表示）
5. `create_branch=false` で保護ブランチに対して実行しようとすると、明示 override（`ROBOPPI_ALLOW_PROTECTED_BRANCH=1` または `--allow-protected-branch`）がない限り停止する
6. `ROBOPPI_PROTECTED_BRANCHES` / `--protected-branches` 未指定時、`protected_branches` は既定の `main,master,release/*` で確定し、`protected_branches_source=default` になる
7. `ROBOPPI_PROTECTED_BRANCHES` または `--protected-branches` 指定時、`protected_branches` が上書きされ、`protected_branches_source` が `env|cli` として記録される
8. `ROBOPPI_ALLOW_PROTECTED_BRANCH=1` または `--allow-protected-branch` 指定時、`allow_protected_branch=true` がログ/context に記録される

## 非目標

- 自動 rebase/merge 戦略の導入
- 既存 workflow 全面刷新

## 既知リスクと緩和

1. Detached HEAD で起動された場合の扱い
- 緩和: 起動時に明示エラーとして停止し、通常ブランチ checkout を要求する

2. 複数 worktree 利用時の誤認識
- 緩和: `git rev-parse --show-toplevel` と branch 情報をセットでログに残す

3. 既存ユーザーの運用差分
- 緩和: 互換モード（明示 `BASE_BRANCH` 優先）を維持しつつ段階移行する

4. 保護ブランチへの直接変更事故
- 緩和: `protected_branches` ガードをデフォルト有効にし、明示 override がない限り fail-fast する

5. `release/*` 既定が運用をブロックする可能性
- 緩和: `ROBOPPI_PROTECTED_BRANCHES` / `--protected-branches` で `main,master` のみに絞れる。緊急時は `ROBOPPI_ALLOW_PROTECTED_BRANCH=1` / `--allow-protected-branch` を明示し warning 付きで通す
