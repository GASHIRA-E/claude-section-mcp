import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Worklog } from "./store.ts";

let template: string | undefined;

/** The page template sits next to this module in both `src/` and the bundled `dist/`. */
function loadTemplate(): string {
  template ??= readFileSync(new URL("./viewer.html", import.meta.url), "utf8");
  return template;
}

/** The page body with the log embedded. It has no <html>/<head> wrapper so it can be published as an Artifact as-is. */
export async function renderViewer(log: Worklog): Promise<string> {
  const { sessions, posts } = await log.readAll();
  const data = JSON.stringify({ project: path.basename(log.root), generated: new Date().toISOString(), sessions, posts })
    // Keep the JSON from closing its <script> element.
    .replace(/</g, "\\u003c");
  return loadTemplate().replace("/*__WORKLOG_DATA__*/null", () => data);
}

export interface ViewerFiles {
  /** Full document to open in a browser. */
  page: string;
  /** Body-only variant for publishing as a claude.ai Artifact. */
  artifact: string;
}

/** Rebuild `.worklog/view/`. */
export async function writeViewer(log: Worklog): Promise<ViewerFiles> {
  await log.init();
  await fs.mkdir(log.viewDir, { recursive: true });
  const body = await renderViewer(log);
  const files = { page: path.join(log.viewDir, "index.html"), artifact: path.join(log.viewDir, "artifact.html") };
  const page = `<!doctype html>\n<html lang="ja">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
  await fs.writeFile(files.page, page);
  await fs.writeFile(files.artifact, body);
  return files;
}
