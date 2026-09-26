import { promises as fs } from "node:fs";
import path from "node:path";
import {
  allLabels,
  type EntryKind,
  LABELS,
  type Labels,
  type Lang,
  parseStatus,
  PROJECT_SECTION_KEYS,
  type ProjectSectionKey,
  type SessionStatus,
} from "./labels.ts";

export const WORKLOG_DIRNAME = ".worklog";

export interface StoreOptions {
  lang?: Lang;
  /** IANA time zone used for timestamps written into the logs. Defaults to the system zone. */
  timeZone?: string;
  now?: () => Date;
}

export interface StartSessionInput {
  title: string;
  goal?: string;
  branch?: string;
}

export interface EntryInput {
  kind: EntryKind;
  summary: string;
  details?: string;
  reason?: string;
  files?: string[];
}

export interface EndSessionInput {
  summary: string;
  status: Exclude<SessionStatus, "in_progress">;
  nextSteps?: string[];
  needsReview?: string[];
}

export interface SessionInfo {
  /** File name inside `.worklog/sessions/`. */
  file: string;
  title: string;
  started: string;
  ended?: string;
  status?: SessionStatus;
  branch?: string;
  goal?: string;
  summary?: string;
  nextSteps?: string;
  needsReview?: string;
  questions: string[];
}

export type UpdateMode = "replace" | "append";

export class WorklogStore {
  readonly root: string;
  readonly dir: string;
  readonly sessionsDir: string;
  readonly projectFile: string;
  readonly timelineFile: string;
  private readonly labels: Labels;
  private readonly timeZone?: string;
  private readonly now: () => Date;

  constructor(root: string, options: StoreOptions = {}) {
    this.root = root;
    this.dir = path.join(root, WORKLOG_DIRNAME);
    this.sessionsDir = path.join(this.dir, "sessions");
    this.projectFile = path.join(this.dir, "PROJECT.md");
    this.timelineFile = path.join(this.dir, "TIMELINE.md");
    this.labels = LABELS[options.lang ?? "ja"];
    this.timeZone = options.timeZone;
    this.now = options.now ?? (() => new Date());
  }

  async exists(): Promise<boolean> {
    return pathExists(this.dir);
  }

  async ensureInit(): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    if (!(await pathExists(this.projectFile))) {
      await fs.writeFile(this.projectFile, this.projectTemplate());
    }
    if (!(await pathExists(this.timelineFile))) {
      const L = this.labels;
      const header = L.timelineHeader;
      const separator = header.replace(/[^|]+/g, "---");
      await fs.writeFile(this.timelineFile, `# ${L.timelineTitle}\n\n${L.timelineIntro}\n\n${header}\n${separator}\n`);
    }
  }

  // ---------------------------------------------------------------- sessions

  async startSession(input: StartSessionInput): Promise<SessionInfo> {
    await this.ensureInit();
    const L = this.labels;
    const stamp = this.stamp();
    const file = await this.uniqueSessionFile(`${stamp.date}_${stamp.time.replace(":", "")}_${slugify(input.title)}`);
    const branch = input.branch ?? (await this.detectBranch());

    const lines = [
      `# ${input.title}`,
      "",
      `- **${L.started}**: ${stamp.date} ${stamp.time}`,
      `- **${L.ended}**: ${L.none}`,
      `- **${L.status}**: ${L.statuses.in_progress}`,
    ];
    if (branch) lines.push(`- **${L.branch}**: \`${branch}\``);
    lines.push("", `## ${L.goal}`, "", input.goal?.trim() || L.empty, "", `## ${L.log}`, "");
    await fs.writeFile(path.join(this.sessionsDir, file), lines.join("\n"));

    await this.insertTimelineRow(
      `| ${stamp.date} ${stamp.time} | [${cell(input.title)}](sessions/${file}) | ${L.statuses.in_progress} | ${cell(firstLine(input.goal) || L.none)} |`,
    );

    return { file, title: input.title, started: `${stamp.date} ${stamp.time}`, status: "in_progress", branch, goal: input.goal, questions: [] };
  }

  async appendEntry(file: string, entry: EntryInput): Promise<void> {
    const L = this.labels;
    const { time } = this.stamp();
    const parts = [`### ${time} ${L.kinds[entry.kind]}: ${oneLine(entry.summary)}`, ""];
    if (entry.details?.trim()) parts.push(entry.details.trim(), "");
    if (entry.reason?.trim()) parts.push(`**${L.reason}**: ${entry.reason.trim()}`, "");
    if (entry.files?.length) parts.push(`${L.files}: ${entry.files.map((f) => `\`${f}\``).join(", ")}`, "");

    const filePath = path.join(this.sessionsDir, file);
    const current = await fs.readFile(filePath, "utf8");
    await fs.writeFile(filePath, ensureTrailingBlankLine(current) + parts.join("\n"));
  }

  async endSession(file: string, input: EndSessionInput): Promise<SessionInfo> {
    const L = this.labels;
    const stamp = this.stamp();
    const filePath = path.join(this.sessionsDir, file);
    let text = await fs.readFile(filePath, "utf8");

    const info = parseSession(file, text);
    const review = [...info.questions, ...(input.needsReview ?? [])].map(oneLine).filter(Boolean);

    text = replaceField(text, allLabels((l) => l.ended), `- **${L.ended}**: ${stamp.date} ${stamp.time}`);
    text = replaceField(text, allLabels((l) => l.status), `- **${L.status}**: ${L.statuses[input.status]}`);

    const tail = [`## ${L.summary}`, "", input.summary.trim(), ""];
    if (review.length) tail.push(`## ${L.needsReview}`, "", ...review.map((q) => `- [ ] ${q}`), "");
    if (input.nextSteps?.length) tail.push(`## ${L.nextSteps}`, "", ...input.nextSteps.map((s) => `- [ ] ${oneLine(s)}`), "");
    await fs.writeFile(filePath, ensureTrailingBlankLine(text) + tail.join("\n"));

    await this.updateTimelineRow(file, (row) => {
      const cols = splitRow(row);
      if (cols.length < 4) return row;
      cols[2] = L.statuses[input.status];
      cols[3] = cell(firstLine(input.summary));
      return `| ${cols.join(" | ")} |`;
    });

    return parseSession(file, await fs.readFile(filePath, "utf8"));
  }

  /** Close a session nobody wrapped up (e.g. Claude was interrupted). */
  async autoClose(file: string): Promise<void> {
    await this.endSession(file, { summary: this.labels.autoClosed, status: "partial" });
  }

  async listSessionFiles(): Promise<string[]> {
    if (!(await pathExists(this.sessionsDir))) return [];
    const names = await fs.readdir(this.sessionsDir);
    return names.filter((n) => n.endsWith(".md")).sort().reverse();
  }

  async readSession(file: string): Promise<SessionInfo> {
    return parseSession(file, await fs.readFile(path.join(this.sessionsDir, file), "utf8"));
  }

  /**
   * The newest session that is still in progress and was touched recently.
   * Used to pick a session back up when the MCP server restarts mid-session.
   */
  async findResumableSession(maxAgeMs: number): Promise<string | undefined> {
    const now = this.now().getTime();
    for (const file of await this.listSessionFiles()) {
      const stat = await fs.stat(path.join(this.sessionsDir, file));
      if (now - stat.mtimeMs > maxAgeMs) continue;
      const info = await this.readSession(file);
      if (info.status === "in_progress") return file;
    }
    return undefined;
  }

  // ----------------------------------------------------------------- project

  async readProject(): Promise<string | undefined> {
    return (await pathExists(this.projectFile)) ? fs.readFile(this.projectFile, "utf8") : undefined;
  }

  async updateProject(section: string, content: string, mode: UpdateMode): Promise<string> {
    await this.ensureInit();
    const heading = this.resolveSectionHeading(section);
    const text = await fs.readFile(this.projectFile, "utf8");
    const sections = splitSections(text);
    const target = sections.find((s) => s.heading === heading);
    const body = content.trim();

    if (!target) {
      sections.push({ heading, body });
    } else if (mode === "append" && !isEmptyBody(target.body)) {
      target.body = `${target.body.trimEnd()}\n${needsGap(target.body, body) ? "\n" : ""}${body}`;
    } else {
      target.body = body;
    }
    await fs.writeFile(this.projectFile, joinSections(sections));
    return heading;
  }

  // ------------------------------------------------------------------ search

  async search(query: string, limit: number): Promise<string[]> {
    if (!(await pathExists(this.dir))) return [];
    const needle = query.toLowerCase();
    const hits: string[] = [];
    const files = [this.projectFile, this.timelineFile, ...(await this.listSessionFiles()).map((f) => path.join(this.sessionsDir, f))];
    for (const filePath of files) {
      if (!(await pathExists(filePath))) continue;
      const lines = (await fs.readFile(filePath, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (hits.length < limit && line.toLowerCase().includes(needle)) {
          hits.push(`${path.relative(this.root, filePath)}:${i + 1}: ${line.trim()}`);
        }
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  // ----------------------------------------------------------------- helpers

  private projectTemplate(): string {
    const L = this.labels;
    const sections = PROJECT_SECTION_KEYS.map((k) => `## ${L.projectSections[k]}\n\n${L.empty}\n`);
    return `# ${L.projectTitle}\n\n> ${L.projectIntro}\n\n${sections.join("\n")}`;
  }

  private resolveSectionHeading(section: string): string {
    const key = section.trim() as ProjectSectionKey;
    if ((PROJECT_SECTION_KEYS as readonly string[]).includes(key)) return this.labels.projectSections[key];
    // Accept a heading written in any language, then fall back to the literal text as a custom section.
    for (const labels of Object.values(LABELS)) {
      for (const [k, label] of Object.entries(labels.projectSections)) {
        if (label === section.trim()) return this.labels.projectSections[k as ProjectSectionKey];
      }
    }
    return section.trim().replace(/^#+\s*/, "");
  }

  private stamp(): { date: string; time: string } {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(this.now());
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
    return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
  }

  private async uniqueSessionFile(base: string): Promise<string> {
    let name = `${base}.md`;
    for (let i = 2; await pathExists(path.join(this.sessionsDir, name)); i++) name = `${base}-${i}.md`;
    return name;
  }

  private async detectBranch(): Promise<string | undefined> {
    try {
      const head = (await fs.readFile(path.join(this.root, ".git", "HEAD"), "utf8")).trim();
      return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : undefined;
    } catch {
      return undefined;
    }
  }

  private async insertTimelineRow(row: string): Promise<void> {
    const lines = (await fs.readFile(this.timelineFile, "utf8")).split("\n");
    const sep = lines.findIndex((l) => /^\|(\s*-+\s*\|)+\s*$/.test(l));
    if (sep === -1) lines.push(row);
    else lines.splice(sep + 1, 0, row);
    await fs.writeFile(this.timelineFile, lines.join("\n"));
  }

  private async updateTimelineRow(file: string, update: (row: string) => string): Promise<void> {
    if (!(await pathExists(this.timelineFile))) return;
    const lines = (await fs.readFile(this.timelineFile, "utf8")).split("\n");
    const i = lines.findIndex((l) => l.includes(`(sessions/${file})`));
    if (i === -1) return;
    lines[i] = update(lines[i]);
    await fs.writeFile(this.timelineFile, lines.join("\n"));
  }
}

// ------------------------------------------------------------------- parsing

export function parseSession(file: string, text: string): SessionInfo {
  const title = /^# (.+)$/m.exec(text)?.[1]?.trim() ?? file;
  const field = (names: string[]) => {
    for (const name of names) {
      const m = new RegExp(`^- \\*\\*${escapeRegExp(name)}\\*\\*: (.*)$`, "m").exec(text);
      if (m) return m[1].trim();
    }
    return undefined;
  };
  const sections = splitSections(text);
  const section = (names: string[]) => sections.find((s) => names.includes(s.heading))?.body.trim() || undefined;

  const questionLabels = allLabels((l) => l.kinds.question);
  const questions: string[] = [];
  const logBody = section(allLabels((l) => l.log)) ?? "";
  for (const line of logBody.split("\n")) {
    const m = /^### \d{2}:\d{2} (.+?): (.*)$/.exec(line);
    if (m && questionLabels.includes(m[1])) questions.push(m[2]);
  }

  const ended = field(allLabels((l) => l.ended));
  const branch = field(allLabels((l) => l.branch))?.replace(/`/g, "");
  return {
    file,
    title,
    started: field(allLabels((l) => l.started)) ?? "",
    ended: ended && !allLabels((l) => l.none).includes(ended) ? ended : undefined,
    status: parseStatus(field(allLabels((l) => l.status)) ?? ""),
    branch,
    goal: section(allLabels((l) => l.goal)),
    summary: section(allLabels((l) => l.summary)),
    nextSteps: section(allLabels((l) => l.nextSteps)),
    needsReview: section(allLabels((l) => l.needsReview)),
    questions,
  };
}

interface Section {
  /** Heading text without the leading `## `; empty for the preamble. */
  heading: string;
  body: string;
}

function splitSections(text: string): Section[] {
  const sections: Section[] = [{ heading: "", body: "" }];
  for (const line of text.split("\n")) {
    const m = /^## (.+)$/.exec(line);
    if (m) sections.push({ heading: m[1].trim(), body: "" });
    else sections[sections.length - 1].body += `${line}\n`;
  }
  // Every line got a trailing newline above; undo the one added to the final line.
  const last = sections[sections.length - 1];
  last.body = last.body.slice(0, -1);
  return sections;
}

function joinSections(sections: Section[]): string {
  return sections
    .map((s) => ({ ...s, body: s.body.trim() }))
    .filter((s) => s.heading || s.body)
    .map((s) => (s.heading ? `## ${s.heading}\n\n${s.body}\n` : `${s.body}\n`))
    .join("\n");
}

function isEmptyBody(body: string): boolean {
  const trimmed = body.trim();
  return trimmed === "" || allLabels((l) => l.empty).includes(trimmed);
}

/** Keep list items packed together; separate paragraphs with a blank line. */
function needsGap(existing: string, addition: string): boolean {
  const isList = (s: string) => /^\s*([-*+]|\d+\.)\s/.test(s);
  const lastLine = existing.trimEnd().split("\n").pop() ?? "";
  return !(isList(lastLine) && isList(addition));
}

function replaceField(text: string, names: string[], replacement: string): string {
  for (const name of names) {
    const re = new RegExp(`^- \\*\\*${escapeRegExp(name)}\\*\\*: .*$`, "m");
    if (re.test(text)) return text.replace(re, replacement);
  }
  return text;
}

function splitRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

// ------------------------------------------------------------------- strings

export function slugify(title: string): string {
  const slug = title
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || "session";
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function firstLine(text: string | undefined): string {
  const line = text?.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function ensureTrailingBlankLine(text: string): string {
  return text.replace(/\n*$/, "\n\n");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
