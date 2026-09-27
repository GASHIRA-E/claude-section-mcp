import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Post, Worklog } from "./store.ts";

/** Anything shorter reads fine as is. */
const MIN_LENGTH: Partial<Record<Post["kind"], number>> = { prompt: 80, reply: 140 };
const MAX_ITEMS = 10;
const MAX_INPUT = 2000;
const MAX_SUMMARY = 120;
const LOCK_STALE_MS = 5 * 60_000;
const TIMEOUT_MS = 120_000;

export type Runner = (prompt: string) => Promise<string>;

export function needsSummary(p: Post): boolean {
  const min = MIN_LENGTH[p.kind];
  return min !== undefined && !p.summary && p.text.length > min;
}

export function summarizePrompt(items: { id: string; kind: string; text: string }[]): string {
  return [
    "You summarize entries from a log of a developer working with an AI coding assistant, for a human skimming the log later.",
    'Each item is either a "prompt" (what the developer asked) or a "reply" (what the assistant answered or reported).',
    "For each item write one sentence in the same language as the item: at most 60 characters for Japanese, 100 for other languages.",
    "Say what was asked, or what was done / answered. Keep concrete names; drop pleasantries.",
    "Output only a JSON object mapping each id to its summary, with no other text.",
    "",
    JSON.stringify(items),
  ].join("\n");
}

export function parseSummaries(output: string): Record<string, string> {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end <= start) return {};
  try {
    const parsed = JSON.parse(output.slice(start, end + 1));
    const out: Record<string, string> = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || !value.trim()) continue;
      const line = value.replace(/\s+/g, " ").trim();
      out[id] = line.length > MAX_SUMMARY ? `${line.slice(0, MAX_SUMMARY - 1)}…` : line;
    }
    return out;
  } catch {
    return {};
  }
}

/** Summarize this session's long prompts and replies that have no summary yet. Returns how many were added. */
export async function summarizeSession(log: Worklog, session: string, run: Runner): Promise<number> {
  const release = await acquireLock(log, session);
  if (!release) return 0;
  try {
    const pending = (await log.readSession(session)).posts.filter(needsSummary).slice(-MAX_ITEMS);
    if (pending.length === 0) return 0;
    const items = pending.map((p) => ({ id: p.id, kind: p.kind, text: p.text.slice(0, MAX_INPUT) }));
    const summaries = parseSummaries(await run(summarizePrompt(items)));
    let added = 0;
    for (const p of pending) {
      if (!summaries[p.id]) continue;
      await log.patch(session, { patch: p.id, summary: summaries[p.id] });
      added++;
    }
    return added;
  } finally {
    await release();
  }
}

/** One summarizer per session at a time; a crashed one stops blocking after a few minutes. */
async function acquireLock(log: Worklog, session: string): Promise<(() => Promise<void>) | undefined> {
  await fs.mkdir(log.stateDir, { recursive: true });
  const file = path.join(log.stateDir, `summarize-${session}.lock`);
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) return undefined;
    await fs.rm(file, { force: true });
  } catch {
    // No lock yet.
  }
  try {
    await (await fs.open(file, "wx")).close();
  } catch {
    return undefined;
  }
  return () => fs.rm(file, { force: true });
}

/**
 * Ask a small model through the Claude Code CLI, reusing the user's own login.
 * WORKLOG_DISABLED keeps this plugin's hooks from logging the summarizer's own session,
 * and running outside the project keeps project settings and CLAUDE.md out of it.
 */
export const claudeRunner: Runner = (prompt) =>
  new Promise((resolve, reject) => {
    const bin = process.env.CLAUDE_CODE_EXECPATH || "claude";
    const model = process.env.WORKLOG_SUMMARY_MODEL || "haiku";
    const args = ["-p", "--model", model, "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-session-persistence", "--output-format", "text"];
    const child = spawn(bin, args, { cwd: os.tmpdir(), env: { ...process.env, WORKLOG_DISABLED: "1" }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`claude exited with ${code}`));
    });
    child.stdin.end(prompt);
  });
