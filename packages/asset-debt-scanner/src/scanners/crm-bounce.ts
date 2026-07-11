/**
 * CRM bounce scanner (AssetScanner 実装例)。
 * 出典: dev-dashboard-v2 server/lib/marketing-debt/crm-bounce-scanner.ts (#1335)。
 *
 * 配信ログを list_id 別に集計し bounce 率 > 5% のリストを検出。入力 rows は注入。
 */
import { persist, type AssetScanner } from "../scanner";
import type { DebtRecord, ScanContext, ScanSummaryBase } from "../types";

const BOUNCE_THRESHOLD = 0.05;
const BAD_STATUSES = new Set(["bounced", "dropped", "spam"]);

export interface CrmDeliveryRow {
  status: string;
  provider?: string | null;
  sent_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CrmBounceReport {
  listId: string;
  listName: string;
  sent: number;
  bounced: number;
  bounceRate: number;
  severity: "high" | "med" | "low";
}

export interface CrmBounceSummary extends ScanSummaryBase {
  unhealthy: number;
  reports: CrmBounceReport[];
}

export function classifyBounceRate(rate: number): "high" | "med" | "low" {
  if (rate >= 0.1) return "high";
  if (rate >= 0.075) return "med";
  return "low";
}

function readListId(row: CrmDeliveryRow): string {
  const meta = row.metadata ?? {};
  const id =
    meta.list_id ??
    meta.audience_id ??
    meta.segment_id ??
    meta.campaign_id ??
    row.provider ??
    "unknown";
  return String(id);
}

function readListName(row: CrmDeliveryRow, fallback: string): string {
  const meta = row.metadata ?? {};
  const name = meta.list_name ?? meta.audience_name ?? meta.segment_name ?? meta.campaign_name;
  return typeof name === "string" && name.trim() ? name.trim() : fallback;
}

export function createCrmBounceScanner(): AssetScanner<CrmDeliveryRow[], CrmBounceSummary> {
  return {
    name: "crm-bounce",
    async scan(tenantId, rows = [], ctx: ScanContext): Promise<CrmBounceSummary> {
      if (rows.length === 0) return { scanned: 0, unhealthy: 0, recorded: 0, reports: [] };

      const buckets = new Map<string, { listName: string; sent: number; bounced: number }>();
      for (const row of rows) {
        const listId = readListId(row);
        const listName = readListName(row, listId);
        const bucket = buckets.get(listId) ?? { listName, sent: 0, bounced: 0 };
        bucket.sent += 1;
        if (BAD_STATUSES.has(row.status)) bucket.bounced += 1;
        buckets.set(listId, bucket);
      }

      const reports = Array.from(buckets.entries())
        .map(([listId, bucket]) => {
          const bounceRate = bucket.sent > 0 ? bucket.bounced / bucket.sent : 0;
          return {
            listId,
            listName: bucket.listName,
            sent: bucket.sent,
            bounced: bucket.bounced,
            bounceRate,
            severity: classifyBounceRate(bounceRate),
          };
        })
        .filter((report) => report.bounceRate > BOUNCE_THRESHOLD);

      const records: DebtRecord[] = reports.map((report) => {
        const pctStr = (report.bounceRate * 100).toFixed(1);
        return {
          tenantId,
          assetType: "crm_data",
          assetRef: report.listId,
          freshnessScore: Math.max(0, 1 - report.bounceRate * 10),
          decayRate: 0.003,
          severity: report.severity,
          recommendation: `「${report.listName}」 の bounce rate が ${pctStr}% です。無効アドレス除去・再許諾・配信停止リスト同期を確認してください。`,
        };
      });
      const recorded = await persist(records, ctx);

      return { scanned: rows.length, unhealthy: reports.length, recorded, reports };
    },
  };
}
