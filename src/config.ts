import { Worklog } from "./store.ts";

export const timeZone = process.env.WORKLOG_TZ || undefined;

export function openWorklog(root: string): Worklog {
  return new Worklog(root, { commit: !/^(0|false|no|off)$/i.test(process.env.WORKLOG_COMMIT ?? ""), timeZone });
}
