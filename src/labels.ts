export type Lang = "ja" | "en";

export const ENTRY_KINDS = ["task", "decision", "issue", "result", "question", "note"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const END_STATUSES = ["completed", "partial", "blocked"] as const;
export type SessionStatus = "in_progress" | (typeof END_STATUSES)[number];

export const PROJECT_SECTION_KEYS = ["overview", "status", "decisions", "todos", "notes"] as const;
export type ProjectSectionKey = (typeof PROJECT_SECTION_KEYS)[number];

export interface Labels {
  started: string;
  ended: string;
  status: string;
  branch: string;
  goal: string;
  log: string;
  summary: string;
  needsReview: string;
  nextSteps: string;
  files: string;
  reason: string;
  kinds: Record<EntryKind, string>;
  statuses: Record<SessionStatus, string>;
  timelineTitle: string;
  timelineIntro: string;
  timelineHeader: string;
  projectTitle: string;
  projectIntro: string;
  projectSections: Record<ProjectSectionKey, string>;
  empty: string;
  none: string;
  autoClosed: string;
}

export const LABELS: Record<Lang, Labels> = {
  ja: {
    started: "開始",
    ended: "終了",
    status: "状態",
    branch: "ブランチ",
    goal: "🎯 目的",
    log: "📋 作業ログ",
    summary: "📝 まとめ",
    needsReview: "🙋 人間の確認が必要な事項",
    nextSteps: "➡️ 次にやること",
    files: "関連ファイル",
    reason: "理由",
    kinds: {
      task: "🔧 作業",
      decision: "🧭 判断",
      issue: "⚠️ 問題",
      result: "✅ 成果",
      question: "🙋 要確認",
      note: "💬 メモ",
    },
    statuses: {
      in_progress: "🟡 進行中",
      completed: "🟢 完了",
      partial: "🟠 一部完了",
      blocked: "🔴 ブロック中",
    },
    timelineTitle: "📅 作業タイムライン",
    timelineIntro: "Claude の作業セッション一覧です（新しい順）。各セッションの詳細はリンク先を参照してください。",
    timelineHeader: "| 日時 | セッション | 状態 | 概要 |",
    projectTitle: "📘 プロジェクトノート",
    projectIntro:
      "Claude と人間が一緒に更新するプロジェクトの要約です。セッションをまたいで引き継ぎたい情報をここに残します。人間が直接編集しても構いません。",
    projectSections: {
      overview: "概要",
      status: "現在の状況",
      decisions: "設計・重要な決定",
      todos: "未完了タスク・課題",
      notes: "メモ",
    },
    empty: "（未記入）",
    none: "—",
    autoClosed: "（まとめが記録されないまま次のセッションが開始されたため、自動的に閉じました）",
  },
  en: {
    started: "Started",
    ended: "Ended",
    status: "Status",
    branch: "Branch",
    goal: "🎯 Goal",
    log: "📋 Work log",
    summary: "📝 Summary",
    needsReview: "🙋 Needs human review",
    nextSteps: "➡️ Next steps",
    files: "Files",
    reason: "Reason",
    kinds: {
      task: "🔧 Task",
      decision: "🧭 Decision",
      issue: "⚠️ Issue",
      result: "✅ Result",
      question: "🙋 Question",
      note: "💬 Note",
    },
    statuses: {
      in_progress: "🟡 In progress",
      completed: "🟢 Completed",
      partial: "🟠 Partially done",
      blocked: "🔴 Blocked",
    },
    timelineTitle: "📅 Work timeline",
    timelineIntro: "Claude work sessions, newest first. Follow a link for the full session log.",
    timelineHeader: "| When | Session | Status | Summary |",
    projectTitle: "📘 Project notes",
    projectIntro:
      "A running summary of the project, kept up to date by Claude and humans alike so context survives across sessions. Feel free to edit it by hand.",
    projectSections: {
      overview: "Overview",
      status: "Current status",
      decisions: "Design & key decisions",
      todos: "Open tasks & issues",
      notes: "Notes",
    },
    empty: "(empty)",
    none: "—",
    autoClosed: "(Closed automatically because a new session started before this one was wrapped up.)",
  },
};

export function resolveLang(value: string | undefined): Lang {
  return value?.toLowerCase().startsWith("en") ? "en" : "ja";
}

/** Match a status label written in either language back to its key. */
export function parseStatus(text: string): SessionStatus | undefined {
  for (const labels of Object.values(LABELS)) {
    for (const [key, label] of Object.entries(labels.statuses)) {
      if (text.includes(label)) return key as SessionStatus;
    }
  }
  return undefined;
}

/** Every label a given heading/field may have been written with, across languages. */
export function allLabels(pick: (labels: Labels) => string): string[] {
  return Object.values(LABELS).map(pick);
}
