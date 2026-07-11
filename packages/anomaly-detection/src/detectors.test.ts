/**
 * Tests — ported from dev-dashboard-v2 tests/server/lib/anomaly-detection.test.ts.
 * Supabase モックチェーン → fetchRows 注入。`now` を固定して決定的フィクスチャ化。
 */
import { describe, it, expect } from "vitest";
import {
  createMetricSpikeDetector,
  createDeliveryDropDetector,
  createRankDropDetector,
  type CostOutcomeRow,
  type DeliveryRow,
  type RankRow,
  type FetchRows,
} from "./detectors";

// 決定的な固定時刻（UTC 正午）
const FIXED_NOW = new Date("2026-07-10T12:00:00.000Z");
const now = () => new Date(FIXED_NOW);
const TODAY = "2026-07-10";
const YESTERDAY = "2026-07-09";

function rowsOf<Row>(rows: Row[] | null): FetchRows<Row> {
  return async () => rows;
}

function throwing<Row>(): FetchRows<Row> {
  return async () => {
    throw new Error("relation does not exist");
  };
}

describe("createMetricSpikeDetector (cpa_spike math)", () => {
  it("returns null when source table missing (fetchRows → null)", async () => {
    const detect = createMetricSpikeDetector(rowsOf<CostOutcomeRow>(null), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("returns null when no rows", async () => {
    const detect = createMetricSpikeDetector(rowsOf<CostOutcomeRow>([]), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("passes the expected date range to fetchRows", async () => {
    let captured: { start: string; end: string } | null = null;
    const detect = createMetricSpikeDetector(async (_t, range) => {
      captured = range;
      return [];
    }, { now });
    await detect("t1");
    expect(captured).toEqual({ start: "2026-07-03", end: TODAY });
  });

  it("returns null when today data missing", async () => {
    const detect = createMetricSpikeDetector(rowsOf<CostOutcomeRow>([
      { date: YESTERDAY, spend: 100, conversions: 10 },
    ]), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("returns null when baseline conversions are zero", async () => {
    const detect = createMetricSpikeDetector(rowsOf<CostOutcomeRow>([
      { date: TODAY, spend: 100, conversions: 5 },
      { date: YESTERDAY, spend: 100, conversions: 0 },
    ]), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("returns warning when ratio between 1.5x and 2x", async () => {
    const detect = createMetricSpikeDetector(rowsOf<CostOutcomeRow>([
      { date: TODAY, spend: 200, conversions: 10 }, // CPA 20
      { date: YESTERDAY, spend: 100, conversions: 8 }, // baseline CPA 12.5 → ratio 1.6
    ]), { now });
    const result = await detect("t1");
    expect(result?.severity).toBe("warning");
    expect(result?.metricType).toBe("metric_spike");
    expect(result?.observedValue).toBe(20);
    expect(result?.baselineValue).toBe(12.5);
    expect(result?.details).toMatchObject({ ratio: 1.6, baselineDays: 7 });
  });

  it("returns critical when ratio >= 2x", async () => {
    const detect = createMetricSpikeDetector(rowsOf<CostOutcomeRow>([
      { date: TODAY, spend: 300, conversions: 10 }, // CPA 30
      { date: YESTERDAY, spend: 100, conversions: 10 }, // baseline CPA 10 → ratio 3.0
    ]), { now });
    const result = await detect("t1");
    expect(result?.severity).toBe("critical");
  });

  it("handles thrown errors gracefully", async () => {
    const detect = createMetricSpikeDetector(throwing<CostOutcomeRow>(), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("handles null/undefined values via num() helper", async () => {
    const detect = createMetricSpikeDetector(rowsOf<CostOutcomeRow>([
      { date: TODAY, spend: null, conversions: null },
      { date: YESTERDAY, spend: 100, conversions: 10 },
    ]), { now });
    expect(await detect("t1")).toBeNull(); // todayConv = 0 → null
  });

  it("supports custom metricType rename", async () => {
    const detect = createMetricSpikeDetector(rowsOf<CostOutcomeRow>([
      { date: TODAY, spend: 300, conversions: 10 },
      { date: YESTERDAY, spend: 100, conversions: 10 },
    ]), { now, metricType: "cpa_spike" });
    const result = await detect("t1");
    expect(result?.metricType).toBe("cpa_spike");
  });
});

describe("createDeliveryDropDetector (email_delivery_drop math)", () => {
  const todayIso = (hours = 11): string => `2026-07-10T${String(hours).padStart(2, "0")}:00:00.000Z`;
  const yesterdayIso = (hours = 12): string => `2026-07-09T${String(hours).padStart(2, "0")}:00:00.000Z`;

  function makeRow(sentAt: string, status: string): DeliveryRow {
    return { sent_at: sentAt, status };
  }

  it("returns null when source missing (fetchRows → null)", async () => {
    const detect = createDeliveryDropDetector(rowsOf<DeliveryRow>(null), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("returns null when fetchRows throws", async () => {
    const detect = createDeliveryDropDetector(throwing<DeliveryRow>(), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("returns null when no rows", async () => {
    const detect = createDeliveryDropDetector(rowsOf<DeliveryRow>([]), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("returns null when today volume below noise floor (10)", async () => {
    const rows = [
      ...Array.from({ length: 5 }, () => makeRow(todayIso(), "delivered")),
      ...Array.from({ length: 100 }, () => makeRow(yesterdayIso(), "delivered")),
    ];
    const detect = createDeliveryDropDetector(rowsOf(rows), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("returns null when baseline failure rate is zero", async () => {
    const rows = [
      ...Array.from({ length: 50 }, () => makeRow(todayIso(), "bounced")),
      ...Array.from({ length: 100 }, () => makeRow(yesterdayIso(), "delivered")),
    ];
    const detect = createDeliveryDropDetector(rowsOf(rows), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("returns warning when failure rate ratio between 1.5x and 2x", async () => {
    // baseline = 10% bounce (10/100). today = 16% (16/100) → ratio 1.6
    const rows = [
      ...Array.from({ length: 84 }, () => makeRow(todayIso(), "delivered")),
      ...Array.from({ length: 16 }, () => makeRow(todayIso(), "bounced")),
      ...Array.from({ length: 90 }, () => makeRow(yesterdayIso(), "delivered")),
      ...Array.from({ length: 10 }, () => makeRow(yesterdayIso(), "bounced")),
    ];
    const detect = createDeliveryDropDetector(rowsOf(rows), { now });
    const result = await detect("t1");
    expect(result?.severity).toBe("warning");
    expect(result?.metricType).toBe("delivery_drop");
    expect(result?.observedValue).toBe(0.16);
    expect(result?.baselineValue).toBe(0.1);
    expect(result?.details).toMatchObject({ ratio: 1.6, todayVolume: 100, todayFailures: 16 });
  });

  it("returns critical when failure rate ratio >= 2x", async () => {
    // baseline = 5%. today = 25% → ratio 5.0
    const rows = [
      ...Array.from({ length: 75 }, () => makeRow(todayIso(), "delivered")),
      ...Array.from({ length: 25 }, () => makeRow(todayIso(), "bounced")),
      ...Array.from({ length: 95 }, () => makeRow(yesterdayIso(), "delivered")),
      ...Array.from({ length: 5 }, () => makeRow(yesterdayIso(), "dropped")),
    ];
    const detect = createDeliveryDropDetector(rowsOf(rows), { now });
    const result = await detect("t1");
    expect(result?.severity).toBe("critical");
  });
});

describe("createRankDropDetector (seo_rank_drop math)", () => {
  const today = (h = 11): string => `2026-07-10T${String(h).padStart(2, "0")}:00:00.000Z`;
  const yesterday = (h = 12): string => `2026-07-09T${String(h).padStart(2, "0")}:00:00.000Z`;

  it("returns null when source missing (fetchRows → null)", async () => {
    const detect = createRankDropDetector(rowsOf<RankRow>(null), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("returns null when no rows", async () => {
    const detect = createRankDropDetector(rowsOf<RankRow>([]), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("returns null when no keyword has both today and baseline data", async () => {
    const detect = createRankDropDetector(rowsOf<RankRow>([
      { keyword: "kw-a", rank: 5, captured_at: today() },
      { keyword: "kw-b", rank: 10, captured_at: yesterday() },
    ]), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("returns null when no keyword drops by 5+ positions", async () => {
    const detect = createRankDropDetector(rowsOf<RankRow>([
      { keyword: "kw-a", rank: 5, captured_at: today() },
      { keyword: "kw-a", rank: 4, captured_at: yesterday() },
    ]), { now });
    expect(await detect("t1")).toBeNull();
  });

  it("returns warning when keyword drops 5-9 positions", async () => {
    const detect = createRankDropDetector(rowsOf<RankRow>([
      { keyword: "kw-a", rank: 12, captured_at: today() }, // today rank 12
      { keyword: "kw-a", rank: 5, captured_at: yesterday() }, // baseline rank 5 → delta +7
    ]), { now });
    const result = await detect("t1");
    expect(result?.severity).toBe("warning");
    expect(result?.observedValue).toBe(7);
    expect(result?.metricType).toBe("rank_drop");
  });

  it("returns critical when keyword drops 10+ positions", async () => {
    const detect = createRankDropDetector(rowsOf<RankRow>([
      { keyword: "kw-a", rank: 18, captured_at: today() },
      { keyword: "kw-a", rank: 5, captured_at: yesterday() }, // delta +13
    ]), { now });
    const result = await detect("t1");
    expect(result?.severity).toBe("critical");
  });

  it("ranks dropped keywords worst-first in details (top 5)", async () => {
    const detect = createRankDropDetector(rowsOf<RankRow>([
      { keyword: "kw-a", rank: 11, captured_at: today() }, { keyword: "kw-a", rank: 5, captured_at: yesterday() }, // +6
      { keyword: "kw-b", rank: 20, captured_at: today() }, { keyword: "kw-b", rank: 5, captured_at: yesterday() }, // +15
      { keyword: "kw-c", rank: 12, captured_at: today() }, { keyword: "kw-c", rank: 5, captured_at: yesterday() }, // +7
    ]), { now });
    const result = await detect("t1");
    const dropped = (result?.details?.droppedKeywords as Array<{ keyword: string; delta: number }>) ?? [];
    expect(dropped[0]?.keyword).toBe("kw-b");
    expect(dropped[0]?.delta).toBe(15);
    expect(dropped.length).toBe(3);
  });
});
