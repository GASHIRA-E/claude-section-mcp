#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildContext } from "./context.ts";
import { END_STATUSES, ENTRY_KINDS, PROJECT_SECTION_KEYS, resolveLang } from "./labels.ts";
import { WorklogStore } from "./store.ts";

const VERSION = "0.1.0";
/** How recently an unfinished session must have been written to for a restarted server to resume it. */
const RESUME_WINDOW_MS = Number(process.env.WORKLOG_RESUME_MINUTES ?? 120) * 60_000;

const INSTRUCTIONS = `Keeps a human-readable log of Claude's work in .worklog/ inside the project, so people can follow what happened (even in long autonomous runs) and later sessions can pick up the project's history.
- At the start of a task: call worklog_get_context, then worklog_start_session.
- While working: call worklog_log at meaningful milestones — decisions (with the reason), problems, results, and anything a human should check (kind "question"). Write for a teammate who was not watching.
- At the end: call worklog_end_session with a summary and next steps, and keep PROJECT.md current with worklog_update_project.`;

const server = new McpServer({ name: "worklog", version: VERSION }, { instructions: INSTRUCTIONS });

let store: WorklogStore | undefined;
let currentSession: string | undefined;

/** Resolve the project root: explicit env var, then the client's MCP roots, then the working directory. */
async function getStore(): Promise<WorklogStore> {
  if (store) return store;
  let root = process.env.WORKLOG_ROOT;
  if (!root && server.server.getClientCapabilities()?.roots) {
    try {
      const { roots } = await server.server.listRoots(undefined, { timeout: 5_000 });
      const first = roots.find((r) => r.uri.startsWith("file://"));
      if (first) root = fileURLToPath(first.uri);
    } catch {
      // Fall through to the environment-based defaults.
    }
  }
  root ??= process.env.CLAUDE_PROJECT_DIR || process.cwd();
  store = new WorklogStore(root, { lang: resolveLang(process.env.WORKLOG_LANG), timeZone: process.env.WORKLOG_TZ || undefined });
  return store;
}

/** The session entries go to; resumes a recent unfinished one after a server restart. */
async function activeSession(s: WorklogStore): Promise<string | undefined> {
  currentSession ??= await s.findResumableSession(RESUME_WINDOW_MS);
  return currentSession;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function error(t: string) {
  return { content: [{ type: "text" as const, text: t }], isError: true };
}

server.registerTool(
  "worklog_get_context",
  {
    title: "Get project work history",
    description:
      "Read the project notes (.worklog/PROJECT.md) and the summaries, open questions and next steps of recent sessions. Call this before starting work so you know what previous sessions did and what is still pending.",
    inputSchema: {
      sessions: z.number().int().min(0).max(20).default(3).describe("How many recent sessions to include."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ sessions }) => {
    const s = await getStore();
    return text(await buildContext(s, { sessions, currentSession: await activeSession(s) }));
  },
);

server.registerTool(
  "worklog_start_session",
  {
    title: "Start a work session",
    description:
      "Open a new session log for the task you are about to do. Creates .worklog/ on first use. If another session from this conversation is still open it is closed as partially done.",
    inputSchema: {
      title: z.string().min(1).describe("Short title of the task, e.g. 'ログイン画面のバリデーション追加'. Write in the user's language."),
      goal: z.string().optional().describe("What this session is meant to achieve and why — the request as a human would describe it."),
      branch: z.string().optional().describe("Git branch being worked on. Detected automatically when omitted."),
    },
  },
  async ({ title, goal, branch }) => {
    const s = await getStore();
    const previous = await activeSession(s);
    if (previous) await s.autoClose(previous);
    const info = await s.startSession({ title, goal, branch });
    currentSession = info.file;
    return text(
      [`Started session: .worklog/sessions/${info.file}`, previous ? `Closed the unfinished session ${previous} as partially done.` : ""]
        .filter(Boolean)
        .join("\n"),
    );
  },
);

server.registerTool(
  "worklog_log",
  {
    title: "Log a work entry",
    description: [
      "Append an entry to the current session log. Log milestones, not every command: what you did and why, so a human skimming the log later understands the flow.",
      "Kinds: task = work done; decision = a choice you made (put the why in `reason`); issue = a problem or failure hit;",
      "result = something finished/verified (tests passing, feature done); question = something a human should check or decide (collected into the session's review list);",
      "note = anything else worth remembering. Starts a session automatically if none is open.",
    ].join(" "),
    inputSchema: {
      kind: z.enum(ENTRY_KINDS).describe("Entry type."),
      summary: z.string().min(1).describe("One-line headline, in the user's language."),
      details: z.string().optional().describe("Markdown body: what was done, how, and anything notable. Keep it readable for a human."),
      reason: z.string().optional().describe("Why — especially for decisions: alternatives considered and why this one."),
      files: z.array(z.string()).optional().describe("Relevant file paths, relative to the project root."),
    },
  },
  async (entry) => {
    const s = await getStore();
    let file = await activeSession(s);
    let note = "";
    if (!file) {
      const info = await s.startSession({ title: entry.summary });
      file = currentSession = info.file;
      note = ` (no session was open, so started ${info.file})`;
    }
    await s.appendEntry(file, entry);
    return text(`Logged ${entry.kind} to .worklog/sessions/${file}${note}`);
  },
);

server.registerTool(
  "worklog_end_session",
  {
    title: "End the work session",
    description:
      "Close the current session with a human-readable summary, next steps and items needing review. Call when the task is done or you are stopping. Entries logged with kind 'question' are added to the review list automatically. Afterwards, update PROJECT.md (worklog_update_project) if the project's status, decisions or open tasks changed.",
    inputSchema: {
      summary: z.string().min(1).describe("Markdown summary of what was accomplished, what changed, and the current state. Write it for someone who did not follow the session."),
      status: z.enum(END_STATUSES).describe("completed = goal reached; partial = some work remains; blocked = cannot continue without help."),
      next_steps: z.array(z.string()).optional().describe("Concrete follow-ups for the next session or a human."),
      needs_review: z.array(z.string()).optional().describe("Extra points a human should check or decide, beyond logged questions."),
    },
  },
  async ({ summary, status, next_steps, needs_review }) => {
    const s = await getStore();
    const file = await activeSession(s);
    if (!file) return error("No open session to end. Start one with worklog_start_session.");
    const info = await s.endSession(file, { summary, status, nextSteps: next_steps, needsReview: needs_review });
    currentSession = undefined;
    return text(`Ended session .worklog/sessions/${info.file} (${status}). Consider updating PROJECT.md with worklog_update_project.`);
  },
);

server.registerTool(
  "worklog_update_project",
  {
    title: "Update project notes",
    description: `Edit a section of .worklog/PROJECT.md, the long-lived project summary shared across sessions. Standard sections: ${PROJECT_SECTION_KEYS.join(", ")} (overview = what the project is; status = where things stand now; decisions = design choices and why; todos = open tasks and known issues; notes = anything else). Any other name creates a custom section. Use 'replace' for status-like sections and 'append' for logs such as decisions.`,
    inputSchema: {
      section: z.string().min(1).describe(`One of ${PROJECT_SECTION_KEYS.join(", ")}, or a custom heading.`),
      content: z.string().min(1).describe("Markdown content for the section, in the user's language."),
      mode: z.enum(["replace", "append"]).default("replace"),
    },
  },
  async ({ section, content, mode }) => {
    const s = await getStore();
    const heading = await s.updateProject(section, content, mode);
    return text(`Updated "${heading}" in .worklog/PROJECT.md (${mode}).`);
  },
);

server.registerTool(
  "worklog_search",
  {
    title: "Search the work log",
    description: "Case-insensitive text search across PROJECT.md, TIMELINE.md and all session logs. Use it to find when and why something was done.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).default(30),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, limit }) => {
    const hits = await (await getStore()).search(query, limit);
    return text(hits.length ? hits.join("\n") : `No matches for "${query}".`);
  },
);

await server.connect(new StdioServerTransport());
