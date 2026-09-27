# worklog

Claude Code 用のプラグインです。Claude と作ってきたものについて **「いつ・なぜそうなったか」を、人間も Claude もタグから引ける状態** にしておきます。

- 自動モードで最後まで走らせても、何をしたか・何を確認すべきかが後から分かる
- セッションをまたいでも、Claude がプロジェクトの経緯を把握できる

詳しい仕様は [docs/SPEC.md](docs/SPEC.md) を参照してください。

## 仕組み

| 誰が | 何を記録するか |
|---|---|
| hook（自動） | 人間の指示文、変更したファイル、主なコマンド、テストの成否 |
| Claude（スキルの指示で） | 決定とその理由、問題、成果、人間への確認事項、まとめ。すべてにタグを付ける |

記録はすべて「投稿」として `.worklog/sessions/` に溜まります。

- **タグで逆引き**：ある話題について、思いつき → 決定 → 確認 → 回答 → 成果の流れを時系列でたどれる
- **引き継ぎ**：セッション開始時に、前回のまとめ・次にやること・未解決の確認事項を Claude に渡す
- **自動モードの終了チェック**：作業したのに何も投稿せずに終わろうとしたら、1回だけ止めて投稿させる
- **HTML ビューア**：セッション / タグ / 要対応 の画面で、ブラウザやスマホから見られる。セッションはチャット形式（指示・決定・要確認・返答が吹き出しで流れ、その間の試行錯誤は1行に畳まれる）。フィルタは付けず、情報の重みづけで見やすくしている
- **自動要約**：長い指示と返答は、裏で軽量モデルが1文に要約する（作業は待たせない）

## インストール

Node.js 20 以上が必要です。

### 手元の PC で使う

Claude Code で：

```
/plugin marketplace add GASHIRA-E/claude-section-mcp
/plugin install worklog@gashira-e
```

MCP サーバー・スキル・hook がまとめて入ります。

### クラウド（claude.ai/code）でも使う

クラウドのセッションには手元でインストールしたプラグインが入らないため、**導入先リポジトリの `.claude/settings.json`** に書いてコミットします。手元の Claude Code でも、このリポジトリを開けば同じ設定で有効になります。

```json
{
  "extraKnownMarketplaces": {
    "gashira-e": { "source": { "source": "github", "repo": "GASHIRA-E/claude-section-mcp" } }
  },
  "enabledPlugins": { "worklog@gashira-e": true },
  "env": { "WORKLOG_TZ": "Asia/Tokyo" }
}
```

### 導入前に決めておくこと

- **記録をコミットするか**：既定では `.worklog/sessions/` をコミットします。チームのリポジトリでは、**あなたの指示文（最大1000字）や Claude の返答が、リポジトリを見られる全員に見える** ことになります。避けたい場合は `WORKLOG_COMMIT=false` にします（ただしクラウドのセッションでは、終了すると記録が消えます）
- **指示に秘密情報を書かない**：指示文はそのまま記録されます
- **要約のコスト**：長い指示・返答は Haiku で要約します（1ターン数百トークン程度）。不要なら `WORKLOG_SUMMARIZE=false`

## ファイル

```
.worklog/
├── sessions/                          # 投稿（コミットする）
│   └── 2026-09-26_1330_1abd214d.jsonl #   Claude のセッションごとに1ファイル
├── view/                              # HTML ビューア（コミットしない・自動生成）
├── .state/                            # hook の一時状態（コミットしない）
├── .gitignore
└── .gitattributes                     # GitHub の差分表示で投稿ファイルを折りたたむ
```

投稿はセッションごとに別ファイルなので、複数のブランチで作業してもマージで衝突しません。

## ログを見る

Claude に「作業ログを見せて」と頼むと、ビューアを作り直します。

- 手元の PC：`.worklog/view/index.html` をブラウザで開く
- クラウド：Claude が Artifact として公開し、リンクを渡す

ビューアは Claude が返答を終えるたびにも自動で更新されます。

## 設定（環境変数）

`settings.json` の `env` に書くと、MCP サーバーと hook の両方に渡ります。

| 変数 | 既定値 | 内容 |
|---|---|---|
| `WORKLOG_COMMIT` | `true` | `false` にすると `.worklog/` 全体をコミット対象外にする（手元だけで使うプロジェクト向け） |
| `WORKLOG_TZ` | システムの設定 | ファイル名と投稿 ID に使うタイムゾーン（例：`Asia/Tokyo`）。ビューアの表示は見る側のタイムゾーン |
| `WORKLOG_ROOT` | プロジェクトのルート | `.worklog/` を置く場所 |
| `WORKLOG_SUMMARIZE` | `true` | `false` にすると、長い指示・返答の自動要約をしない |
| `WORKLOG_SUMMARY_MODEL` | `haiku` | 要約に使うモデル |

```json
{ "env": { "WORKLOG_TZ": "Asia/Tokyo" } }
```

## 開発

```bash
npm install
npm run check   # 型チェック + テスト + ビルド
```

- ソースは `src/`、テストは `test/`（Node 22.18 以上の組み込み TypeScript 実行を使用）
- `dist/` はプラグインが `npm install` なしで動くよう、依存込みでバンドルしてコミットしています。`src/` を変更したら `npm run build` して `dist/` もコミットしてください
