---
name: worklog
description: Keep a human-readable work log of what Claude does in this project (.worklog/) and pick up project history from previous sessions. Use at the start of any non-trivial task (implementation, refactor, investigation, bug fix), especially in auto mode or long autonomous runs, and when wrapping up a task. 作業ログ・作業記録・引き継ぎ・セッションをまたいだ文脈の保持に使う。
---

# 作業ログ（worklog）

このプロジェクトでは、Claude の作業内容を **人間が後から読んで流れを追える形** で `.worklog/` に残す。
目的は2つ：

1. **人間向けの記録** — 自動モードで最後まで走らせたときでも「何を・なぜ・どうやったか」「人間が確認すべきこと」が分かるようにする
2. **Claude 自身の引き継ぎ** — セッションが変わってもプロジェクト全体の流れ・決定事項・残タスクを把握できるようにする

ログは `worklog` MCP サーバーのツール経由で書く（ファイルを直接編集しない）。

## 流れ

### 1. 作業を始める前

1. `worklog_get_context` を呼び、`PROJECT.md` と直近セッションの「まとめ / 次にやること / 要確認」を読む
   - 前回の「次にやること」や「要確認」が今回の依頼に関係するなら、それを踏まえて進める
2. `worklog_start_session` でセッションを開始する
   - `title`: 作業の短い名前（ユーザーの言語で）
   - `goal`: 依頼内容と目的を、その場にいなかった人にも伝わる形で

ちょっとした質問への回答や1〜2行の修正など、記録する価値のない軽い作業ではセッションを作らなくてよい。

### 2. 作業中

区切りごとに `worklog_log` で記録する。**コマンド1回ごとではなく、意味のある節目ごと**に書く。目安として1セッション数件〜十数件。

| kind | いつ使うか |
|---|---|
| `task` | まとまった作業をした（何を・どう変えたか） |
| `decision` | 方針を選んだ。**`reason` に理由と検討した代替案を必ず書く** |
| `issue` | 問題・失敗・想定外に遭遇した（原因と対処も） |
| `result` | 完了・検証できた成果（テスト通過、機能完成など） |
| `question` | 人間に確認・判断してほしいこと。終了時に「人間の確認が必要な事項」へ自動で集約される |
| `note` | その他、後で役立つメモ |

書き方のポイント：

- `summary` は一行の見出し、`details` に Markdown で本文。関係ファイルは `files` に
- その場にいなかったチームメイトが読んで分かるように書く（内部の試行錯誤の羅列ではなく、要点と理由）
- **自動モードでは**、人間に聞けずに仮の判断で進めた箇所を必ず `decision`（理由つき）や `question` として残す。後で人間がレビューする起点になる
- 秘密情報（APIキー、パスワード、個人情報など）はログに書かない

### 3. 作業を終えるとき

1. `worklog_end_session` を呼ぶ
   - `summary`: 何を達成したか、何が変わったか、今どういう状態か
   - `status`: `completed`（目的達成） / `partial`（一部残り） / `blocked`（助けが必要）
   - `next_steps`: 次のセッションや人間がやるべき具体的な作業
   - `needs_review`: `question` 以外に人間に見てほしい点
2. プロジェクト全体に関わる変化があれば `worklog_update_project` で `PROJECT.md` を更新する
   - `status`（現在の状況）: 最新の状態に **replace**
   - `decisions`（設計・重要な決定）: `- YYYY-MM-DD: 決定内容（理由）` の形で **append**
   - `todos`（未完了タスク・課題）: 現在の一覧に **replace**（終わったものは消す）
   - `overview`（概要）: プロジェクトの目的や構成が分かったら記入・更新

ユーザーへの最終報告の前に終了処理を済ませること。途中で中断する場合も、可能なら `partial` や `blocked` で閉じておく。

## 過去の経緯を調べたいとき

`worklog_search` で「いつ・なぜその変更をしたか」を検索できる。

## ファイル構成（参考）

```
.worklog/
├── PROJECT.md        # プロジェクト全体の要約（セッションをまたいで引き継ぐ情報）
├── TIMELINE.md       # セッション一覧（新しい順）
└── sessions/
    └── 2026-09-26_1030_ログイン画面の改修.md   # セッションごとの詳細ログ
```

`.worklog/` は git にコミットして共有する前提。
