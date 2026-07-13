/**
 * similarity-predict.ts — embedding 類似検索ベースの反応予測・推薦。
 *
 * pattern-alerts.ts（Jaccard・API 依存なし）の高精度版。良い例 / 悪い例の
 * スナップショット（承認 / 却下）+ 実績（PV/CV/エンゲージメント）を蓄積し、
 * 新しいコンテンツの近傍から反応を予測する:
 *
 *   - predictBySimilarity  — 近傍スナップショットの実績平均から PV/CV/
 *     エンゲージメントを予測（任意で LLM 補正係数 0.5〜1.5）。
 *   - recommendBySimilarity — ベストチャネル + 失敗警告（却下コーパス近傍）+
 *     成功推薦（最良実績の近傍）。
 *   - getSnapshotStats / listSnapshotSummaries — ダッシュボード用集計。
 *   - ingestSnapshots — 既存コンテンツの embedding 化 + 重複防止付き蓄積。
 *
 * 出典: 実運用SaaS `server/lib/brand-dna/prediction-service.ts`,
 * `recommendation-service.ts`, `ingest-service.ts`,
 * `server/routes/brand-dna/stats.ts`（集計部分のみ — HTTP 配線は落とした）。
 * pgvector RPC → EmbeddingSearcher 注入、Supabase → SnapshotStore /
 * PerformanceStore 注入、Claude 直呼び → LlmCaller 注入。
 */

import type { EmbeddingGenerator, EmbeddingSearcher, LlmCaller } from "./types.js";
import type {
  ApprovalStatus,
  PatternSnapshot,
  PerformanceStore,
  SnapshotStore,
} from "./stores.js";

// ─── predictBySimilarity ────────────────────────────────────────────────────

export interface SimilarityPredictDeps {
  searcher: EmbeddingSearcher;
  performance: PerformanceStore;
  /** 与えると近傍平均に対する LLM 補正係数（0.5〜1.5）を適用（≥3 サンプル時のみ）。 */
  llm?: LlmCaller;
}

export interface SimilarityPredictInput {
  tenantId: string;
  contentText: string;
  channel: string;
  /** 近傍数。デフォルト 5。 */
  topK?: number;
  /** 類似度しきい値。デフォルト 0.7。 */
  threshold?: number;
}

export interface SimilarityPredictOutput {
  predicted: {
    pv: number | null;
    cv: number | null;
    engagementScore: number | null;
  };
  confidence: "low" | "medium" | "high";
  neighbors: Array<{
    snapshotId: string;
    similarity: number;
    pv: number;
    cv: number;
    engagementScore: number | null;
  }>;
  reason: string;
}

export async function predictBySimilarity(
  deps: SimilarityPredictDeps,
  input: SimilarityPredictInput,
): Promise<SimilarityPredictOutput> {
  const topK = input.topK ?? 5;
  const threshold = input.threshold ?? 0.7;

  const neighbors = await deps.searcher.search(input.contentText, {
    tenantId: input.tenantId,
    topK,
    threshold,
    status: "approved",
  });

  if (!neighbors || neighbors.length === 0) {
    return {
      predicted: { pv: null, cv: null, engagementScore: null },
      confidence: "low",
      neighbors: [],
      reason: "insufficient_data_no_neighbors",
    };
  }

  const snapshotIds = neighbors.map((n) => n.id);
  const perfs = await deps.performance.listBySnapshotIds(input.tenantId, snapshotIds, [
    input.channel,
  ]);

  if (!perfs || perfs.length === 0) {
    return {
      predicted: { pv: null, cv: null, engagementScore: null },
      confidence: "low",
      neighbors: neighbors.map((n) => ({
        snapshotId: n.id,
        similarity: n.similarity,
        pv: 0,
        cv: 0,
        engagementScore: null,
      })),
      reason: "insufficient_data_no_performance_for_channel",
    };
  }

  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  const pvAvg = avg(perfs.map((p) => p.pv));
  const cvAvg = avg(perfs.map((p) => p.cv));
  const engagementScores = perfs
    .map((p) => p.engagementScore)
    .filter((v): v is number => v !== null);
  const engAvg = avg(engagementScores);

  // LLM による補正係数（≥3 サンプル時のみ — コストを抑える）。
  const multiplier =
    deps.llm && perfs.length >= 3
      ? await fetchCorrectionMultiplier(deps.llm, {
          contentText: input.contentText,
          channel: input.channel,
          neighborSampleSize: perfs.length,
          baseline: { pv: pvAvg, cv: cvAvg, engagement: engAvg },
        })
      : 1;

  return {
    predicted: {
      pv: pvAvg !== null ? Math.round(pvAvg * multiplier) : null,
      cv: cvAvg !== null ? Math.round(cvAvg * multiplier) : null,
      engagementScore: engAvg !== null ? Number((engAvg * multiplier).toFixed(2)) : null,
    },
    confidence: perfs.length >= 5 ? "high" : perfs.length >= 3 ? "medium" : "low",
    neighbors: neighbors.map((n) => {
      const perf = perfs.find((p) => p.snapshotId === n.id);
      return {
        snapshotId: n.id,
        similarity: n.similarity,
        pv: perf?.pv ?? 0,
        cv: perf?.cv ?? 0,
        engagementScore: perf?.engagementScore ?? null,
      };
    }),
    reason: `based_on_${perfs.length}_neighbors`,
  };
}

interface CorrectionInput {
  contentText: string;
  channel: string;
  neighborSampleSize: number;
  baseline: { pv: number | null; cv: number | null; engagement: number | null };
}

const MIN_MULTIPLIER = 0.5;
const MAX_MULTIPLIER = 1.5;

/**
 * 近傍平均のベースラインに対する 0.5〜1.5 の補正係数を LLM に問う。
 * 失敗時は 1（LlmCaller の fallback 契約 + 数値検証）。
 */
async function fetchCorrectionMultiplier(
  llm: LlmCaller,
  input: CorrectionInput,
): Promise<number> {
  const prompt = [
    `Channel: ${input.channel}`,
    `Neighbor samples: ${input.neighborSampleSize}`,
    `Baseline: pv=${input.baseline.pv ?? "n/a"} cv=${input.baseline.cv ?? "n/a"} engagement=${input.baseline.engagement ?? "n/a"}`,
    `Content excerpt: ${input.contentText.slice(0, 800)}`,
    "",
    `Return a JSON object {"multiplier": number, "reason": string} where multiplier`,
    `is between 0.5 and 1.5 representing how strongly this specific content should`,
    `out- or under-perform the neighbor baseline based on tone, novelty, channel fit.`,
  ].join("\n");

  const fallback = { multiplier: 1, reason: "fallback" };
  const result = await llm.generateJson<{ multiplier: number; reason: string }>(
    "You are a marketing performance correction expert. Reply with JSON only.",
    prompt,
    fallback,
    { maxTokens: 200 },
  );

  const m = Number(result.multiplier);
  if (!Number.isFinite(m)) return 1;
  return Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, m));
}

// ─── recommendBySimilarity ──────────────────────────────────────────────────

export interface SimilarityRecommendInput {
  tenantId: string;
  contentText: string;
  candidateChannels?: string[];
}

export interface SimilarityRecommendOptions {
  /** candidateChannels 未指定時の既定候補。デフォルト ["blog","email","social"]。 */
  defaultChannels?: string[];
  /** 承認コーパス検索のしきい値 / 件数。デフォルト 0.6 / 20。 */
  approvedThreshold?: number;
  approvedCount?: number;
  /** 却下コーパス（失敗警告）検索のしきい値。デフォルト 0.75。 */
  rejectedThreshold?: number;
}

export interface SimilarityRecommendOutput {
  bestChannel: {
    channel: string;
    avgEngagement: number;
    sampleSize: number;
  } | null;
  failureWarning: {
    similarRejectedSnapshotId: string;
    similarity: number;
    rejectionReason: string | null;
  } | null;
  successRecommendation: {
    snapshotId: string;
    similarity: number;
    topPerformance: { channel: string; pv: number; cv: number };
  } | null;
  reason: string;
}

export async function recommendBySimilarity(
  deps: SimilarityPredictDeps,
  input: SimilarityRecommendInput,
  opts: SimilarityRecommendOptions = {},
): Promise<SimilarityRecommendOutput> {
  const channels = input.candidateChannels ?? opts.defaultChannels ?? ["blog", "email", "social"];

  const approvedNeighbors = await deps.searcher.search(input.contentText, {
    tenantId: input.tenantId,
    topK: opts.approvedCount ?? 20,
    threshold: opts.approvedThreshold ?? 0.6,
    status: "approved",
  });

  let bestChannel: SimilarityRecommendOutput["bestChannel"] = null;
  let successRecommendation: SimilarityRecommendOutput["successRecommendation"] = null;

  if (approvedNeighbors && approvedNeighbors.length > 0) {
    const ids = approvedNeighbors.map((n) => n.id);
    const perfs = await deps.performance.listBySnapshotIds(input.tenantId, ids, channels);

    if (perfs && perfs.length > 0) {
      // (1) ベストチャネル
      const byChannel = new Map<string, number[]>();
      for (const p of perfs) {
        if (p.engagementScore == null) continue;
        if (!byChannel.has(p.channel)) byChannel.set(p.channel, []);
        byChannel.get(p.channel)!.push(p.engagementScore);
      }

      let best: { channel: string; avg: number; n: number } | null = null;
      for (const [ch, scores] of byChannel) {
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        if (!best || avg > best.avg) best = { channel: ch, avg, n: scores.length };
      }
      if (best) {
        bestChannel = {
          channel: best.channel,
          avgEngagement: Number(best.avg.toFixed(2)),
          sampleSize: best.n,
        };
      }

      // (3) 成功推薦（最良エンゲージメントの近傍）
      let topPerf: (typeof perfs)[number] | null = null;
      for (const p of perfs) {
        if (p.engagementScore == null) continue;
        if (!topPerf || (topPerf.engagementScore ?? -Infinity) < p.engagementScore) {
          topPerf = p;
        }
      }

      if (topPerf) {
        const n = approvedNeighbors.find((x) => x.id === topPerf!.snapshotId);
        if (n) {
          successRecommendation = {
            snapshotId: topPerf.snapshotId,
            similarity: n.similarity,
            topPerformance: { channel: topPerf.channel, pv: topPerf.pv, cv: topPerf.cv },
          };
        }
      }
    }
  }

  // (2) 失敗警告（却下コーパスの最近傍 1 件）
  const rejectedNeighbors = await deps.searcher.search(input.contentText, {
    tenantId: input.tenantId,
    topK: 1,
    threshold: opts.rejectedThreshold ?? 0.75,
    status: "rejected",
  });

  const top = rejectedNeighbors?.[0];
  const failureWarning = top
    ? {
        similarRejectedSnapshotId: top.id,
        similarity: top.similarity,
        rejectionReason: top.rejectionReason ?? null,
      }
    : null;

  return {
    bestChannel,
    failureWarning,
    successRecommendation,
    reason:
      bestChannel || failureWarning || successRecommendation
        ? "matches_found"
        : "insufficient_data",
  };
}

// ─── 集計（本家 routes/brand-dna/stats.ts の計算部分） ──────────────────────

export interface SnapshotStats {
  totalSnapshots: number;
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  performanceRowCount: number;
}

export async function getSnapshotStats(
  snapshots: SnapshotStore,
  performance: PerformanceStore,
  tenantId: string,
): Promise<SnapshotStats> {
  const byStatus = await snapshots.countByStatus(tenantId);
  const performanceRowCount = await performance.count(tenantId);
  return {
    totalSnapshots: byStatus.approved + byStatus.rejected + byStatus.pending,
    approvedCount: byStatus.approved,
    rejectedCount: byStatus.rejected,
    pendingCount: byStatus.pending,
    performanceRowCount,
  };
}

export interface SnapshotSummary {
  id: string;
  sourceType: string;
  sourceId: string | null;
  /** 冒頭のみに切り詰めたテキスト（デフォルト 200 文字）。 */
  contentText: string;
  approvalStatus: ApprovalStatus;
  toneTags: string[];
  createdAt: string;
}

export interface ListSnapshotSummariesOptions {
  approvalStatus?: ApprovalStatus;
  limit?: number;
  offset?: number;
  excerptLength?: number;
}

export async function listSnapshotSummaries(
  snapshots: SnapshotStore,
  tenantId: string,
  opts: ListSnapshotSummariesOptions = {},
): Promise<SnapshotSummary[]> {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const excerptLength = opts.excerptLength ?? 200;
  const rows = await snapshots.list(tenantId, {
    approvalStatus: opts.approvalStatus,
    limit,
    offset,
  });
  return rows.map((row) => ({
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    contentText: row.contentText ? row.contentText.slice(0, excerptLength) : "",
    approvalStatus: row.approvalStatus,
    toneTags: row.toneTags,
    createdAt: row.createdAt,
  }));
}

// ─── ingestSnapshots — 既存コンテンツの embedding 化 + 蓄積 ─────────────────

export interface SnapshotSourceItem {
  /** 元コンテンツの id（重複防止キー）。 */
  sourceId: string;
  text: string;
  /** 種別。デフォルト "content"。 */
  sourceType?: string;
  tags?: string[];
}

export interface IngestSnapshotsDeps {
  embed: EmbeddingGenerator;
  snapshots: SnapshotStore;
  /** id 生成の差し替え（テスト用）。デフォルト crypto.randomUUID。 */
  generateId?: () => string;
}

/**
 * 既存コンテンツを embedding 変換してスナップショットとして蓄積する。
 * (tenant, sourceType, sourceId) 単位で重複を防止し、空テキストはスキップ。
 * approval_status は "pending" で投入され、後段の承認 / 却下で学習対象になる。
 */
export async function ingestSnapshots(
  deps: IngestSnapshotsDeps,
  tenantId: string,
  items: SnapshotSourceItem[],
): Promise<{ count: number }> {
  const generateId = deps.generateId ?? (() => crypto.randomUUID());
  let ingestedCount = 0;

  for (const item of items) {
    if (!item.text) continue;
    const sourceType = item.sourceType ?? "content";

    const existing = await deps.snapshots.findBySource(tenantId, sourceType, item.sourceId);
    if (existing) continue;

    const embedding = await deps.embed(item.text);
    const snapshot: PatternSnapshot = {
      id: generateId(),
      tenantId,
      sourceType,
      sourceId: item.sourceId,
      contentText: item.text,
      approvalStatus: "pending",
      rejectionReason: null,
      toneTags: item.tags ?? [],
      createdAt: new Date().toISOString(),
    };
    await deps.snapshots.insert(snapshot, embedding);
    ingestedCount++;
  }

  return { count: ingestedCount };
}
