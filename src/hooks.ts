import path from "node:path";
import { buildHookContext, truncate } from "./query.ts";
import type { PendingItem, Worklog } from "./store.ts";
import { needsSummary } from "./summarize.ts";
import { writeViewer } from "./viewer.ts";

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  permission_mode?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

export interface HookResult {
  stdout?: string;
  /** Session whose long prompts/replies should be summarized in the background. */
  summarize?: string;
}

const PROMPT_MAX = 1000;
const REPLY_MAX = 4000;
const COMMAND_MAX = 120;
const COMMANDS_PER_POST = 5;
/** Permission modes in which nobody is watching each step, so the end-of-turn check applies. */
const UNATTENDED_MODES = new Set(["auto", "bypassPermissions", "dontAsk"]);

/** Opening the log (`/worklog:view`, or `/view` when unambiguous) is not work, so that turn is left out of the log. */
const VIEW_COMMAND = /^\/(?:worklog:)?view(?:\s|$)/;

const READ_ONLY_COMMAND = /^(ls|ll|cat|head|tail|less|more|grep|rg|find|fd|tree|pwd|echo|printf|wc|which|type|file|stat|du|df|env|date|whoami|sed -n|awk|jq|git (status|log|diff|show|branch|remote|rev-parse|ls-files|blame))\b/;
/** A test run is a test runner invoked at the start of some step of the command, not just the word "test" anywhere. */
const TEST_RUNNER = /^(?:(?:npx|bunx|pnpm exec|pnpm dlx|yarn dlx)\s+)?(?:jest|vitest|mocha|ava|pytest|rspec|phpunit|playwright test)\b|^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|^(?:node|deno|go|cargo|bun|dotnet|mix|swift)\s+(?:--)?test\b|^(?:python3?\s+-m\s+(?:pytest|unittest))\b|^make\s+test\b/;

export function isTestCommand(command: string): boolean {
  return command.split(/&&|\|\||;|\|/).some((step) => TEST_RUNNER.test(step.trim().replace(/^(?:cd\s+\S+|[A-Z_][A-Z0-9_]*=\S+)\s+/, "")));
}

export async function handleHook(event: string, input: HookInput, log: Worklog, timeZone?: string): Promise<HookResult> {
  const sid = input.session_id;
  switch (event) {
    case "SessionStart": {
      const { posts } = await log.readAll();
      return { stdout: buildHookContext(posts, timeZone) };
    }
    case "UserPromptSubmit": {
      if (!sid || !input.prompt?.trim()) return {};
      const session = await log.session(sid);
      await flushActivity(log, sid, session);
      if (VIEW_COMMAND.test(input.prompt.trim())) {
        await log.markQuiet(sid);
        return {};
      }
      // A view turn that was interrupted never reached Stop; don't let its mark hide this turn.
      await log.takeQuiet(sid);
      await log.append(session, { author: "human", kind: "prompt", text: clip(input.prompt, PROMPT_MAX) });
      return {};
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      if (!sid) return {};
      const item = describeToolUse(input, log.root, event === "PostToolUseFailure");
      if (item) await log.addPending(sid, item);
      return {};
    }
    case "Stop": {
      if (!sid) return {};
      const session = await log.session(sid);
      if (await log.takeQuiet(sid)) {
        // Whatever it took to open the log is not work either.
        await log.takePending(sid);
        await writeViewer(log).catch(() => undefined);
        return {};
      }
      await flushActivity(log, sid, session);
      if (await shouldBlockStop(log, session, input)) {
        // Claude keeps going and stops again, so its reply is recorded on that later Stop.
        return {
          stdout: JSON.stringify({
            decision: "block",
            reason:
              "[worklog] You changed things this turn but recorded nothing in the work log. Before finishing, use worklog_post to record what you did and why (decision / result / issue), anything the human should check (question), and, if this ends the task, a summary with next steps. Tag each post by topic.",
          }),
        };
      }
      if (input.last_assistant_message?.trim()) {
        await log.append(session, { author: "claude", kind: "reply", text: clip(input.last_assistant_message, REPLY_MAX) });
      }
      await writeViewer(log).catch(() => undefined);
      const { posts } = await log.readSession(session);
      return posts.some(needsSummary) ? { summarize: session } : {};
    }
    default:
      return {};
  }
}

function describeToolUse(input: HookInput, root: string, failed: boolean): PendingItem | undefined {
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const file = (ti.file_path ?? ti.notebook_path) as string | undefined;
    if (!file || failed) return undefined;
    const rel = path.isAbsolute(file) ? path.relative(root, file) : file;
    // Don't log the log.
    if (rel.startsWith(".worklog")) return undefined;
    return { file: rel.startsWith("..") ? file : rel };
  }
  if (tool === "Bash" && typeof ti.command === "string") {
    const command = truncate(ti.command, COMMAND_MAX);
    if (isTestCommand(ti.command)) return { test: { command, ok: !failed } };
    if (READ_ONLY_COMMAND.test(ti.command.trim())) return undefined;
    return { command: failed ? `${command} (失敗)` : command };
  }
  return undefined;
}

/** Turn this Claude session's pending tool uses into one `activity` post. */
export async function flushActivity(log: Worklog, sid: string, session: string): Promise<void> {
  const items = await log.takePending(sid);
  if (items.length === 0) return;
  const files = unique(items.flatMap((i) => (i.file ? [i.file] : [])));
  const commands = unique(items.flatMap((i) => (i.command ? [i.command] : [])));
  const testsByCommand = new Map(items.flatMap((i) => (i.test ? [[i.test.command, i.test] as const] : [])));
  const tests = [...testsByCommand.values()];

  const parts: string[] = [];
  if (files.length) parts.push(`${files.length}ファイル変更`);
  if (tests.length) {
    const failed = tests.filter((t) => !t.ok).length;
    parts.push(failed ? `テスト失敗あり（${failed}/${tests.length}）` : `テスト成功（${tests.length}件）`);
  }
  if (commands.length) parts.push(`コマンド${commands.length}件`);

  await log.append(session, {
    author: "auto",
    kind: "activity",
    text: parts.join(" ・ "),
    files,
    commands: commands.slice(-COMMANDS_PER_POST),
    tests: tests.length ? tests : undefined,
  });
}

async function postsSinceLastPrompt(log: Worklog, session: string) {
  const { posts } = await log.readSession(session);
  const start = posts.findLastIndex((p) => p.kind === "prompt");
  return posts.slice(start + 1);
}

async function shouldBlockStop(log: Worklog, session: string, input: HookInput): Promise<boolean> {
  if (!UNATTENDED_MODES.has(input.permission_mode ?? "") || input.stop_hook_active) return false;
  const turn = await postsSinceLastPrompt(log, session);
  const worked = turn.some((p) => p.kind === "activity");
  const commented = turn.some((p) => p.author === "claude" && p.kind !== "reply");
  return worked && !commented;
}

/** Keep line breaks (the viewer shows them) but cap the length. */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
