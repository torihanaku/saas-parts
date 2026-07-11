import { describe, expect, it } from "vitest";
import { buildWeeklyBrief } from "./brief-service";
import { MemoryContextStore, MemorySignalStore } from "./memory-stores";
import type { Verdict } from "./types";

const USER = "user-1";
const NOW = new Date("2026-07-10T00:00:00.000Z");

async function seed(
  signalStore: MemorySignalStore,
  contextStore: MemoryContextStore,
  entries: Array<{
    title: string;
    source: string;
    fetchedAt: string;
    verdict?: Verdict;
    score?: number;
  }>,
) {
  let i = 0;
  for (const e of entries) {
    const s = await signalStore.insert(USER, {
      source: e.source,
      url: `https://example.com/${i++}`,
      title: e.title,
      fetchedAt: e.fetchedAt,
    });
    if (e.verdict) {
      await contextStore.insert(USER, {
        signalId: s!.id,
        relatedSignalIds: [],
        importanceScore: e.score ?? 50,
        verdict: e.verdict,
        rationale: `r-${e.title}`,
      });
    }
  }
}

describe("buildWeeklyBrief", () => {
  it("verdict 別集計・source 内訳・上位シグナルを返す", async () => {
    const signalStore = new MemorySignalStore();
    const contextStore = new MemoryContextStore();
    await seed(signalStore, contextStore, [
      { title: "A", source: "hn", fetchedAt: "2026-07-09T00:00:00.000Z", verdict: "big_deal", score: 90 },
      { title: "B", source: "hn", fetchedAt: "2026-07-08T00:00:00.000Z", verdict: "worth_watching", score: 70 },
      { title: "C", source: "news", fetchedAt: "2026-07-07T00:00:00.000Z", verdict: "meh", score: 10 },
      { title: "D (no context)", source: "news", fetchedAt: "2026-07-06T00:00:00.000Z" },
    ]);

    const brief = await buildWeeklyBrief(
      USER,
      { signalStore, contextStore, now: () => NOW },
    );

    expect(brief.totals).toEqual({
      big_deal: 1,
      worth_watching: 1,
      meh: 1,
      uncategorized: 1,
    });
    expect(brief.bySource).toEqual([
      { source: "hn", count: 2 },
      { source: "news", count: 2 },
    ]);
    // verdict 優先度順: big_deal → worth_watching → meh
    expect(brief.topSignals.map((s) => s.title)).toEqual(["A", "B", "C"]);
  });

  it("同 verdict 内は importance 降順、上限 topLimit で切る", async () => {
    const signalStore = new MemorySignalStore();
    const contextStore = new MemoryContextStore();
    await seed(signalStore, contextStore, [
      { title: "low", source: "hn", fetchedAt: "2026-07-09T00:00:00.000Z", verdict: "big_deal", score: 10 },
      { title: "high", source: "hn", fetchedAt: "2026-07-08T00:00:00.000Z", verdict: "big_deal", score: 95 },
      { title: "mid", source: "hn", fetchedAt: "2026-07-07T00:00:00.000Z", verdict: "big_deal", score: 50 },
    ]);

    const brief = await buildWeeklyBrief(
      USER,
      { signalStore, contextStore, now: () => NOW },
      { topLimit: 2 },
    );
    expect(brief.topSignals.map((s) => s.title)).toEqual(["high", "mid"]);
  });

  it("観測窓の外のシグナルは含めない", async () => {
    const signalStore = new MemorySignalStore();
    const contextStore = new MemoryContextStore();
    await seed(signalStore, contextStore, [
      { title: "recent", source: "hn", fetchedAt: "2026-07-09T00:00:00.000Z", verdict: "big_deal" },
      { title: "old", source: "hn", fetchedAt: "2026-06-01T00:00:00.000Z", verdict: "big_deal" },
    ]);

    const brief = await buildWeeklyBrief(
      USER,
      { signalStore, contextStore, now: () => NOW },
    );
    expect(brief.topSignals.map((s) => s.title)).toEqual(["recent"]);
    expect(brief.totals.big_deal).toBe(1);
  });
});
