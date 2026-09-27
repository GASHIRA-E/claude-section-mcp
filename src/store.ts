import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const WORKLOG_DIRNAME = ".worklog";

export type Author = "human" | "claude" | "auto";
/** Kinds Claude writes through `worklog_post`. */
export const CLAUDE_KINDS = ["decision", "question", "result", "issue", "idea", "note", "summary"] as const;
export type ClaudeKind = (typeof CLAUDE_KINDS)[number];
export type Kind = ClaudeKind | "prompt" | "answer" | "activity";

export interface TestRun {
  command: string;
  ok: boolean;
}

export interface Post {
  id: string;
  /** ISO 8601, UTC. */
  ts: string;
  /** Session file name without extension. */
  session: string;
  author: Author;
  kind: Kind;
  text: string;
  tags: string[];
  re?: string;
  reason?: string;
  files?: string[];
  next?: string[];
  commands?: string[];
  tests?: TestRun[];
}

export type NewPost = Omit<Post, "id" | "ts" | "session" | "tags"> & { tags?: string[] };

export interface SessionMeta {
  meta: true;
  session: string;
  claudeSession?: string;
  started: string;
  branch?: string;
}

export interface PendingItem {
  file?: string;
  command?: string;
  test?: TestRun;
}

export interface WorklogOptions {
  now?: () => Date;
  /** Commit `.worklog/` to git (default) or keep it local-only. */
  commit?: boolean;
  /** IANA zone for session file names. Defaults to the system zone. */
  timeZone?: string;
}

export class Worklog {
  readonly root: string;
  readonly dir: string;
  readonly sessionsDir: string;
  readonly stateDir: string;
  readonly viewDir: string;
  private readonly now: () => Date;
  private readonly commit: boolean;
  private readonly timeZone?: string;

  constructor(root: string, options: WorklogOptions = {}) {
    this.root = root;
    this.dir = path.join(root, WORKLOG_DIRNAME);
    this.sessionsDir = path.join(this.dir, "sessions");
    this.stateDir = path.join(this.dir, ".state");
    this.viewDir = path.join(this.dir, "view");
    this.now = options.now ?? (() => new Date());
    this.commit = options.commit ?? true;
    this.timeZone = options.timeZone;
  }

  async exists(): Promise<boolean> {
    return pathExists(this.sessionsDir);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    await fs.mkdir(this.stateDir, { recursive: true });
    const ignore = this.commit
      ? "# Rebuilt from the session logs; not worth committing.\n.state/\nview/\n"
      : "# WORKLOG_COMMIT=false: keep the whole work log local.\n*\n";
    await writeIfChanged(path.join(this.dir, ".gitignore"), ignore);
    await writeIfChanged(path.join(this.dir, ".gitattributes"), "# Collapse work-log diffs on GitHub.\n*.jsonl linguist-generated=true\n");
  }

  // ------------------------------------------------------------ sessions

  /**
   * The session file for a Claude session id, created on first use.
   * Without an id, the most recently written session (or a new one) is used.
   */
  async session(claudeSession?: string): Promise<string> {
    await this.init();
    const files = await this.sessionFiles();
    if (claudeSession) {
      const suffix = `_${shortId(claudeSession)}.jsonl`;
      const found = files.find((f) => f.endsWith(suffix));
      if (found) return found.slice(0, -".jsonl".length);
      return this.createSession(claudeSession);
    }
    const latest = await this.latestSession();
    return latest ?? this.createSession(undefined);
  }

  async latestSession(): Promise<string | undefined> {
    let best: { name: string; mtime: number } | undefined;
    for (const f of await this.sessionFiles()) {
      const { mtimeMs } = await fs.stat(path.join(this.sessionsDir, f));
      if (!best || mtimeMs > best.mtime) best = { name: f, mtime: mtimeMs };
    }
    return best?.name.slice(0, -".jsonl".length);
  }

  private async createSession(claudeSession: string | undefined): Promise<string> {
    const { date, time } = localStamp(this.now(), this.timeZone);
    const name = `${date}_${time.replace(":", "")}_${claudeSession ? shortId(claudeSession) : randomId(8)}`;
    const meta: SessionMeta = { meta: true, session: name, claudeSession, started: this.now().toISOString(), branch: await this.detectBranch() };
    await fs.appendFile(this.sessionPath(name), `${JSON.stringify(stripUndefined(meta))}\n`);
    return name;
  }

  async sessionFiles(): Promise<string[]> {
    if (!(await pathExists(this.sessionsDir))) return [];
    return (await fs.readdir(this.sessionsDir)).filter((f) => f.endsWith(".jsonl")).sort();
  }

  sessionPath(session: string): string {
    return path.join(this.sessionsDir, `${session}.jsonl`);
  }

  // --------------------------------------------------------------- posts

  async append(session: string, input: NewPost): Promise<Post> {
    const existing = await this.allTags();
    const date = this.now();
    const post: Post = stripUndefined({
      id: `${localStamp(date, this.timeZone).compact}-${randomId(3)}`,
      ts: date.toISOString(),
      session,
      ...input,
      tags: normalizeTags(input.tags ?? [], existing),
      files: input.files?.length ? input.files : undefined,
      next: input.next?.length ? input.next : undefined,
    });
    await fs.appendFile(this.sessionPath(session), `${JSON.stringify(post)}\n`);
    return post;
  }

  async readSession(session: string): Promise<{ meta?: SessionMeta; posts: Post[] }> {
    const text = await fs.readFile(this.sessionPath(session), "utf8").catch(() => "");
    let meta: SessionMeta | undefined;
    const posts: Post[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.meta) meta = record;
        else posts.push({ tags: [], ...record });
      } catch {
        // A torn or hand-edited line should not hide the rest of the log.
      }
    }
    return { meta, posts };
  }

  async readAll(): Promise<{ sessions: SessionMeta[]; posts: Post[] }> {
    const sessions: SessionMeta[] = [];
    const posts: Post[] = [];
    for (const f of await this.sessionFiles()) {
      const name = f.slice(0, -".jsonl".length);
      const s = await this.readSession(name);
      sessions.push(s.meta ?? { meta: true, session: name, started: s.posts[0]?.ts ?? "" });
      posts.push(...s.posts);
    }
    posts.sort((a, b) => a.ts.localeCompare(b.ts));
    return { sessions, posts };
  }

  async allTags(): Promise<string[]> {
    const tags = new Set<string>();
    for (const p of (await this.readAll()).posts) for (const t of p.tags) tags.add(t);
    return [...tags];
  }

  // ------------------------------------------- pending (hook scratch state)

  async addPending(claudeSession: string, item: PendingItem): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.appendFile(this.pendingPath(claudeSession), `${JSON.stringify(item)}\n`);
  }

  async takePending(claudeSession: string): Promise<PendingItem[]> {
    const file = this.pendingPath(claudeSession);
    const taken = `${file}.${process.pid}.taking`;
    try {
      await fs.rename(file, taken);
    } catch {
      return [];
    }
    const text = await fs.readFile(taken, "utf8");
    await fs.rm(taken, { force: true });
    return text
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as PendingItem];
        } catch {
          return [];
        }
      });
  }

  private pendingPath(claudeSession: string): string {
    return path.join(this.stateDir, `pending-${shortId(claudeSession)}.jsonl`);
  }

  private async detectBranch(): Promise<string | undefined> {
    try {
      const head = (await fs.readFile(path.join(this.root, ".git", "HEAD"), "utf8")).trim();
      return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : undefined;
    } catch {
      return undefined;
    }
  }
}

// ------------------------------------------------------------------ helpers

/** Strip `#`, trim, and reuse an existing spelling that differs only by case or width. */
export function normalizeTags(tags: string[], existing: string[]): string[] {
  const byKey = new Map(existing.map((t) => [tagKey(t), t]));
  const out: string[] = [];
  for (const raw of tags) {
    const cleaned = raw.trim().replace(/^[#＃]+/, "").trim().replace(/\s+/g, "_");
    if (!cleaned) continue;
    const tag = byKey.get(tagKey(cleaned)) ?? cleaned;
    byKey.set(tagKey(tag), tag);
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

function tagKey(tag: string): string {
  return tag.normalize("NFKC").toLowerCase();
}

export function localStamp(date: Date, timeZone?: string): { date: string; time: string; compact: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    compact: `${get("month")}${get("day")}-${get("hour")}${get("minute")}`,
  };
}

function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "session";
}

function randomId(length: number): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...randomBytes(length)].map((b) => alphabet[b % alphabet.length]).join("");
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

async function writeIfChanged(file: string, content: string): Promise<void> {
  const current = await fs.readFile(file, "utf8").catch(() => undefined);
  if (current !== content) await fs.writeFile(file, content);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
