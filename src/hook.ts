#!/usr/bin/env node
// Entry point for every worklog hook. The event comes from the hook input (or argv[2]).
import { openWorklog, timeZone } from "./config.ts";
import { type HookInput, handleHook } from "./hooks.ts";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  let input: HookInput = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    // No or malformed hook input; run with what the environment gives us.
  }
  const event = input.hook_event_name ?? process.argv[2] ?? "";
  const root = process.env.WORKLOG_ROOT || process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const result = await handleHook(event, input, openWorklog(root), timeZone);
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
} catch (e) {
  // Never break the user's session because of the log.
  process.stderr.write(`[worklog] hook failed: ${e instanceof Error ? e.message : String(e)}\n`);
}
