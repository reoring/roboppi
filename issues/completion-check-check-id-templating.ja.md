# completion_check: decision_file の check_id 注入が brittle（$ENV がそのまま書かれる）

ステータス: Open

関連:

- docs/issues/0003-completion-check-decision-stability.ja.md

## 問題

completion_check の `decision_file` が JSON であっても、`check_id` が現在のチェック ID と一致しない場合、runner が以下のように扱って workflow が落ちる。

- `stale decision_file check_id mismatch`
- `Completion check infrastructure failure repeated`

現場の典型パターン:

- worker に「`check_id` は `$AGENTCORE_COMPLETION_CHECK_ID` を使え」と指示する
- worker が **環境変数を展開できず**、文字列 `$AGENTCORE_COMPLETION_CHECK_ID` をそのままファイルに書く
- runner は mismatch を stale とみなして FAIL

これは「プロンプト調整の問題」ではなく、**runner と worker のインターフェイス設計**の問題になっている。

## 再現（最小）

1. workflow で completion_check に `decision_file: .agentcore-loop/review.verdict` を指定
2. completion_check の instructions に次を要求

```json
{"decision":"incomplete","check_id":"$AGENTCORE_COMPLETION_CHECK_ID","reason":"not-ready"}
```

3. 実行すると runner が `check_id_match=false` で停止する

## 期待（理想）

- worker が shell を実行できない/しない場合でも `check_id` を正しく書ける
- `check_id` mismatch が起きても、少なくとも「直し方」が明確で、即 hard-fail にならない

## 根本解決案（候補）

### 案A: runner が check_id を “文字列として” prompt に注入する

worker は env var を読めないことがあるため、runner が instructions の先頭に **実値**を埋め込む。

例:

- `CompletionCheckID: <uuid>` を固定フォーマットで提示
- workflow DSL に `{{completion_check_id}}` のようなテンプレートを導入し、runner が展開

Pros:

- LLM の出力だけで `check_id` が成立
- 最も小さい変更で効果が大きい

Cons:

- workflow DSL のテンプレート導入（または自動注入）の設計が必要

### 案B: decision_file の path を check_id で一意化（content で持たない）

`decision_file` を固定パスではなく、check_id を含むファイル名にする。

例:

- `.agentcore-loop/review.verdict.<uuid>.json`

runner は **その check_id のファイルだけ**を読む。

Pros:

- mismatch の概念が消える

Cons:

- artifact/cleanup/outputs の扱いが変わる

### 案C: runner が JSON wrapper を生成し、worker には marker だけ要求

worker 出力（または別ファイル）から `COMPLETE/INCOMPLETE` / `PASS/FAIL` を受け取り、runner が check_id を付与して JSON 化する。

Pros:

- LLM に strict な JSON ファイル書き込みを要求しない

Cons:

- runner 側の仕様追加が必要（decision_source の優先順位も含む）

### 案D: mismatch を “infra failure” ではなく “INCOMPLETE + actionable” にする

`check_id` mismatch は、実運用では「worker が書き方を間違えた」ケースが多い。

- hard-fail ではなく INCOMPLETE として次 iteration で上書き可能にする
- エラーメッセージに `expected=<uuid> got=<value>` を必ず含める
- 可能なら `suggested_fix: rm -f <decision_file>` のようなガイドを出す

## 受け入れ条件

- `decision_file` が JSON で `decision` を含む場合、`check_id` を worker が確実に正しく書ける（少なくとも案A/B/C のいずれかで達成）
- `check_id` mismatch が発生しても、workflow が “インフラ故障” として即死しない（INCOMPLETE で継続できる or 明確な修正指示が出る）
- unit test で以下をカバー
  - `check_id` 正常一致
  - `check_id` 不一致（stale/誤記/プレースホルダ）
  - JSON 形式エラー
