import type { IsoWeekFn } from "./types";

/**
 * ISO 8601 週文字列 (YYYY-WNN) を返す。
 *
 * 週の判定は「その週の木曜日が属する年・週番号」に従う (ISO 8601 準拠)。
 * 出典: 実運用SaaS server/services/weeklyReportSlack.ts の isoWeek。
 */
export const isoWeek: IsoWeekFn = (date: Date = new Date()): string => {
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const dayNum = target.getUTCDay() || 7; // Mon=1, Sun=7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(
    ((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${target.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
};
