/**
 * Dormant-email scanner (AssetScanner 実装例)。
 * 出典: dev-dashboard-v2 server/lib/marketing-debt/dormant-email-scanner.ts (#1334)。
 *
 * 過去 90 日送信のないメールキャンペーンを検出。入力 rows は注入。
 */
import { persist, type AssetScanner } from "../scanner";
import type { DebtRecord, ScanContext, ScanSummaryBase } from "../types";

const DORMANT_DAYS = 90;

export interface EmailCampaignRow {
  id: string;
  name?: string | null;
  last_sent_at: string | null;
}

export interface DormantReport {
  id: string;
  name: string;
  daysSinceLastSend: number;
  severity: "high" | "med" | "low";
}

export interface DormantEmailSummary extends ScanSummaryBase {
  dormant: number;
  reports: DormantReport[];
}

export function classifyDormancy(days: number): "high" | "med" | "low" {
  if (days >= 365) return "high";
  if (days >= 180) return "med";
  return "low";
}

export function createDormantEmailScanner(): AssetScanner<EmailCampaignRow[], DormantEmailSummary> {
  return {
    name: "dormant-email",
    async scan(tenantId, rows = [], ctx: ScanContext): Promise<DormantEmailSummary> {
      if (rows.length === 0) return { scanned: 0, dormant: 0, recorded: 0, reports: [] };
      const now = ctx.now ?? new Date();
      const reports: DormantReport[] = [];

      for (const row of rows) {
        if (!row.last_sent_at) {
          reports.push({
            id: row.id,
            name: row.name ?? row.id,
            daysSinceLastSend: Number.POSITIVE_INFINITY,
            severity: "med",
          });
          continue;
        }
        const ts = new Date(row.last_sent_at).getTime();
        if (Number.isNaN(ts)) continue;
        const days = Math.floor((now.getTime() - ts) / (24 * 60 * 60 * 1000));
        if (days < DORMANT_DAYS) continue;
        reports.push({
          id: row.id,
          name: row.name ?? row.id,
          daysSinceLastSend: days,
          severity: classifyDormancy(days),
        });
      }

      const records: DebtRecord[] = reports.map((r) => ({
        tenantId,
        assetType: "email_campaign",
        assetRef: r.id,
        freshnessScore: 0,
        decayRate: 0,
        severity: r.severity,
        recommendation: Number.isFinite(r.daysSinceLastSend)
          ? `「${r.name}」 は最終送信から ${r.daysSinceLastSend} 日経過しています。 配信再開 or 撤去を検討してください。`
          : `「${r.name}」 は一度も送信されていません。 配信開始 or 撤去を検討してください。`,
      }));
      const recorded = await persist(records, ctx);

      return { scanned: rows.length, dormant: reports.length, recorded, reports };
    },
  };
}
