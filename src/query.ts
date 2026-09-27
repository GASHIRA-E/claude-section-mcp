import { localStamp, type Post, type SessionMeta } from "./store.ts";

export const KIND_LABELS: Record<Post["kind"], string> = {
  prompt: "指示",
  idea: "思いつき",
  decision: "決定",
  question: "要確認",
  answer: "回答",
  issue: "問題",
  result: "成果",
  note: "メモ",
  summary: "まとめ",
  activity: "変更",
};

export const AUTHOR_LABELS: Record<Post["author"], string> = { human: "あなた", claude: "Claude", auto: "自動記録" };

export function openQuestions(posts: Post[]): Post[] {
  const answered = new Set(posts.filter((p) => p.kind === "answer" && p.re).map((p) => p.re));
  return posts.filter((p) => p.kind === "question" && !answered.has(p.id));
}

export interface TagStat {
  tag: string;
  count: number;
  last: string;
}

export function tagStats(posts: Post[]): TagStat[] {
  const stats = new Map<string, TagStat>();
  for (const p of posts) {
    for (const tag of p.tags) {
      const s = stats.get(tag) ?? { tag, count: 0, last: "" };
      s.count++;
      if (p.ts > s.last) s.last = p.ts;
      stats.set(tag, s);
    }
  }
  return [...stats.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
}

/** Tags that appear on the same posts as `tag`, most frequent first. */
export function relatedTags(posts: Post[], tag: string): TagStat[] {
  return tagStats(posts.filter((p) => p.tags.includes(tag)).map((p) => ({ ...p, tags: p.tags.filter((t) => t !== tag) })));
}

export function postsForTag(posts: Post[], tag: string): Post[] {
  const direct = new Set(posts.filter((p) => p.tags.includes(tag)).map((p) => p.id));
  // Answers usually carry no tags; show them next to the question they resolve.
  return posts.filter((p) => direct.has(p.id) || (p.re !== undefined && direct.has(p.re) && p.kind === "answer"));
}

export function lastSummary(posts: Post[]): Post | undefined {
  return posts.findLast((p) => p.kind === "summary");
}

export function search(posts: Post[], query: string): Post[] {
  const q = query.toLowerCase();
  return posts.filter((p) =>
    [p.text, p.reason, ...p.tags, ...(p.files ?? []), ...(p.next ?? []), ...(p.commands ?? [])].some((s) => s?.toLowerCase().includes(q)),
  );
}

// ------------------------------------------------------------ text output

export function formatTime(iso: string, timeZone?: string): string {
  const { date, time } = localStamp(new Date(iso), timeZone);
  return `${date} ${time}`;
}

/** One post as compact Markdown for Claude to read. */
export function renderPost(p: Post, timeZone?: string): string {
  const head = `- [${p.id}] ${formatTime(p.ts, timeZone)} ${AUTHOR_LABELS[p.author]}/${KIND_LABELS[p.kind]}${p.re ? ` (re ${p.re})` : ""}: ${oneLine(p.text)}`;
  const extra: string[] = [];
  if (p.tags.length) extra.push(`tags: ${p.tags.map((t) => `#${t}`).join(" ")}`);
  if (p.reason) extra.push(`reason: ${oneLine(p.reason)}`);
  if (p.files?.length) extra.push(`files: ${p.files.join(", ")}`);
  if (p.commands?.length) extra.push(`commands: ${p.commands.join(" ; ")}`);
  if (p.tests?.length) extra.push(`tests: ${p.tests.map((t) => `${t.ok ? "✓" : "✗"} ${t.command}`).join(" ; ")}`);
  if (p.next?.length) extra.push(`next: ${p.next.join(" / ")}`);
  return [head, ...extra.map((e) => `  ${e}`)].join("\n");
}

export interface ContextOptions {
  recent: number;
  currentSession?: string;
  timeZone?: string;
}

/** Full hand-off returned by `worklog_context`. */
export function buildContext(posts: Post[], sessions: SessionMeta[], options: ContextOptions): string {
  if (posts.length === 0) return "The work log is empty. Record decisions, questions and results with worklog_post as you work.";
  const out: string[] = [];
  const open = openQuestions(posts);
  out.push(`## Open questions (${open.length})`, open.length ? open.map((p) => renderPost(p, options.timeZone)).join("\n") : "(none)", "");

  const summary = lastSummary(posts);
  out.push("## Last summary", summary ? renderPost(summary, options.timeZone) : "(none yet)", "");

  const tags = tagStats(posts);
  out.push(`## Tags (${tags.length})`, tags.length ? tags.map((t) => `#${t.tag}(${t.count})`).join(" ") : "(none yet)", "");

  const recent = posts.filter((p) => p.author !== "auto").slice(-options.recent);
  out.push(`## Recent posts (${recent.length})`, recent.map((p) => renderPost(p, options.timeZone)).join("\n"), "");

  out.push(`Sessions: ${sessions.length}. Current session: ${options.currentSession ?? "(none)"}.`);
  out.push("Use worklog_tag to look up the history of a topic.");
  return out.join("\n");
}

/** Short note injected by the SessionStart hook. */
export function buildHookContext(posts: Post[], timeZone?: string): string {
  const lines = ["[worklog] This project keeps a work log in .worklog/ (worklog plugin)."];
  if (posts.length === 0) {
    lines.push("It is empty so far. Record decisions (with reasons), questions for the human, and results with worklog_post, tagged by topic.");
    return lines.join("\n");
  }
  const open = openQuestions(posts);
  if (open.length) {
    lines.push(`Open questions for the human (${open.length}):`);
    for (const p of open.slice(-5)) lines.push(`  - [${p.id}] ${oneLine(p.text)}${p.tags.length ? ` ${p.tags.map((t) => `#${t}`).join(" ")}` : ""}`);
  }
  const summary = lastSummary(posts);
  if (summary) {
    lines.push(`Last summary (${formatTime(summary.ts, timeZone)}): ${oneLine(summary.text)}`);
    if (summary.next?.length) lines.push(`  Next steps: ${summary.next.join(" / ")}`);
  }
  const tags = tagStats(posts).slice(0, 15);
  if (tags.length) lines.push(`Tags in use: ${tags.map((t) => `#${t.tag}`).join(" ")}`);
  lines.push("Call worklog_context for more, worklog_tag to look up a topic's history, and keep posting decisions/questions/results with worklog_post.");
  return lines.join("\n");
}

export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

export function truncate(text: string, max: number): string {
  const flat = oneLine(text);
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
