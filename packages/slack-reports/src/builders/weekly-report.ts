import type { BlockKitPayload } from "../types";

/**
 * 週次レポート Block Kit ビルダー。
 * 出典: dev-dashboard-v2 server/services/weeklyReportSlack.ts (#1024) の buildWeeklyReportPayload。
 */

/** 週次レポートビルダーの文言・書式設定。省略時は原文デフォルトを使う。 */
export interface WeeklyReportCopy {
  /** フォールバックテキスト。`(name, weekIso)` を受け取る。 */
  fallbackText: (tenantName: string, weekIso: string) => string;
  /** 見出し mrkdwn。`(name, weekIso)` を受け取る。 */
  heading: (tenantName: string, weekIso: string) => string;
  /** 本文の最大文字数。超過分は末尾に省略記号を付けて切り詰める。 */
  bodyMaxLength: number;
  /** 切り詰め時に付与する省略記号。 */
  ellipsis: string;
}

export const DEFAULT_WEEKLY_REPORT_COPY: WeeklyReportCopy = {
  fallbackText: (name, weekIso) => `週次レポート (${name}) — ${weekIso}`,
  heading: (name, weekIso) => `📊 *週次レポート — ${name} (${weekIso})*`,
  bodyMaxLength: 2900,
  ellipsis: "…",
};

export function buildWeeklyReportPayload(
  tenantName: string,
  weekIso: string,
  content: string,
  copy: WeeklyReportCopy = DEFAULT_WEEKLY_REPORT_COPY,
): BlockKitPayload {
  const body =
    content.length > copy.bodyMaxLength
      ? `${content.slice(0, copy.bodyMaxLength)}${copy.ellipsis}`
      : content;
  return {
    text: copy.fallbackText(tenantName, weekIso),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: copy.heading(tenantName, weekIso) },
      },
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: body },
      },
    ],
  };
}
