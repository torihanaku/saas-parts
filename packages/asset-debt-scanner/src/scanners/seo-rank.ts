/**
 * SEO rank-drop scanner (AssetScanner 実装例)。
 * 出典: dev-dashboard-v2 server/lib/marketing-debt/seo-rank-scanner.ts (#1333)。
 *
 * キーワード順位スナップショットを比較し、30 日で 5 位以上下落した項目を検出。
 * 原文の Supabase 読み取りは入力 rows の注入に置換 (外部データは呼び出し側で用意)。
 */
import { persist, type AssetScanner } from "../scanner";
import type { DebtRecord, ScanContext, ScanSummaryBase } from "../types";

const MIN_DROP_TO_FLAG = 5;

export interface SeoKeywordRow {
  keyword: string;
  rank_30d_ago: number | null;
  rank_today: number | null;
  url?: string | null;
}

export interface RankDropReport {
  keyword: string;
  rankBefore: number;
  rankNow: number;
  dropAmount: number;
  severity: "high" | "med" | "low";
}

export interface SeoRankSummary extends ScanSummaryBase {
  drops: number;
  reports: RankDropReport[];
}

export function classifyRankDrop(drop: number): "high" | "med" | "low" {
  if (drop >= 20) return "high";
  if (drop >= 10) return "med";
  return "low";
}

export function createSeoRankScanner(): AssetScanner<SeoKeywordRow[], SeoRankSummary> {
  return {
    name: "seo-rank",
    async scan(tenantId, rows = [], ctx: ScanContext): Promise<SeoRankSummary> {
      if (rows.length === 0) return { scanned: 0, drops: 0, recorded: 0, reports: [] };

      const reports: RankDropReport[] = [];
      for (const row of rows) {
        if (row.rank_30d_ago == null || row.rank_today == null) continue;
        const drop = row.rank_today - row.rank_30d_ago;
        if (drop < MIN_DROP_TO_FLAG) continue;
        reports.push({
          keyword: row.keyword,
          rankBefore: row.rank_30d_ago,
          rankNow: row.rank_today,
          dropAmount: drop,
          severity: classifyRankDrop(drop),
        });
      }

      const records: DebtRecord[] = reports.map((r) => ({
        tenantId,
        assetType: "seo_keyword",
        assetRef: r.keyword,
        freshnessScore: 0,
        decayRate: 0,
        severity: r.severity,
        recommendation: `「${r.keyword}」 の検索順位が ${r.rankBefore} → ${r.rankNow} 位に下落 (${r.dropAmount} 位ダウン)。 リライト or 内部リンク強化を検討してください。`,
      }));
      const recorded = await persist(records, ctx);

      return { scanned: rows.length, drops: reports.length, recorded, reports };
    },
  };
}
