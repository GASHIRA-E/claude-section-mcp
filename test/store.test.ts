import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { buildContext, buildHookContext } from "../src/context.ts";
import { slugify, WorklogStore } from "../src/store.ts";

let root: string;
let clock: Date;
const makeStore = (lang: "ja" | "en" = "ja") => new WorklogStore(root, { lang, timeZone: "Asia/Tokyo", now: () => clock });
const read = (rel: string) => fs.readFile(path.join(root, ".worklog", rel), "utf8");

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "worklog-test-"));
  clock = new Date("2026-09-26T01:30:00Z"); // 10:30 JST
});

describe("sessions", () => {
  it("writes a readable session log and keeps the timeline in sync", async () => {
    const store = makeStore();
    const info = await store.startSession({ title: "ログイン画面の改修", goal: "バリデーションを追加する", branch: "feat/login" });
    assert.equal(info.file, "2026-09-26_1030_ログイン画面の改修.md");

    clock = new Date("2026-09-26T01:45:00Z");
    await store.appendEntry(info.file, {
      kind: "decision",
      summary: "zod を採用",
      details: "フォームの検証ライブラリを選定。",
      reason: "既存 API と型を共有できるため",
      files: ["src/login.ts"],
    });
    await store.appendEntry(info.file, { kind: "question", summary: "エラーメッセージの文言を確認してほしい" });

    clock = new Date("2026-09-26T02:10:00Z");
    const ended = await store.endSession(info.file, {
      summary: "バリデーションを実装し、テストが通った。",
      status: "completed",
      nextSteps: ["E2E テストを追加"],
      needsReview: ["デザインとの差分"],
    });

    const log = await read(`sessions/${info.file}`);
    assert.match(log, /^# ログイン画面の改修$/m);
    assert.match(log, /- \*\*開始\*\*: 2026-09-26 10:30/);
    assert.match(log, /- \*\*終了\*\*: 2026-09-26 11:10/);
    assert.match(log, /- \*\*状態\*\*: 🟢 完了/);
    assert.match(log, /- \*\*ブランチ\*\*: `feat\/login`/);
    assert.match(log, /### 10:45 🧭 判断: zod を採用\n\nフォームの検証ライブラリを選定。\n\n\*\*理由\*\*: 既存 API と型を共有できるため\n\n関連ファイル: `src\/login.ts`/);
    assert.match(log, /## 🙋 人間の確認が必要な事項\n\n- \[ \] エラーメッセージの文言を確認してほしい\n- \[ \] デザインとの差分/);
    assert.match(log, /## ➡️ 次にやること\n\n- \[ \] E2E テストを追加/);

    assert.equal(ended.status, "completed");
    assert.deepEqual(ended.questions, ["エラーメッセージの文言を確認してほしい"]);

    const timeline = await read("TIMELINE.md");
    assert.match(timeline, /\| 2026-09-26 10:30 \| \[ログイン画面の改修\]\(sessions\/2026-09-26_1030_ログイン画面の改修\.md\) \| 🟢 完了 \| バリデーションを実装し、テストが通った。 \|/);
  });

  it("lists newest sessions first in the timeline and avoids file name collisions", async () => {
    const store = makeStore();
    const a = await store.startSession({ title: "A" });
    const b = await store.startSession({ title: "A" });
    assert.equal(b.file, "2026-09-26_1030_A-2.md");
    const rows = (await read("TIMELINE.md")).split("\n").filter((l) => l.includes("(sessions/"));
    assert.deepEqual(
      rows.map((r) => /\(sessions\/(.+?)\)/.exec(r)?.[1]),
      [b.file, a.file],
    );
  });

  it("escapes pipes in timeline cells", async () => {
    const store = makeStore();
    await store.startSession({ title: "a | b", goal: "x | y" });
    assert.match(await read("TIMELINE.md"), /\[a \\\| b\].*\| x \\\| y \|/);
  });

  it("resumes only recent in-progress sessions", async () => {
    const store = makeStore();
    const open = await store.startSession({ title: "open" });
    assert.equal(await store.findResumableSession(60 * 60_000), open.file);
    await store.endSession(open.file, { summary: "done", status: "completed" });
    assert.equal(await store.findResumableSession(60 * 60_000), undefined);

    await store.startSession({ title: "stale" });
    clock = new Date(Date.now() + 3 * 60 * 60_000);
    assert.equal(await store.findResumableSession(60 * 60_000), undefined);
  });

  it("auto-closes an abandoned session as partial", async () => {
    const store = makeStore();
    const s = await store.startSession({ title: "abandoned" });
    await store.autoClose(s.file);
    const info = await store.readSession(s.file);
    assert.equal(info.status, "partial");
    assert.match(info.summary ?? "", /自動的に閉じました/);
  });

  it("supports English labels", async () => {
    const store = makeStore("en");
    const s = await store.startSession({ title: "Refactor" });
    await store.appendEntry(s.file, { kind: "question", summary: "Is the API stable?" });
    const info = await store.endSession(s.file, { summary: "Done.", status: "blocked" });
    assert.equal(info.status, "blocked");
    assert.match(await read(`sessions/${s.file}`), /## 🙋 Needs human review\n\n- \[ \] Is the API stable\?/);
  });
});

describe("project notes", () => {
  it("creates a template and replaces or appends sections", async () => {
    const store = makeStore();
    await store.ensureInit();
    assert.match((await store.readProject()) ?? "", /## 現在の状況\n\n（未記入）/);

    await store.updateProject("status", "ログイン機能を実装中。", "replace");
    await store.updateProject("decisions", "- 2026-09-26: zod を採用", "append");
    await store.updateProject("decisions", "- 2026-09-27: Vitest に移行", "append");
    await store.updateProject("現在の状況", "ログイン機能は完了。", "replace");
    await store.updateProject("デプロイ手順", "`npm run deploy`", "append");

    const project = (await store.readProject()) ?? "";
    assert.match(project, /## 現在の状況\n\nログイン機能は完了。\n\n## 設計・重要な決定/);
    assert.match(project, /## 設計・重要な決定\n\n- 2026-09-26: zod を採用\n- 2026-09-27: Vitest に移行\n\n## 未完了タスク・課題/);
    assert.match(project, /## デプロイ手順\n\n`npm run deploy`\n$/);
    assert.equal((project.match(/## 現在の状況/g) ?? []).length, 1);
  });
});

describe("context and search", () => {
  it("summarises recent sessions for the next Claude session", async () => {
    const store = makeStore();
    assert.match(await buildContext(store, { sessions: 3 }), /No worklog exists/);

    const s = await store.startSession({ title: "初回セットアップ", goal: "雛形を作る" });
    await store.appendEntry(s.file, { kind: "question", summary: "ライセンスは MIT で良い？" });
    await store.endSession(s.file, { summary: "雛形を作成。", status: "partial", nextSteps: ["CI を追加"] });

    const ctx = await buildContext(store, { sessions: 3 });
    assert.match(ctx, /# Project notes/);
    assert.match(ctx, /## 初回セットアップ/);
    assert.match(ctx, /status: partial/);
    assert.match(ctx, /Next steps:\n- \[ \] CI を追加/);
    assert.match(ctx, /Needs human review:\n- \[ \] ライセンスは MIT で良い？/);

    const hook = await buildHookContext(store);
    assert.match(hook, /Last session: "初回セットアップ"/);
    assert.match(hook, /CI を追加/);
  });

  it("finds text across all log files", async () => {
    const store = makeStore();
    const s = await store.startSession({ title: "Search me" });
    await store.appendEntry(s.file, { kind: "note", summary: "Redis のキャッシュ設定を変更" });
    const hits = await store.search("redis", 10);
    assert.equal(hits.length, 1);
    assert.match(hits[0], /^\.worklog\/sessions\/.+\.md:\d+: ### \d{2}:\d{2} 💬 メモ: Redis/);
  });
});

describe("slugify", () => {
  it("keeps letters in any script and drops punctuation", () => {
    assert.equal(slugify("Fix: login / 認証 バグ!!"), "Fix-login-認証-バグ");
    assert.equal(slugify("???"), "session");
  });
});
