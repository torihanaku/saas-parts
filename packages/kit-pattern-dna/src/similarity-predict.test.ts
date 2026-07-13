/**
 * 出典テスト: 実運用SaaS tests/brand-dna-prediction-claude.test.ts /
 * tests/server/lib/brand-dna/*.test.ts のコアシナリオを、注入インターフェース
 * （EmbeddingSearcher / SnapshotStore / PerformanceStore / LlmCaller）向けに再構成。
 */
import { describe, it, expect, vi } from "vitest";
import {
  getSnapshotStats,
  ingestSnapshots,
  listSnapshotSummaries,
  predictBySimilarity,
  recommendBySimilarity,
} from "./similarity-predict.js";
import {
  InMemoryPerformanceStore,
  InMemorySnapshotStore,
  type PatternSnapshot,
} from "./stores.js";
import type { EmbeddingNeighbor, EmbeddingSearcher, LlmCaller } from "./types.js";

const TENANT = "tenant-1";

function searcherReturning(byStatus: {
  approved?: EmbeddingNeighbor[];
  rejected?: EmbeddingNeighbor[];
}): EmbeddingSearcher {
  return {
    async search(_text, opts) {
      return (byStatus[opts.status] ?? []).slice(0, opts.topK);
    },
  };
}

function snapshot(overrides: Partial<PatternSnapshot> = {}): PatternSnapshot {
  return {
    id: "s1",
    tenantId: TENANT,
    sourceType: "content",
    sourceId: null,
    contentText: "テキスト",
    approvalStatus: "approved",
    rejectionReason: null,
    toneTags: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("predictBySimilarity", () => {
  it("returns insufficient_data when there are no neighbors", async () => {
    const out = await predictBySimilarity(
      { searcher: searcherReturning({}), performance: new InMemoryPerformanceStore() },
      { tenantId: TENANT, contentText: "x", channel: "blog" },
    );
    expect(out.predicted).toEqual({ pv: null, cv: null, engagementScore: null });
    expect(out.reason).toBe("insufficient_data_no_neighbors");
    expect(out.neighbors).toEqual([]);
  });

  it("returns neighbors with zeroed perf when the channel has no performance rows", async () => {
    const searcher = searcherReturning({ approved: [{ id: "s1", similarity: 0.9 }] });
    const out = await predictBySimilarity(
      { searcher, performance: new InMemoryPerformanceStore() },
      { tenantId: TENANT, contentText: "x", channel: "blog" },
    );
    expect(out.reason).toBe("insufficient_data_no_performance_for_channel");
    expect(out.neighbors).toEqual([
      { snapshotId: "s1", similarity: 0.9, pv: 0, cv: 0, engagementScore: null },
    ]);
  });

  it("averages neighbor performance and buckets confidence by sample count", async () => {
    const perf = new InMemoryPerformanceStore();
    perf.add(TENANT, { snapshotId: "s1", channel: "blog", pv: 100, cv: 10, engagementScore: 50 });
    perf.add(TENANT, { snapshotId: "s2", channel: "blog", pv: 300, cv: 30, engagementScore: 70 });
    // 他チャネルは無視される
    perf.add(TENANT, { snapshotId: "s1", channel: "email", pv: 9999, cv: 999, engagementScore: 1 });

    const searcher = searcherReturning({
      approved: [
        { id: "s1", similarity: 0.9 },
        { id: "s2", similarity: 0.8 },
      ],
    });
    const out = await predictBySimilarity(
      { searcher, performance: perf },
      { tenantId: TENANT, contentText: "x", channel: "blog" },
    );
    expect(out.predicted.pv).toBe(200);
    expect(out.predicted.cv).toBe(20);
    expect(out.predicted.engagementScore).toBe(60);
    expect(out.confidence).toBe("low"); // 2 サンプル
    expect(out.reason).toBe("based_on_2_neighbors");
    expect(out.neighbors[0]).toEqual({
      snapshotId: "s1", similarity: 0.9, pv: 100, cv: 10, engagementScore: 50,
    });
  });

  it("applies the LLM correction multiplier only with ≥3 samples, clamped to [0.5, 1.5]", async () => {
    const perf = new InMemoryPerformanceStore();
    for (const id of ["s1", "s2", "s3"]) {
      perf.add(TENANT, { snapshotId: id, channel: "blog", pv: 100, cv: 10, engagementScore: 50 });
    }
    const searcher = searcherReturning({
      approved: [
        { id: "s1", similarity: 0.9 },
        { id: "s2", similarity: 0.85 },
        { id: "s3", similarity: 0.8 },
      ],
    });
    const llm: LlmCaller = {
      async generateJson<T>(): Promise<T> {
        return { multiplier: 99, reason: "hype" } as unknown as T; // → 1.5 にクランプ
      },
    };
    const out = await predictBySimilarity(
      { searcher, performance: perf, llm },
      { tenantId: TENANT, contentText: "x", channel: "blog" },
    );
    expect(out.predicted.pv).toBe(150);
    expect(out.confidence).toBe("medium");

    // 2 サンプルでは LLM を呼ばない
    const spy = vi.fn();
    const llmSpy: LlmCaller = { generateJson: spy };
    const perf2 = new InMemoryPerformanceStore();
    perf2.add(TENANT, { snapshotId: "s1", channel: "blog", pv: 100, cv: 10, engagementScore: 50 });
    perf2.add(TENANT, { snapshotId: "s2", channel: "blog", pv: 100, cv: 10, engagementScore: 50 });
    await predictBySimilarity(
      { searcher, performance: perf2, llm: llmSpy },
      { tenantId: TENANT, contentText: "x", channel: "blog" },
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("recommendBySimilarity", () => {
  it("returns insufficient_data when both corpora are empty", async () => {
    const out = await recommendBySimilarity(
      { searcher: searcherReturning({}), performance: new InMemoryPerformanceStore() },
      { tenantId: TENANT, contentText: "x" },
    );
    expect(out.bestChannel).toBeNull();
    expect(out.failureWarning).toBeNull();
    expect(out.successRecommendation).toBeNull();
    expect(out.reason).toBe("insufficient_data");
  });

  it("picks the best channel by mean engagement and the top-performance success rec", async () => {
    const perf = new InMemoryPerformanceStore();
    perf.add(TENANT, { snapshotId: "s1", channel: "blog", pv: 100, cv: 10, engagementScore: 40 });
    perf.add(TENANT, { snapshotId: "s2", channel: "email", pv: 50, cv: 20, engagementScore: 80 });
    perf.add(TENANT, { snapshotId: "s2", channel: "blog", pv: 10, cv: 1, engagementScore: null });

    const searcher = searcherReturning({
      approved: [
        { id: "s1", similarity: 0.9 },
        { id: "s2", similarity: 0.7 },
      ],
    });
    const out = await recommendBySimilarity(
      { searcher, performance: perf },
      { tenantId: TENANT, contentText: "x" },
    );
    expect(out.bestChannel).toEqual({ channel: "email", avgEngagement: 80, sampleSize: 1 });
    expect(out.successRecommendation).toEqual({
      snapshotId: "s2",
      similarity: 0.7,
      topPerformance: { channel: "email", pv: 50, cv: 20 },
    });
    expect(out.reason).toBe("matches_found");
  });

  it("surfaces a failure warning from the rejected corpus", async () => {
    const searcher = searcherReturning({
      rejected: [{ id: "bad-1", similarity: 0.91, rejectionReason: "トーン不一致" }],
    });
    const out = await recommendBySimilarity(
      { searcher, performance: new InMemoryPerformanceStore() },
      { tenantId: TENANT, contentText: "x" },
    );
    expect(out.failureWarning).toEqual({
      similarRejectedSnapshotId: "bad-1",
      similarity: 0.91,
      rejectionReason: "トーン不一致",
    });
    expect(out.reason).toBe("matches_found");
  });

  it("restricts performance lookup to candidate channels", async () => {
    const perf = new InMemoryPerformanceStore();
    perf.add(TENANT, { snapshotId: "s1", channel: "email", pv: 50, cv: 20, engagementScore: 80 });
    const searcher = searcherReturning({ approved: [{ id: "s1", similarity: 0.9 }] });
    const out = await recommendBySimilarity(
      { searcher, performance: perf },
      { tenantId: TENANT, contentText: "x", candidateChannels: ["blog"] },
    );
    expect(out.bestChannel).toBeNull();
  });
});

describe("getSnapshotStats / listSnapshotSummaries", () => {
  it("aggregates snapshot counts by status and performance rows", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.insert(snapshot({ id: "a", approvalStatus: "approved" }));
    await snapshots.insert(snapshot({ id: "b", approvalStatus: "rejected" }));
    await snapshots.insert(snapshot({ id: "c", approvalStatus: "pending" }));
    await snapshots.insert(snapshot({ id: "d", approvalStatus: "approved", tenantId: "other" }));
    const perf = new InMemoryPerformanceStore();
    perf.add(TENANT, { snapshotId: "a", channel: "blog", pv: 1, cv: 0, engagementScore: null });

    const stats = await getSnapshotStats(snapshots, perf, TENANT);
    expect(stats).toEqual({
      totalSnapshots: 3,
      approvedCount: 1,
      rejectedCount: 1,
      pendingCount: 1,
      performanceRowCount: 1,
    });
  });

  it("lists summaries with excerpted text and status filter", async () => {
    const snapshots = new InMemorySnapshotStore();
    await snapshots.insert(
      snapshot({ id: "a", contentText: "x".repeat(500), approvalStatus: "approved" }),
    );
    await snapshots.insert(snapshot({ id: "b", approvalStatus: "pending" }));

    const all = await listSnapshotSummaries(snapshots, TENANT);
    expect(all.length).toBe(2);
    const approved = await listSnapshotSummaries(snapshots, TENANT, {
      approvalStatus: "approved",
      excerptLength: 10,
    });
    expect(approved.length).toBe(1);
    expect(approved[0]?.contentText.length).toBe(10);
  });
});

describe("ingestSnapshots", () => {
  it("embeds and stores items, skipping empty text and duplicates", async () => {
    const snapshots = new InMemorySnapshotStore();
    const embed = vi.fn(async (text: string) => [text.length, 0, 1]);
    let seq = 0;
    const deps = { embed, snapshots, generateId: () => `id-${++seq}` };

    const first = await ingestSnapshots(deps, TENANT, [
      { sourceId: "c1", text: "本文A", tags: ["t"] },
      { sourceId: "c2", text: "" }, // skip
      { sourceId: "c3", text: "本文C" },
    ]);
    expect(first.count).toBe(2);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(snapshots.embeddings.get("id-1")).toEqual([3, 0, 1]);

    // 同じ sourceId は再取り込みされない
    const second = await ingestSnapshots(deps, TENANT, [
      { sourceId: "c1", text: "本文A更新" },
      { sourceId: "c4", text: "本文D" },
    ]);
    expect(second.count).toBe(1);

    const stored = await snapshots.findBySource(TENANT, "content", "c1");
    expect(stored?.approvalStatus).toBe("pending");
    expect(stored?.toneTags).toEqual(["t"]);
  });
});
