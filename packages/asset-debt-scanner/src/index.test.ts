import { describe, it, expect, vi } from "vitest";
import {
  // scorer
  computeFreshness,
  daysSince,
  deriveSeverity,
  isKnownAssetType,
  scoreContent,
  scoreLink,
  scoreDebtItem,
  // scanner core
  ScannerRegistry,
  createDefaultScannerRegistry,
  // scanners
  createDeadLinkScanner,
  createImageScanner,
  createSeoQualityScanner,
  analyzeSeoQuality,
  createSeoRankScanner,
  createDormantEmailScanner,
  createCrmBounceScanner,
  createScheduleExpiryScanner,
  probeUrl,
  // suggester
  generateDebtSuggestions,
  FALLBACK_SUGGESTIONS,
  type DebtRecord,
  type GenerateJson,
} from "./index";

const NOW = new Date("2026-05-10T00:00:00.000Z");

// ── scorer (ported from marketing-debt.test.ts) ──
describe("scorer", () => {
  it("isKnownAssetType recognizes the 6 known types", () => {
    for (const t of ["content", "persona", "campaign", "link", "seo_article", "crm_data"]) {
      expect(isKnownAssetType(t)).toBe(true);
    }
    expect(isKnownAssetType("nope")).toBe(false);
    expect(isKnownAssetType(123)).toBe(false);
  });

  it("daysSince handles null/future/past", () => {
    expect(daysSince(null, NOW)).toBe(0);
    const future = new Date(NOW.getTime() + 86_400_000).toISOString();
    expect(daysSince(future, NOW)).toBe(0);
    const tenDaysAgo = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    expect(daysSince(tenDaysAgo, NOW)).toBeCloseTo(10, 5);
  });

  it("deriveSeverity thresholds", () => {
    expect(deriveSeverity(0)).toBe("high");
    expect(deriveSeverity(0.45)).toBe("med");
    expect(deriveSeverity(0.9)).toBe("low");
  });

  it("computeFreshness clamps 0..1", () => {
    expect(computeFreshness(null, 0.01, NOW)).toBe(1);
    const old = new Date(NOW.getTime() - 1000 * 86_400_000).toISOString();
    expect(computeFreshness(old, 0.01, NOW)).toBe(0);
  });

  it("scoreLink marks broken links high severity", () => {
    const res = scoreLink({ tenantId: "t", assetType: "link", assetRef: "u", metadata: { alive: false } }, NOW);
    expect(res.severity).toBe("high");
    expect(res.freshnessScore).toBe(0);
  });

  it("scoreDebtItem dispatches and throws on unknown", () => {
    const r = scoreContent({ tenantId: "t", assetType: "content", assetRef: "u" }, NOW);
    expect(r).toEqual(scoreDebtItem({ tenantId: "t", assetType: "content", assetRef: "u" }, NOW));
    expect(() => scoreDebtItem({ tenantId: "t", assetType: "bogus", assetRef: "u" }, NOW)).toThrow();
  });
});

// ── scanners ──
function collectingStore() {
  const rows: DebtRecord[] = [];
  const store = async (records: DebtRecord[]) => {
    rows.push(...records);
    return records.length;
  };
  return { rows, store };
}

describe("dead-link scanner", () => {
  it("flags 404 and records via injected store", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(null, { status: 404 }),
    ) as unknown as typeof fetch;
    const { rows, store } = collectingStore();
    const scanner = createDeadLinkScanner();
    const summary = await scanner.scan("t1", [{ url: "https://x.test/a" }], { store, fetchImpl });
    expect(summary.dead).toBe(1);
    expect(summary.recorded).toBe(1);
    expect(rows[0]).toMatchObject({ assetType: "link", severity: "high", assetRef: "https://x.test/a" });
  });

  it("probeUrl rejects invalid protocol", async () => {
    const res = await probeUrl("ftp://x", 100, (async () => new Response()) as unknown as typeof fetch);
    expect(res.reason).toBe("invalid_url");
  });

  it("records nothing without a store", async () => {
    const fetchImpl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const s = await createDeadLinkScanner().scan("t1", [{ url: "https://x.test/ok" }], { fetchImpl });
    expect(s.alive).toBe(1);
    expect(s.recorded).toBe(0);
  });
});

describe("image scanner", () => {
  it("flags placeholder-size images", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 200, headers: { "content-length": "10" } })) as unknown as typeof fetch;
    const { store } = collectingStore();
    const s = await createImageScanner().scan("t1", [{ url: "https://x.test/i.png" }], { store, fetchImpl });
    expect(s.defective).toBe(1);
    expect(s.results[0]!.reason).toBe("placeholder");
  });
});

describe("seo-quality scanner", () => {
  it("analyzeSeoQuality detects missing title/meta/h1", () => {
    const issues = analyzeSeoQuality("<html><body><p>no head</p></body></html>");
    const kinds = issues.map((i) => i.kind);
    expect(kinds).toContain("title_missing");
    expect(kinds).toContain("meta_missing");
    expect(kinds).toContain("h1_missing");
  });

  it("rolls up issues to a seo_article record", async () => {
    const { rows, store } = collectingStore();
    const s = await createSeoQualityScanner().scan(
      "t1",
      [{ url: "https://x.test/p", html: "<html></html>" }],
      { store },
    );
    expect(s.withIssues).toBe(1);
    expect(rows[0]).toMatchObject({ assetType: "seo_article", severity: "high" });
  });
});

describe("seo-rank scanner", () => {
  it("flags drops >= 5", async () => {
    const { store } = collectingStore();
    const s = await createSeoRankScanner().scan(
      "t1",
      [
        { keyword: "a", rank_30d_ago: 3, rank_today: 12 },
        { keyword: "b", rank_30d_ago: 5, rank_today: 6 },
      ],
      { store },
    );
    expect(s.drops).toBe(1);
    expect(s.reports[0]!.keyword).toBe("a");
  });
});

describe("dormant-email scanner", () => {
  it("flags campaigns dormant > 90 days", async () => {
    const { store } = collectingStore();
    const old = new Date(NOW.getTime() - 200 * 86_400_000).toISOString();
    const s = await createDormantEmailScanner().scan(
      "t1",
      [
        { id: "c1", last_sent_at: old },
        { id: "c2", last_sent_at: NOW.toISOString() },
      ],
      { store, now: NOW },
    );
    expect(s.dormant).toBe(1);
  });
});

describe("crm-bounce scanner", () => {
  it("flags lists with bounce rate over threshold", async () => {
    const { store } = collectingStore();
    const rows = [
      { status: "delivered", metadata: { list_id: "L1" } },
      { status: "bounced", metadata: { list_id: "L1" } },
      { status: "bounced", metadata: { list_id: "L1" } },
    ];
    const s = await createCrmBounceScanner().scan("t1", rows, { store });
    expect(s.unhealthy).toBe(1);
    expect(s.reports[0]!.severity).toBe("high");
  });
});

describe("schedule-expiry scanner", () => {
  it("flags overdue pending schedules", async () => {
    const { store } = collectingStore();
    const past = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
    const s = await createScheduleExpiryScanner().scan(
      "t1",
      [{ id: "s1", scheduled_for: past, status: "pending", title: "Post" }],
      { store, now: NOW },
    );
    expect(s.expired).toBe(1);
    expect(s.reports[0]!.severity).toBe("med");
  });

  it("ignores non-pending schedules whose time has passed (no wrong-asset flag)", async () => {
    const { rows, store } = collectingStore();
    const past = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
    const s = await createScheduleExpiryScanner().scan(
      "t1",
      [
        { id: "s1", scheduled_for: past, status: "pending", title: "still pending" },
        { id: "s2", scheduled_for: past, status: "completed", title: "already published" },
        { id: "s3", scheduled_for: past, status: "cancelled", title: "cancelled" },
      ],
      { store, now: NOW },
    );
    // Only the still-pending schedule is overdue debt; completed/cancelled are correct.
    expect(s.expired).toBe(1);
    expect(s.reports.map((r) => r.id)).toEqual(["s1"]);
    expect(rows.map((r) => r.assetRef)).toEqual(["s1"]);
  });
});

// ── orchestrator / registry ──
describe("ScannerRegistry", () => {
  it("createDefaultScannerRegistry registers all 7 scanners", () => {
    expect(createDefaultScannerRegistry().list().sort()).toEqual(
      [
        "crm-bounce",
        "dead-link",
        "dormant-email",
        "image",
        "schedule-expiry",
        "seo-quality",
        "seo-rank",
      ].sort(),
    );
  });

  it("runAll isolates a failing scanner and aggregates recorded", async () => {
    const { store } = collectingStore();
    const registry = new ScannerRegistry()
      .register(createSeoRankScanner())
      .register({
        name: "boom",
        async scan() {
          throw new Error("kaboom");
        },
      });
    const result = await registry.runAll(
      "t1",
      { "seo-rank": [{ keyword: "a", rank_30d_ago: 1, rank_today: 20 }] },
      { store },
    );
    expect(result.scanners["seo-rank"]!.ok).toBe(true);
    expect(result.scanners["boom"]!.ok).toBe(false);
    expect(result.scanners["boom"]!.error).toContain("kaboom");
    expect(result.totalRecorded).toBe(1);
  });
});

// ── suggester (ported from marketing-debt-suggester.test.ts) ──
describe("generateDebtSuggestions", () => {
  it("returns 3 suggestions from injected LLM", async () => {
    const generateJson = vi.fn(async () => ({
      suggestions: [
        { title: "Fix A", description: "Do A", estimated_time: "1h", impact: "high" },
        { title: "Fix B", description: "Do B", estimated_time: "30m", impact: "medium" },
        { title: "Fix C", description: "Do C", estimated_time: "10m", impact: "low" },
      ],
    })) as unknown as GenerateJson;
    const result = await generateDebtSuggestions(
      { assetType: "link", assetRef: "https://x/old", severity: "high", recommendation: "404", apiKey: "k" },
      generateJson,
    );
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ title: "Fix A", impact: "high" });
  });

  it("falls back without an API key (LLM not called)", async () => {
    const generateJson = vi.fn() as unknown as GenerateJson;
    const result = await generateDebtSuggestions(
      { assetType: "link", assetRef: "u", severity: "high", recommendation: null },
      generateJson,
    );
    expect(result).toEqual(FALLBACK_SUGGESTIONS);
    expect(generateJson).not.toHaveBeenCalled();
  });
});
