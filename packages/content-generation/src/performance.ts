/**
 * コンテンツ実績（パフォーマンス）メトリクスの合成。
 *
 * 実運用SaaS の content performance ルートから、決定的な seeded RNG による
 * メトリクス合成と集計ロジックを抽出（Supabase フェッチと Hono レスポンスは除外）。
 * draft ID をシードにするため、同じ入力からは常に同じメトリクスが再現される。
 */

export interface ContentDraftLike {
  id: string;
  title: string;
  type?: string;
  created_at?: string;
  seo_score?: number;
}

export interface ContentPerformanceMetric {
  draft_id: string;
  title: string;
  type: string;
  published_at: string;
  views: number;
  unique_visitors: number;
  avg_time_on_page: number;
  bounce_rate: number;
  shares: { x: number; linkedin: number; other: number };
  seo_score: number;
  leads: number;
}

/** 文字列シードから決定的な擬似乱数生成器を作る（Park–Miller）。 */
export function seededRng(seed: string): () => number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return () => {
    h = (h * 16807) % 2147483647;
    return (h & 0x7fffffff) / 2147483647;
  };
}

/** 1 件の draft から実績メトリクスを合成。 */
export function synthesizeMetric(draft: ContentDraftLike): ContentPerformanceMetric {
  const rng = seededRng(draft.id || draft.title || "default");
  const type = draft.type || "article";
  const baseViews =
    type === "article" ? 300 : type === "sns-x" ? 150 : type === "sns-linkedin" ? 200 : 100;
  const views = Math.round(baseViews * (0.5 + rng() * 2.5));
  return {
    draft_id: draft.id,
    title: draft.title,
    type,
    published_at: draft.created_at || new Date().toISOString(),
    views,
    unique_visitors: Math.round(views * (0.65 + rng() * 0.2)),
    avg_time_on_page: Math.round(60 + rng() * 240),
    bounce_rate: Math.round(25 + rng() * 40),
    shares: {
      x: Math.round(rng() * 25),
      linkedin: Math.round(rng() * 15),
      other: Math.round(rng() * 8),
    },
    seo_score: draft.seo_score || Math.round(50 + rng() * 45),
    leads: Math.round(rng() * 5),
  };
}

export interface PerformanceReport {
  overview: {
    total_published: number;
    total_views: number;
    avg_engagement_rate: number;
    avg_seo_score: number;
    total_leads_generated: number;
  };
  content_metrics: ContentPerformanceMetric[];
  trends: {
    daily_views: { date: string; views: number }[];
    weekly_engagement: { week: string; engagement_rate: number }[];
  };
  top_performing: ContentPerformanceMetric[];
  by_type: Record<string, { count: number; avg_views: number }>;
}

/** draft 一覧から実績レポート全体を合成。 */
export function buildPerformanceReport(
  drafts: ContentDraftLike[],
  now: Date = new Date(),
): PerformanceReport {
  const contentMetrics = drafts.map(synthesizeMetric);

  const totalViews = contentMetrics.reduce((s, m) => s + m.views, 0);
  const totalLeads = contentMetrics.reduce((s, m) => s + m.leads, 0);
  const avgEngagement =
    contentMetrics.length > 0
      ? Math.round(
          (contentMetrics.reduce((s, m) => s + ((100 - m.bounce_rate) / 100) * 5, 0) /
            contentMetrics.length) *
            10,
        ) / 10
      : 0;
  const avgSeo =
    contentMetrics.length > 0
      ? Math.round(contentMetrics.reduce((s, m) => s + m.seo_score, 0) / contentMetrics.length)
      : 0;

  const dailyViews: { date: string; views: number }[] = [];
  const trendRng = seededRng("daily-trend");
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dailyViews.push({
      date: d.toISOString().split("T")[0]!,
      views: Math.round(50 + trendRng() * 200 + (30 - i) * 3),
    });
  }

  const weeklyEngagement: { week: string; engagement_rate: number }[] = [];
  const weekRng = seededRng("weekly-engagement");
  for (let i = 7; i >= 0; i--) {
    const weekNum = (Math.ceil((now.getTime() - i * 7 * 86400000) / (7 * 86400000)) % 52) + 1;
    weeklyEngagement.push({ week: `W${weekNum}`, engagement_rate: Math.round((2 + weekRng() * 3) * 10) / 10 });
  }

  const topPerforming = [...contentMetrics].sort((a, b) => b.views - a.views).slice(0, 5);
  const byType: Record<string, { count: number; avg_views: number }> = {};
  for (const m of contentMetrics) {
    const bucket = (byType[m.type] ??= { count: 0, avg_views: 0 });
    bucket.count++;
    bucket.avg_views += m.views;
  }
  for (const t of Object.keys(byType)) {
    const bucket = byType[t]!;
    bucket.avg_views = Math.round(bucket.avg_views / bucket.count);
  }

  return {
    overview: {
      total_published: contentMetrics.length,
      total_views: totalViews,
      avg_engagement_rate: avgEngagement,
      avg_seo_score: avgSeo,
      total_leads_generated: totalLeads,
    },
    content_metrics: contentMetrics,
    trends: { daily_views: dailyViews, weekly_engagement: weeklyEngagement },
    top_performing: topPerforming,
    by_type: byType,
  };
}
