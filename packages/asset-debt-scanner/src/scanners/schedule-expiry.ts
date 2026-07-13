/**
 * Schedule expiry scanner (AssetScanner 実装例)。
 * 出典: 実運用SaaS server/lib/marketing-debt/schedule-expiry-scanner.ts (#1295)。
 *
 * pending スケジュールのうち予定時刻が過去のものを検出 (取りこぼし公開/承認滞留)。
 * asset_type='campaign' で記録。入力 rows は注入。
 */
import { persist, type AssetScanner } from "../scanner";
import type { DebtRecord, ScanContext, ScanSummaryBase } from "../types";

export interface ScheduledRow {
  id: string;
  scheduled_for: string;
  status: string;
  title?: string | null;
}

export interface ExpiryReport {
  id: string;
  daysOverdue: number;
  severity: "high" | "med" | "low";
}

export interface ExpirySummary extends ScanSummaryBase {
  expired: number;
  reports: ExpiryReport[];
}

export function classifyOverdue(daysOverdue: number): "high" | "med" | "low" {
  if (daysOverdue >= 7) return "high";
  if (daysOverdue >= 1) return "med";
  return "low";
}

export function createScheduleExpiryScanner(): AssetScanner<ScheduledRow[], ExpirySummary> {
  return {
    name: "schedule-expiry",
    async scan(tenantId, rows = [], ctx: ScanContext): Promise<ExpirySummary> {
      if (rows.length === 0) return { scanned: 0, expired: 0, recorded: 0, reports: [] };
      const now = ctx.now ?? new Date();
      const reports: ExpiryReport[] = [];
      for (const row of rows) {
        // 原典 (実運用SaaS) は DB 側で `.eq("status", "pending")` して
        // pending のみ取得していた。移植で rows を注入化した際にこの絞り込みが
        // 落ちており、既に publish/完了/キャンセル済みで scheduled_for が過去の
        // スケジュールまで「期限超過」として誤検知していた (wrong-asset 提案)。
        if (row.status !== "pending") continue;
        const ts = new Date(row.scheduled_for).getTime();
        if (Number.isNaN(ts)) continue;
        if (ts >= now.getTime()) continue;
        const daysOverdue = Math.floor((now.getTime() - ts) / (24 * 60 * 60 * 1000));
        reports.push({ id: row.id, daysOverdue, severity: classifyOverdue(daysOverdue) });
      }

      const byId = new Map(rows.map((r) => [r.id, r]));
      const records: DebtRecord[] = reports.map((r) => {
        const source = byId.get(r.id);
        return {
          tenantId,
          assetType: "campaign",
          assetRef: r.id,
          freshnessScore: 0,
          decayRate: 0,
          severity: r.severity,
          recommendation: source?.title
            ? `「${source.title}」 が ${r.daysOverdue} 日経過しています。 再スケジュール or 取り下げを検討してください。`
            : `スケジュール ${r.id} が ${r.daysOverdue} 日経過しています。`,
          lastActiveAt: source?.scheduled_for ?? null,
        };
      });
      const recorded = await persist(records, ctx);

      return { scanned: rows.length, expired: reports.length, recorded, reports };
    },
  };
}
