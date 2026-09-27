#!/usr/bin/env node
// Entry point for every worklog hook. The event comes from the hook input (or argv[2]).
// `hook.js summarize <session>` is the background summarizer the Stop hook starts.
import { spawn } from "node:child_process";
import { openWorklog, summariesEnabled, timeZone } from "./config.ts";
import { type HookInput, handleHook } from "./hooks.ts";
import { claudeRunner, summarizeSession } from "./summarize.ts";
import { writeViewer } from "./viewer.ts";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Detach so the user's session never waits on the model call. */
function startSummarizer(root: string, session: string): void {
  const child = spawn(process.execPath, [process.argv[1], "summarize", session], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WORKLOG_ROOT: root },
  });
  child.unref();
}

async function main(): Promise<void> {
  // Set for the summarizer's own `claude -p` run, so it is not logged.
  if (process.env.WORKLOG_DISABLED) return;

  if (process.argv[2] === "summarize") {
    const log = openWorklog(process.env.WORKLOG_ROOT || process.cwd());
    if (await summarizeSession(log, process.argv[3], claudeRunner)) await writeViewer(log);
    return;
  }

  let input: HookInput = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    // No or malformed hook input; run with what the environment gives us.
  }
  const event = input.hook_event_name ?? process.argv[2] ?? "";
  const root = process.env.WORKLOG_ROOT || process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const result = await handleHook(event, input, openWorklog(root), timeZone);
  if (result.summarize && summariesEnabled) startSummarizer(root, result.summarize);
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
}

try {
  await main();
} catch (e) {
  // Never break the user's session because of the log.
  process.stderr.write(`[worklog] hook failed: ${e instanceof Error ? e.message : String(e)}\n`);
}
