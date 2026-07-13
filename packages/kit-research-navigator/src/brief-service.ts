/**
 * 週次ブリーフ — 直近 windowDays 日のシグナルを verdict 別に集計し、
 * verdict 優先度 (big_deal > worth_watching > meh) → importance 降順で
 * 上位 topLimit 件と source 内訳を返す。
 *
 * 出典: 実運用SaaS server/lib/navigator/brief-service.ts
 */
import type { ContextStore, SignalStore } from "./ports";
import type { BriefSignalSummary, NavigatorBrief, Verdict } from "./types";

export interface BriefDeps {
  signalStore: SignalStore;
  contextStore: ContextStore;
  now?: () => Date;
}

export interface BriefOptions {
  /** 既定 7。 */
  windowDays?: number;
  /** 上位シグナル件数。既定 5。 */
  topLimit?: number;
  /** 走査するシグナルの上限。既定 500。 */
  fetchLimit?: number;
}

const VERDICT_ORDER: Record<Verdict, number> = {
  big_deal: 0,
  worth_watching: 1,
  meh: 2,
};

export async function buildWeeklyBrief(
  userId: string,
  deps: BriefDeps,
  options: BriefOptions = {},
): Promise<NavigatorBrief> {
  const now = deps.now ?? (() => new Date());
  const windowDays = options.windowDays ?? 7;
  const topLimit = options.topLimit ?? 5;
  const fetchLimit = options.fetchLimit ?? 500;

  const windowEnd = now().toISOString();
  const windowStart = new Date(
    now().getTime() - windowDays * 86_400_000,
  ).toISOString();

  const signals = await deps.signalStore.listSince(
    userId,
    windowStart,
    fetchLimit,
  );
  const contexts = await deps.contextStore.listBySignalIds(
    userId,
    signals.map((s) => s.id),
  );
  const ctxBySignal = new Map(contexts.map((c) => [c.signalId, c]));

  const totals = { big_deal: 0, worth_watching: 0, meh: 0, uncategorized: 0 };
  const sourceCounts = new Map<string, number>();
  const summaries: BriefSignalSummary[] = [];

  for (const signal of signals) {
    const ctx = ctxBySignal.get(signal.id);
    if (!ctx) {
      totals.uncategorized += 1;
    } else {
      totals[ctx.verdict] += 1;
    }

    sourceCounts.set(signal.source, (sourceCounts.get(signal.source) ?? 0) + 1);

    if (ctx) {
      summaries.push({
        signalId: signal.id,
        source: signal.source,
        url: signal.url,
        title: signal.title,
        verdict: ctx.verdict,
        importanceScore: ctx.importanceScore,
        rationale: ctx.rationale,
        fetchedAt: signal.fetchedAt,
      });
    }
  }

  summaries.sort((a, b) => {
    if (VERDICT_ORDER[a.verdict] !== VERDICT_ORDER[b.verdict]) {
      return VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
    }
    return b.importanceScore - a.importanceScore;
  });

  const bySource = [...sourceCounts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));

  return {
    windowStart,
    windowEnd,
    totals,
    topSignals: summaries.slice(0, topLimit),
    bySource,
  };
}
