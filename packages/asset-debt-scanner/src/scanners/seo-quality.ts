/**
 * SEO quality scanner (AssetScanner 実装例)。
 * 出典: dev-dashboard-v2 server/lib/marketing-debt/seo-quality-scanner.ts (#1295)。
 *
 * 取得済み HTML 文字列に対する純粋関数チェック (title/meta/h1/img alt)。I/O なし。
 * asset_type='seo_article' で URL 単位に issues をロールアップして記録する。
 */
import { persist, type AssetScanner } from "../scanner";
import type { DebtRecord, ScanContext, ScanSummaryBase } from "../types";

export type SeoIssueKind =
  | "title_missing"
  | "title_too_short"
  | "title_too_long"
  | "meta_missing"
  | "meta_too_short"
  | "meta_too_long"
  | "h1_missing"
  | "h1_duplicate"
  | "img_alt_missing";

export interface SeoIssue {
  kind: SeoIssueKind;
  message: string;
  severity: "high" | "med" | "low";
  count?: number;
}

export interface SeoTarget {
  url: string;
  html: string;
}

export interface SeoScanReport {
  url: string;
  issues: SeoIssue[];
}

export interface SeoScanSummary extends ScanSummaryBase {
  withIssues: number;
  totalIssues: number;
  reports: SeoScanReport[];
}

export function analyzeSeoQuality(html: string): SeoIssue[] {
  const issues: SeoIssue[] = [];

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const titleText = titleMatch ? titleMatch[1]!.trim() : "";
  if (!titleText) {
    issues.push({ kind: "title_missing", message: "<title> が空または欠落しています。", severity: "high" });
  } else if (titleText.length < 10) {
    issues.push({ kind: "title_too_short", message: `title が ${titleText.length} 文字。 10 文字以上推奨。`, severity: "med" });
  } else if (titleText.length > 60) {
    issues.push({ kind: "title_too_long", message: `title が ${titleText.length} 文字。 SERP で 60 字超は省略されます。`, severity: "low" });
  }

  const metaMatch = html.match(/<meta[^>]+name=['"]description['"][^>]*content=['"]([^'"]*)['"]/i);
  const meta = metaMatch ? metaMatch[1]!.trim() : "";
  if (!meta) {
    issues.push({ kind: "meta_missing", message: "meta description が見つかりません。", severity: "high" });
  } else if (meta.length < 50) {
    issues.push({ kind: "meta_too_short", message: `meta description が ${meta.length} 文字。 50 字以上推奨。`, severity: "med" });
  } else if (meta.length > 160) {
    issues.push({ kind: "meta_too_long", message: `meta description が ${meta.length} 文字。 160 字超は省略されます。`, severity: "low" });
  }

  const h1Matches = html.match(/<h1\b[^>]*>/gi) ?? [];
  if (h1Matches.length === 0) {
    issues.push({ kind: "h1_missing", message: "<h1> がありません。", severity: "high" });
  } else if (h1Matches.length > 1) {
    issues.push({ kind: "h1_duplicate", message: `<h1> が ${h1Matches.length} 個あります。 1 ページ 1 個推奨。`, severity: "med", count: h1Matches.length });
  }

  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  const missingAlt = imgs.filter((tag) => {
    const altMatch = tag.match(/alt=['"]([^'"]*)['"]/i);
    return !altMatch || altMatch[1]!.trim().length === 0;
  });
  if (missingAlt.length > 0) {
    issues.push({
      kind: "img_alt_missing",
      message: `${missingAlt.length} / ${imgs.length} の <img> に alt 属性が欠落しています。`,
      severity: missingAlt.length === imgs.length ? "high" : "med",
      count: missingAlt.length,
    });
  }

  return issues;
}

export function createSeoQualityScanner(): AssetScanner<SeoTarget[], SeoScanSummary> {
  return {
    name: "seo-quality",
    async scan(tenantId, targets = [], ctx: ScanContext): Promise<SeoScanSummary> {
      const reports: SeoScanReport[] = targets.map((t) => ({
        url: t.url,
        issues: analyzeSeoQuality(t.html),
      }));
      const withIssues = reports.filter((r) => r.issues.length > 0);
      const totalIssues = reports.reduce((sum, r) => sum + r.issues.length, 0);

      const records: DebtRecord[] = withIssues.map((report) => {
        const severity = report.issues.some((i) => i.severity === "high")
          ? "high"
          : report.issues.some((i) => i.severity === "med")
            ? "med"
            : "low";
        return {
          tenantId,
          assetType: "seo_article",
          assetRef: report.url,
          freshnessScore: Math.max(0, 1 - report.issues.length * 0.1),
          decayRate: 0,
          severity,
          recommendation: report.issues.map((i) => `• ${i.message}`).join("\n"),
          lastActiveAt: null,
        };
      });
      const recorded = await persist(records, ctx);

      return {
        scanned: reports.length,
        withIssues: withIssues.length,
        totalIssues,
        recorded,
        reports,
      };
    },
  };
}
