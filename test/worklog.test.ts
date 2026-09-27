import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import { handleHook, type HookInput } from "../src/hooks.ts";
import { buildContext, buildHookContext, openQuestions, postsForTag, relatedTags, tagStats } from "../src/query.ts";
import { normalizeTags, Worklog } from "../src/store.ts";
import { renderViewer, writeViewer } from "../src/viewer.ts";

let root: string;
let clock: Date;
let log: Worklog;
const SID = "1abd214d-72b9-58c9-a905-9a4f761bc90f";
const tick = (minutes = 1) => (clock = new Date(clock.getTime() + minutes * 60_000));
const hook = (event: string, input: HookInput = {}) => handleHook(event, { session_id: SID, ...input }, log, "Asia/Tokyo");

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "worklog-test-"));
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/feat/receipt\n");
  clock = new Date("2026-09-26T04:30:00Z"); // 13:30 JST
  log = new Worklog(root, { now: () => clock, timeZone: "Asia/Tokyo" });
});

describe("store", () => {
  it("keeps one JSONL file per Claude session with git housekeeping files", async () => {
    const session = await log.session(SID);
    assert.equal(session, "2026-09-26_1330_1abd214d");
    assert.equal(await log.session(SID), session, "same Claude session → same file");

    const post = await log.append(session, { author: "claude", kind: "decision", text: "確認画面を挟む", tags: ["#レシート読み取り"], reason: "誤読があるため" });
    assert.match(post.id, /^0926-1330-[a-z2-9]{3}$/);
    assert.deepEqual(post.tags, ["レシート読み取り"]);

    const { meta, posts } = await log.readSession(session);
    assert.equal(meta?.branch, "feat/receipt");
    assert.equal(posts.length, 1);
    assert.equal(await fs.readFile(path.join(root, ".worklog/.gitignore"), "utf8"), "# Rebuilt from the session logs; not worth committing.\n.state/\nview/\n");
    assert.match(await fs.readFile(path.join(root, ".worklog/.gitattributes"), "utf8"), /\*\.jsonl linguist-generated=true/);
  });

  it("ignores the whole folder when commits are turned off", async () => {
    await new Worklog(root, { commit: false }).init();
    assert.match(await fs.readFile(path.join(root, ".worklog/.gitignore"), "utf8"), /^\*$/m);
  });

  it("applies summary patches without rewriting the log", async () => {
    const session = await log.session(SID);
    const prompt = await log.append(session, { author: "human", kind: "prompt", text: "長い指示".repeat(50) });
    await log.patch(session, { patch: prompt.id, summary: "短い要約" });
    assert.equal((await log.readSession(session)).posts[0].summary, "短い要約");
    assert.equal((await log.readSession(session)).posts.length, 1);
  });

  it("skips broken lines instead of failing", async () => {
    const session = await log.session(SID);
    await log.append(session, { author: "claude", kind: "note", text: "ok" });
    await fs.appendFile(log.sessionPath(session), "{not json\n");
    assert.equal((await log.readSession(session)).posts.length, 1);
  });

  it("normalizes tags to existing spellings", () => {
    assert.deepEqual(normalizeTags(["#API", "ａｐｉ", " ログイン ", "", "new tag"], ["api"]), ["api", "ログイン", "new_tag"]);
  });
});

describe("queries", () => {
  it("tracks open questions, tag stats, related tags and reverse lookup", async () => {
    const s = await log.session(SID);
    const q = await log.append(s, { author: "claude", kind: "question", text: "締め日は25日？", tags: ["レポート"] });
    tick();
    await log.append(s, { author: "claude", kind: "decision", text: "月初〜月末で集計", tags: ["レポート", "カテゴリ"] });
    tick();
    const q2 = await log.append(s, { author: "claude", kind: "question", text: "色は？", tags: ["UI"] });
    tick();
    const a = await log.append(s, { author: "claude", kind: "answer", text: "25日にする", re: q.id });

    const { posts } = await log.readAll();
    assert.deepEqual(openQuestions(posts).map((p) => p.id), [q2.id]);
    assert.deepEqual(tagStats(posts).map((t) => [t.tag, t.count]), [["レポート", 2], ["UI", 1], ["カテゴリ", 1]]);
    assert.deepEqual(relatedTags(posts, "レポート").map((t) => t.tag), ["カテゴリ"]);
    assert.deepEqual(postsForTag(posts, "レポート").map((p) => p.id), [q.id, posts[1].id, a.id], "untagged answers follow their question");
  });

  it("builds hand-off text from summaries and open questions", async () => {
    assert.match(buildHookContext([]), /empty so far/);
    const s = await log.session(SID);
    await log.append(s, { author: "claude", kind: "question", text: "ライセンスは MIT？", tags: ["全体"] });
    await log.append(s, { author: "claude", kind: "summary", text: "雛形を作成", next: ["CI を追加"] });
    const { posts, sessions } = await log.readAll();

    const hookText = buildHookContext(posts, "Asia/Tokyo");
    assert.match(hookText, /Open questions for the human \(1\):\n {2}- \[.+\] ライセンスは MIT？ #全体/);
    assert.match(hookText, /Last summary \(2026-09-26 13:30\): 雛形を作成\n {2}Next steps: CI を追加/);

    const ctx = buildContext(posts, sessions, { recent: 10, timeZone: "Asia/Tokyo" });
    assert.match(ctx, /## Open questions \(1\)/);
    assert.match(ctx, /Claude\/まとめ: 雛形を作成\n {2}next: CI を追加/);
    assert.match(ctx, /#全体\(1\)/);
  });
});

describe("hooks", () => {
  it("records prompts and folds tool use into one activity post per turn", async () => {
    await hook("UserPromptSubmit", { prompt: `レシート読み取りを作って${"。".repeat(1200)}` });
    await hook("PostToolUse", { tool_name: "Write", tool_input: { file_path: path.join(root, "lib/ocr.ts") } });
    await hook("PostToolUse", { tool_name: "Edit", tool_input: { file_path: path.join(root, "app/page.tsx") } });
    await hook("PostToolUse", { tool_name: "Edit", tool_input: { file_path: path.join(root, "lib/ocr.ts") } });
    await hook("PostToolUse", { tool_name: "Edit", tool_input: { file_path: path.join(root, ".worklog/x") } });
    await hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls -la" } });
    await hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm install tesseract.js" } });
    await hook("PostToolUseFailure", { tool_name: "Bash", tool_input: { command: "npm test" } });
    await hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" } });
    const stop = await hook("Stop", { permission_mode: "default" });
    assert.equal(stop.stdout, undefined);

    const { posts } = await log.readAll();
    assert.equal(posts.length, 2);
    assert.equal(posts[0].kind, "prompt");
    assert.equal(posts[0].text.length, 1000);
    assert.deepEqual(
      { kind: posts[1].kind, text: posts[1].text, files: posts[1].files, commands: posts[1].commands, tests: posts[1].tests },
      {
        kind: "activity",
        text: "2ファイル変更 ・ テスト成功（1件） ・ コマンド1件",
        files: ["lib/ocr.ts", "app/page.tsx"],
        commands: ["npm install tesseract.js"],
        tests: [{ command: "npm test", ok: true }],
      },
    );
    await fs.access(path.join(root, ".worklog/view/index.html"));
  });

  it("stops an unattended turn that changed things without a Claude post, once", async () => {
    await hook("UserPromptSubmit", { prompt: "直して" });
    await hook("PostToolUse", { tool_name: "Edit", tool_input: { file_path: path.join(root, "a.ts") } });
    const blocked = await hook("Stop", { permission_mode: "auto" });
    assert.equal(JSON.parse(blocked.stdout ?? "{}").decision, "block");

    const again = await hook("Stop", { permission_mode: "auto", stop_hook_active: true });
    assert.equal(again.stdout, undefined, "never loops");

    await hook("UserPromptSubmit", { prompt: "次" });
    await hook("PostToolUse", { tool_name: "Edit", tool_input: { file_path: path.join(root, "b.ts") } });
    await log.append(await log.session(SID), { author: "claude", kind: "result", text: "直した" });
    assert.equal((await hook("Stop", { permission_mode: "bypassPermissions" })).stdout, undefined, "posted → free to stop");

    await hook("UserPromptSubmit", { prompt: "質問だけ" });
    assert.equal((await hook("Stop", { permission_mode: "auto" })).stdout, undefined, "no work → no nagging");
  });

  it("records Claude's final reply, but not on a blocked stop", async () => {
    await hook("UserPromptSubmit", { prompt: "直して\n2行目" });
    await hook("PostToolUse", { tool_name: "Edit", tool_input: { file_path: path.join(root, "a.ts") } });
    await hook("Stop", { permission_mode: "auto", last_assistant_message: "直しました" });
    await log.append(await log.session(SID), { author: "claude", kind: "result", text: "直した" });
    await hook("Stop", { permission_mode: "auto", stop_hook_active: true, last_assistant_message: "直しました（記録済み）" });

    const { posts } = await log.readAll();
    assert.equal(posts[0].text, "直して\n2行目", "prompt keeps its line breaks");
    assert.deepEqual(posts.filter((p) => p.kind === "reply").map((p) => p.text), ["直しました（記録済み）"]);
  });

  it("does not count the reply itself as Claude having logged the turn", async () => {
    await hook("UserPromptSubmit", { prompt: "a" });
    await hook("PostToolUse", { tool_name: "Edit", tool_input: { file_path: path.join(root, "a.ts") } });
    await hook("Stop", { permission_mode: "default", last_assistant_message: "done" });
    await hook("PostToolUse", { tool_name: "Edit", tool_input: { file_path: path.join(root, "b.ts") } });
    const blocked = await hook("Stop", { permission_mode: "auto", last_assistant_message: "done again" });
    assert.equal(JSON.parse(blocked.stdout ?? "{}").decision, "block");
  });

  it("injects the hand-off at session start", async () => {
    const s = await log.session(SID);
    await log.append(s, { author: "claude", kind: "summary", text: "前回のまとめ", next: ["続き"] });
    const out = await hook("SessionStart", { hook_event_name: "SessionStart" });
    assert.match(out.stdout ?? "", /前回のまとめ[\s\S]*続き/);
  });
});

describe("viewer", () => {
  it("embeds the log safely and writes a page plus an artifact body", async () => {
    const s = await log.session(SID);
    await log.append(s, { author: "claude", kind: "note", text: "</script><b>x</b>", tags: ["UI"] });
    const html = await renderViewer(log);
    assert.ok(!html.includes("</script><b>"), "data cannot break out of its script tag");
    assert.match(html, /"project":"worklog-test-/);
    assert.ok(!/<!doctype/i.test(html));

    const files = await writeViewer(log);
    assert.match(await fs.readFile(files.page, "utf8"), /^<!doctype html>/);
    const artifact = await fs.readFile(files.artifact, "utf8");
    assert.match(artifact, /^<title>Worklog<\/title>/);
    assert.match(artifact, /"text":"\\u003c\/script>/);
  });
});
