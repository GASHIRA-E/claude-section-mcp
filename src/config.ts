import { Worklog } from "./store.ts";

const off = (value: string | undefined) => /^(0|false|no|off)$/i.test(value ?? "");

export const timeZone = process.env.WORKLOG_TZ || undefined;
export const summariesEnabled = !off(process.env.WORKLOG_SUMMARIZE);

export function openWorklog(root: string): Worklog {
  return new Worklog(root, { commit: !off(process.env.WORKLOG_COMMIT), timeZone });
}
