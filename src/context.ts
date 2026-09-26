import path from "node:path";
import { type SessionInfo, type WorklogStore } from "./store.ts";

export interface ContextOptions {
  sessions: number;
  currentSession?: string;
}

/** Full hand-off context returned by the `worklog_get_context` tool. */
export async function buildContext(store: WorklogStore, options: ContextOptions): Promise<string> {
  if (!(await store.exists())) {
    return [
      "No worklog exists for this project yet.",
      `It will be created under ${path.relative(store.root, store.dir) || store.dir}/ when you call worklog_start_session.`,
    ].join("\n");
  }

  const out: string[] = [];
  const project = await store.readProject();
  out.push("# Project notes (.worklog/PROJECT.md)", "", project?.trim() ?? "(missing)", "");

  const files = await store.listSessionFiles();
  const recent = await Promise.all(files.slice(0, options.sessions).map((f) => store.readSession(f)));
  out.push(`# Recent sessions (newest first, ${recent.length} of ${files.length})`, "");
  if (recent.length === 0) out.push("(none yet)", "");
  for (const s of recent) out.push(...renderSession(s), "");

  out.push("# Current session", "", options.currentSession ? `.worklog/sessions/${options.currentSession}` : "None. Call worklog_start_session before logging work.");
  return out.join("\n").trimEnd();
}

/** Short reminder printed by the SessionStart hook so a new session picks up where the last one stopped. */
export async function buildHookContext(store: WorklogStore): Promise<string> {
  const lines = ["[worklog] This project keeps a human-readable work log in .worklog/ (worklog MCP server)."];
  if (!(await store.exists())) {
    lines.push("No log exists yet. Call worklog_start_session when you begin substantive work, record progress with worklog_log, and finish with worklog_end_session.");
    return lines.join("\n");
  }

  const [latest] = await store.listSessionFiles();
  if (latest) {
    const s = await store.readSession(latest);
    lines.push(`Last session: "${s.title}" (${s.started}, ${s.status ?? "unknown"}) → .worklog/sessions/${s.file}`);
    if (s.status === "in_progress") lines.push("It was never wrapped up; starting a new session will close it as partially done.");
    if (s.nextSteps) lines.push("Its next steps:", indent(s.nextSteps));
    if (s.needsReview) lines.push("Waiting on human review:", indent(s.needsReview));
  }
  lines.push("Call worklog_get_context for the project notes and recent history before starting work.");
  return lines.join("\n");
}

function renderSession(s: SessionInfo): string[] {
  const out = [`## ${s.title}`, `- file: .worklog/sessions/${s.file}`, `- started: ${s.started}${s.ended ? ` / ended: ${s.ended}` : ""}`, `- status: ${s.status ?? "unknown"}`];
  if (s.branch) out.push(`- branch: ${s.branch}`);
  if (s.goal) out.push("", "Goal:", s.goal);
  if (s.summary) out.push("", "Summary:", s.summary);
  else if (s.status === "in_progress") out.push("", "(still in progress — read the file for its log entries)");
  if (s.needsReview) out.push("", "Needs human review:", s.needsReview);
  if (s.nextSteps) out.push("", "Next steps:", s.nextSteps);
  return out;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}
