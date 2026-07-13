import type { BlockKitPayload } from "../types";

/**
 * 経営ステータス Block Kit ビルダー。
 * 出典: 実運用SaaS server/services/executiveStatusSlack.ts (#1034) の buildExecutiveStatusPayload。
 *
 * weeklyReport と同型だが本文上限が短く (経営層向けの簡潔版)、見出し絵文字が異なる。
 */
export interface ExecutiveStatusCopy {
  fallbackText: (tenantName: string, weekIso: string) => string;
  heading: (tenantName: string, weekIso: string) => string;
  bodyMaxLength: number;
  ellipsis: string;
}

export const DEFAULT_EXECUTIVE_STATUS_COPY: ExecutiveStatusCopy = {
  fallbackText: (name, weekIso) => `経営ステータス (${name}) — ${weekIso}`,
  heading: (name, weekIso) => `🎯 *経営ステータス — ${name} (${weekIso})*`,
  bodyMaxLength: 1500,
  ellipsis: "…",
};

export function buildExecutiveStatusPayload(
  tenantName: string,
  weekIso: string,
  content: string,
  copy: ExecutiveStatusCopy = DEFAULT_EXECUTIVE_STATUS_COPY,
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
