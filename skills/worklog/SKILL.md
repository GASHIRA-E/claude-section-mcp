---
name: worklog
description: Record what Claude does in this project, and why, in a tag-searchable work log (.worklog/), and pick up the project's history from earlier sessions. Use whenever doing non-trivial work (implementation, refactor, investigation, bug fix) — especially in auto mode or long unattended runs — and before changing something whose background you don't know. 作業ログ・経緯の記録・タグでの逆引き・セッションをまたいだ引き継ぎ。
---

# 作業ログ（worklog）

このプロジェクトでは、Claude と作ってきたものについて **「いつ・なぜそうなったか」を、人間も Claude もタグから引ける状態** に保つ。
仕様書は作らない。投稿を積み重ね、タグで逆引きできればよい。

## 分担

| 誰が | 何を |
|---|---|
| hook（自動） | 人間の指示文、変更したファイル、主なコマンド、テストの成否 |
| **あなた（Claude）** | **意味の部分**：決定とその理由、問題、成果、人間への確認事項、まとめ |

自動記録と同じこと（「page.tsx を編集した」など）を書き直さない。**なぜ・何が決まったか・何が分かったか** を書く。

## 始めるとき

- セッション開始時に、前回のまとめと未解決の確認事項が渡される。関係があれば踏まえて進める
- 詳しく知りたいときは `worklog_context` を呼ぶ
- **既存の機能に手を入れる前は** `worklog_tag` でその話題の経緯を確認する（過去の決定を知らずに覆さないため）

## 作業中：`worklog_post`

意味のある節目ごとに投稿する。コマンド1回ごとではない。目安は1タスク数件。

| kind | いつ |
|---|---|
| `decision` | 方針を選んだ。`reason` に理由と、検討した代替案を書く。**ビューアではチャットの吹き出しとして目立つ位置に出る**ので、人間に伝えたい決定は必ずこれで残す |
| `question` | 人間に確認・判断してほしいこと。**自動モードで人間に聞けず仮の判断で進めたときは必ず書く** |
| `result` | 完成・検証できたこと（テスト通過、動作確認など） |
| `issue` | 問題・失敗・想定外（原因と対処も） |
| `idea` | 人間の思いつきや要望で、残しておく価値があるもの |
| `note` | その他、後で役立つこと |
| `summary` | タスクの区切り。何をしたか・今の状態・`next_steps`。次のセッションに引き継がれる |

書き方：

- その場にいなかった人が読んで分かるように、ユーザーの言語で書く
- 関連する投稿があれば `reply_to` でつなぐ（例：思いつき → それを実装した決定）
- `issue` を解決したら、その issue に `reply_to` して `result`（どう解決したか）を投稿する。ビューアで「解決済み」と表示される
- 秘密情報（API キー、パスワード、個人情報）は書かない

### タグ

- すべての投稿に、話題を表すタグを1〜3個付ける（機能・画面・仕組みの名前など。例：`支出入力`、`認証`、`CI`）
- タグは **人間がその話題を呼ぶときの言葉** にする。ユーザーの言語で書き、`lib` や `src` のようなディレクトリ名・ファイル名はタグにしない（ファイルは `files` に書く）
- **既存のタグを優先して使う**。一覧は `worklog_context` とセッション開始時の案内に出る
- 同じ意味の別表記に気づいたら（`login` と `ログイン` など）、勝手にそろえず `question` で人間に提案する

## 確認事項に返事をもらったら：`worklog_answer`

人間が質問に答えたら、`worklog_answer` で質問の ID に回答を記録する。それで何かが決まったら `decision` も投稿する。

## 終えるとき

タスクの区切りや、ユーザーへの最終報告の前に `summary` を投稿する（`next_steps` つき）。
自動モードでは、作業したのに何も投稿していないと終了前に促される。

## ログを見せるとき

人間が「ログを見たい」と言ったら `worklog_view` を呼ぶ（`/worklog:view` コマンドでも同じことをする）。

- 手元の PC なら、返ってきた `page`（`.worklog/view/index.html`）をブラウザで開くよう案内する
- クラウド（claude.ai/code など）で Artifact を公開できるなら、`artifact` のファイルを Artifact として公開してリンクを渡す

## コミット

`.worklog/sessions/*.jsonl` はコードと一緒にコミットする（クラウドではコンテナが消えるため）。`view/` と `.state/` は自動でコミット対象外になっている。
