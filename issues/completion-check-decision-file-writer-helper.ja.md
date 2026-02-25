# completion_check: decision_file を LLM に書かせない（runner/スクリプトで生成する）

ステータス: Open

関連:

- docs/issues/completion-check-decision-stability.ja.md
- issues/completion-check-check-id-templating.ja.md

## 問題

completion_check の “正規経路” が `decision_file` の structured JSON になったことで、workflow 側は次を worker に要求しがちになる。

- JSON 形式が正しい
- 必須キー（decision/check_id/reason 等）が揃う
- `check_id` が現行の completion check id と一致する

しかし実際には、LLM worker に strict JSON のファイル書き込みを要求するのは brittle で、次のような事故が起きる。

- JSON ではなく `PASS/FAIL` を書いてしまう
- JSON だが `check_id` がプレースホルダ（`$AGENTCORE_COMPLETION_CHECK_ID`）のまま
- 余計なコードフェンス/説明が混ざる

結果として `Completion check infrastructure failure` のような “中身の改善とは無関係な失敗” が発生し、ループが止まる。

## 根本方針

decision_file は **LLM ではなく runner か deterministic なスクリプト**が生成する。

LLM は以下のどれか “緩い出力” だけを提供する。

- 最終行 marker: `COMPLETE` / `INCOMPLETE`
- `PASS` / `FAIL`
- `verdict.txt` に `complete|incomplete`
- `verdict.json` に `{decision: ..., reasons: ...}`（ただし check_id は runner が付与）

## 提案（実装案）

### 案1: completion_check を CUSTOM に寄せる（JSON wrapper を生成）

workflow DSL:

- worker(LMM) は `.agentcore-loop/review.marker` に `COMPLETE/INCOMPLETE` を書く
- completion_check(CUSTOM script) が:
  - marker を読む
  - `AGENTCORE_COMPLETION_CHECK_ID` を env から取得
  - `decision_file` に JSON を確実に書く

この場合、LLM に check_id を触らせない。

### 案2: runner が “marker->JSON” を内蔵する

runner は `decision_file` を読む前に:

- worker 出力 marker（互換）を読み
- JSON に正規化して `decision_file` を自動生成（またはメモリ上で解釈）

### 案3: runner が decision_file の check_id を自動付与する

`decision_file` が JSON で `decision` を含むが `check_id` が欠ける場合:

- runner が現行 check_id を付与する（stale 防止は path/mtime 併用で担保）

## 受け入れ条件

- worker が shell を実行できない環境でも安定して completion_check が回る
- structured decision が必須でも `check_id` mismatch で落ちない
- 既存 workflow（PASS/FAIL, COMPLETE/INCOMPLETE）の後方互換を維持
