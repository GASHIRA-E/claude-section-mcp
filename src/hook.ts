#!/usr/bin/env node
// SessionStart hook: prints a short hand-off note from .worklog/ so Claude starts with the project's history.
import { buildHookContext } from "./context.ts";
import { resolveLang } from "./labels.ts";
import { WorklogStore } from "./store.ts";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

try {
  let cwd: string | undefined;
  try {
    cwd = JSON.parse(await readStdin()).cwd;
  } catch {
    // No or malformed hook input; fall back to the environment.
  }
  const root = process.env.WORKLOG_ROOT || process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd();
  const store = new WorklogStore(root, { lang: resolveLang(process.env.WORKLOG_LANG) });
  process.stdout.write(`${await buildHookContext(store)}\n`);
} catch (e) {
  // Never block a session from starting because of the log.
  process.stderr.write(`[worklog] hook failed: ${e instanceof Error ? e.message : String(e)}\n`);
}
