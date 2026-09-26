# worklog — Claude の作業ログ MCP / プラグイン

Claude Code の作業内容を **人間が読める Markdown** としてプロジェクト内の `.worklog/` に残す MCP サーバーと、その使い方を Claude に教えるスキル・フックのセットです。

- **人間向け**: 自動モードで最後まで走らせても「何を・なぜ・どうやったか」「人間が確認すべきこと」が後から追える
- **Claude 向け**: セッションが変わっても、プロジェクトの流れ・決定事項・残タスクを引き継げる

## 仕組み

| 構成要素 | 役割 |
|---|---|
| MCP サーバー (`dist/server.js`) | ログを書き読みするツールを提供 |
| スキル (`skills/worklog/SKILL.md`) | いつ・何を・どう記録するかを Claude に指示 |
| SessionStart フック (`dist/hook.js`) | セッション開始時に前回のまとめ・次にやること・要確認事項を Claude に渡す |

### 保存されるファイル

```
.worklog/
├── PROJECT.md        # プロジェクト全体の要約（概要 / 現在の状況 / 設計・重要な決定 / 未完了タスク / メモ）
├── TIMELINE.md       # セッション一覧（新しい順・状態と一行サマリつき）
└── sessions/
    └── 2026-09-26_1030_ログイン画面の改修.md
```

`.worklog/` は git にコミットして共有する想定です。人間が直接編集しても問題ありません。

セッションログの例：

```markdown
# ログイン画面の改修

- **開始**: 2026-09-26 10:30
- **終了**: 2026-09-26 11:10
- **状態**: 🟢 完了
- **ブランチ**: `feat/login`

## 🎯 目的

ログインフォームに入力バリデーションを追加する

## 📋 作業ログ

### 10:45 🧭 判断: zod を採用

**理由**: 既存 API とスキーマを共有できるため。yup も検討したが型推論が弱い

関連ファイル: `src/login.ts`

### 10:58 🙋 要確認: エラーメッセージの文言を確認してほしい

## 📝 まとめ

バリデーションを実装し、テストが通った。

## 🙋 人間の確認が必要な事項

- [ ] エラーメッセージの文言を確認してほしい

## ➡️ 次にやること

- [ ] E2E テストを追加
```

### ツール一覧

| ツール | 内容 |
|---|---|
| `worklog_get_context` | PROJECT.md と直近セッションのまとめ・次にやること・要確認を取得 |
| `worklog_start_session` | セッション開始（タイトル・目的）。ブランチは自動検出 |
| `worklog_log` | エントリ追加。種別: `task` 作業 / `decision` 判断（理由つき） / `issue` 問題 / `result` 成果 / `question` 要確認 / `note` メモ |
| `worklog_end_session` | まとめ・状態（完了/一部完了/ブロック）・次にやること・要確認を書いて終了。`question` は要確認に自動集約 |
| `worklog_update_project` | PROJECT.md のセクションを置き換え / 追記 |
| `worklog_search` | ログ全体を全文検索 |

## インストール

### A. プラグインとして入れる（推奨：MCP・スキル・フックがまとめて入る）

Claude Code で：

```
/plugin marketplace add GASHIRA-E/claude-section-mcp
/plugin install worklog@gashira-e
```

### B. MCP サーバーだけ入れる

```bash
claude mcp add worklog -- npx -y github:GASHIRA-E/claude-section-mcp
```

スキルも使う場合は `skills/worklog/` を `~/.claude/skills/`（全プロジェクト）またはプロジェクトの `.claude/skills/` にコピーしてください。

## 設定（環境変数）

| 変数 | 既定値 | 内容 |
|---|---|---|
| `WORKLOG_TZ` | システムのタイムゾーン | ログの時刻に使うタイムゾーン（例: `Asia/Tokyo`）。クラウド環境は UTC のことが多いので設定推奨 |
| `WORKLOG_LANG` | `ja` | 見出しなどの言語（`ja` / `en`） |
| `WORKLOG_ROOT` | MCP の roots → `CLAUDE_PROJECT_DIR` → カレントディレクトリ | `.worklog/` を置くプロジェクトのルート |
| `WORKLOG_RESUME_MINUTES` | `120` | サーバー再起動時、この分数以内に更新された進行中セッションを再開する |

プラグインで使う場合は、Claude Code の `settings.json` の `env` に書くと MCP サーバーとフックに渡ります：

```json
{ "env": { "WORKLOG_TZ": "Asia/Tokyo" } }
```

## 開発

```bash
npm install
npm run check   # 型チェック + テスト + ビルド
```

- ソースは `src/`、テストは `test/`（Node 22.18 以上の組み込み TypeScript 実行を使用）
- `dist/` は esbuild で依存込みの単一ファイルにバンドルしてコミットしています（プラグインとして `npm install` なしで動かすため）。`src/` を変更したら `npm run build` して `dist/` もコミットしてください
