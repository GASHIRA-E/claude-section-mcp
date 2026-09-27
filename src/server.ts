#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openWorklog, timeZone } from "./config.ts";
import { flushActivity } from "./hooks.ts";
import { buildContext, openQuestions, postsForTag, relatedTags, renderPost, search, tagStats } from "./query.ts";
import { CLAUDE_KINDS, type Worklog } from "./store.ts";
import { writeViewer } from "./viewer.ts";

const VERSION = "0.2.0";

const INSTRUCTIONS = `Work log for this project, stored in .worklog/ and committed with the code. Humans read it later to see what Claude did and why; future Claude sessions read it to pick up the project's history.
- Your prompts, file changes and test runs are recorded automatically by hooks. You record the meaning: decisions with their reasons, problems, results, questions for the human, and summaries — via worklog_post.
- Tag every post by topic (feature, component, concern). Reuse existing tags; worklog_context lists them.
- When a question is answered, record it with worklog_answer.
- Before working on a topic, worklog_tag shows how it got to where it is.`;

const server = new McpServer({ name: "worklog", version: VERSION }, { instructions: INSTRUCTIONS });

let log: Worklog | undefined;

/** Project root: explicit env var, then the client's MCP roots, then the working directory. */
async function getLog(): Promise<Worklog> {
  if (log) return log;
  let root = process.env.WORKLOG_ROOT;
  if (!root && server.server.getClientCapabilities()?.roots) {
    try {
      const { roots } = await server.server.listRoots(undefined, { timeout: 5_000 });
      const first = roots.find((r) => r.uri.startsWith("file://"));
      if (first) root = fileURLToPath(first.uri);
    } catch {
      // Fall back to the environment below.
    }
  }
  log = openWorklog(root ?? (process.env.CLAUDE_PROJECT_DIR || process.cwd()));
  return log;
}

/**
 * Hooks key sessions by Claude's session id; use it too when Claude Code passes it down.
 * File changes gathered by hooks so far are posted first, so the log stays in the order things happened.
 */
async function currentSession(l: Worklog): Promise<string> {
  const sid = process.env.CLAUDE_CODE_SESSION_ID || undefined;
  const session = await l.session(sid);
  if (sid) await flushActivity(l, sid, session);
  return session;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function error(t: string) {
  return { content: [{ type: "text" as const, text: t }], isError: true };
}

const tagsSchema = z.array(z.string()).describe("Topic tags without '#', e.g. ['ログイン', 'API']. Reuse existing tags (see worklog_context).");

server.registerTool(
  "worklog_context",
  {
    title: "Get work history",
    description:
      "Hand-off from previous sessions: open questions for the human, the last summary and its next steps, tags in use, and recent posts. Call it when starting a task.",
    inputSchema: { recent: z.number().int().min(0).max(100).default(20).describe("How many recent posts to include.") },
    annotations: { readOnlyHint: true },
  },
  async ({ recent }) => {
    const l = await getLog();
    const { posts, sessions } = await l.readAll();
    return text(buildContext(posts, sessions, { recent, currentSession: await l.latestSession(), timeZone }));
  },
);

server.registerTool(
  "worklog_post",
  {
    title: "Post to the work log",
    description: [
      "Record something meaningful about the work, for a human reading later and for future sessions. Post at milestones, not for every step.",
      "Kinds: decision = a choice and why (put alternatives and the why in `reason`); question = something the human should check or decide (listed as open until answered);",
      "result = something done or verified; issue = a problem or failure; idea = an idea or request worth keeping; note = anything else;",
      "summary = wrap-up of a task with `next_steps` (shown to the next session).",
      "Write in the user's language, for someone who did not watch the session.",
    ].join(" "),
    inputSchema: {
      kind: z.enum(CLAUDE_KINDS),
      text: z.string().min(1).describe("The post itself. Short paragraphs; Markdown is fine."),
      tags: tagsSchema,
      reason: z.string().optional().describe("Why — required in spirit for decisions."),
      files: z.array(z.string()).optional().describe("Relevant paths, relative to the project root."),
      reply_to: z.string().optional().describe("ID of the post this follows up on (e.g. the idea a decision implements)."),
      next_steps: z.array(z.string()).optional().describe("For summaries: concrete follow-ups."),
    },
  },
  async ({ kind, text: body, tags, reason, files, reply_to, next_steps }) => {
    const l = await getLog();
    if (reply_to && !(await l.readAll()).posts.some((p) => p.id === reply_to)) return error(`No post with id ${reply_to}.`);
    const post = await l.append(await currentSession(l), { author: "claude", kind, text: body, tags, reason, files, re: reply_to, next: next_steps });
    const note = post.tags.length === 0 && kind !== "summary" ? " (no tags — consider tagging so it can be looked up later)" : "";
    return text(`Posted ${post.id}${post.tags.length ? ` ${post.tags.map((t) => `#${t}`).join(" ")}` : ""}${note}`);
  },
);

server.registerTool(
  "worklog_answer",
  {
    title: "Record an answer",
    description: "Record the human's answer to an open question (by its id) so it stops showing as open. Follow up with a decision post if the answer settles something.",
    inputSchema: {
      question_id: z.string().min(1),
      answer: z.string().min(1).describe("The answer, as the human gave it (summarised if long)."),
    },
  },
  async ({ question_id, answer }) => {
    const l = await getLog();
    const question = (await l.readAll()).posts.find((p) => p.id === question_id);
    if (!question) return error(`No post with id ${question_id}.`);
    if (question.kind !== "question") return error(`${question_id} is a ${question.kind}, not a question.`);
    const post = await l.append(await currentSession(l), { author: "claude", kind: "answer", text: answer, re: question_id, tags: question.tags });
    return text(`Recorded answer ${post.id} to ${question_id}.`);
  },
);

server.registerTool(
  "worklog_tag",
  {
    title: "Look up a topic",
    description: "Reverse lookup by tag: every post about a topic in time order (ideas, decisions and their reasons, questions and answers, results), plus related tags. Use it to learn how something came to be before changing it.",
    inputSchema: {
      tag: z.string().min(1).describe("Tag with or without '#'."),
      include_auto: z.boolean().default(false).describe("Include automatic activity records."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ tag, include_auto }) => {
    const { posts } = await (await getLog()).readAll();
    const name = tag.replace(/^[#＃]/, "").trim();
    const known = tagStats(posts).find((t) => t.tag.normalize("NFKC").toLowerCase() === name.normalize("NFKC").toLowerCase());
    if (!known) return text(`No posts tagged #${name}. Tags in use: ${tagStats(posts).map((t) => `#${t.tag}`).join(" ") || "(none)"}`);
    const list = postsForTag(posts, known.tag).filter((p) => include_auto || p.author !== "auto");
    const related = relatedTags(posts, known.tag).slice(0, 10);
    const open = openQuestions(list);
    const head = [`# #${known.tag} — ${list.length} posts`];
    if (related.length) head.push(`Related: ${related.map((t) => `#${t.tag}(${t.count})`).join(" ")}`);
    if (open.length) head.push(`Open questions: ${open.map((p) => p.id).join(", ")}`);
    return text([...head, "", ...list.map((p) => renderPost(p, timeZone))].join("\n"));
  },
);

server.registerTool(
  "worklog_search",
  {
    title: "Search the work log",
    description: "Case-insensitive search over post text, reasons, tags, files and commands.",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(200).default(30) },
    annotations: { readOnlyHint: true },
  },
  async ({ query, limit }) => {
    const hits = search((await (await getLog()).readAll()).posts, query).slice(-limit);
    return text(hits.length ? hits.map((p) => renderPost(p, timeZone)).join("\n") : `No matches for "${query}".`);
  },
);

server.registerTool(
  "worklog_view",
  {
    title: "Build the log viewer",
    description:
      "Regenerate the HTML viewer (sessions as chats, tag lookup, open questions). Returns `page` to open in a browser and `artifact`, a body-only copy suited to publishing as a claude.ai Artifact when working in the cloud.",
    inputSchema: {},
  },
  async () => {
    const l = await getLog();
    const files = await writeViewer(l);
    return text(`page: ${files.page}\nartifact: ${files.artifact}`);
  },
);

await server.connect(new StdioServerTransport());
