/**
 * Ported from dev-dashboard-v2 `tests/marketing-roi/attribution-models.test.ts`
 * plus additional golden tests (fixed journeys → exact expected credits).
 */
import { describe, expect, it } from "vitest";
import {
  baseAttributionRows,
  buildConversionPaths,
  type Touchpoint,
} from "./attribution";
import { calculateShapleyAttribution } from "./shapley";
import { calculateMarkovAttribution } from "./markov";

function touch(userHash: string, channel: string, minute: number, campaignId = channel): Touchpoint {
  return {
    userHash,
    channel,
    campaignId,
    touchedAt: new Date(Date.UTC(2026, 4, 1, 0, minute)).toISOString(),
    valueJpy: 0,
    metadata: {},
  };
}

function conversion(userHash: string, minute: number): Touchpoint {
  return {
    userHash,
    channel: "conversion",
    campaignId: null,
    touchedAt: new Date(Date.UTC(2026, 4, 1, 0, minute)).toISOString(),
    valueJpy: 10_000,
    metadata: { event_type: "conversion" },
  };
}

describe("buildConversionPaths", () => {
  it("groups by user, sorts by time, and flags conversions with value", () => {
    const paths = buildConversionPaths([
      touch("u1", "google", 5, "g1"),
      touch("u1", "meta", 0, "m1"),
      conversion("u1", 10),
      touch("u2", "email", 0, "e1"),
    ]);

    expect(paths).toHaveLength(2);
    const u1 = paths.find((p) => p.userHash === "u1")!;
    expect(u1.converted).toBe(true);
    expect(u1.valueJpy).toBe(10_000);
    expect(u1.touchpoints.map((t) => t.channel)).toEqual(["meta", "google", "conversion"]);
    const u2 = paths.find((p) => p.userHash === "u2")!;
    expect(u2.converted).toBe(false);
    expect(u2.valueJpy).toBe(0);
  });

  it("ignores touchpoints without a userHash", () => {
    const paths = buildConversionPaths([touch("", "meta", 0)]);
    expect(paths).toHaveLength(0);
  });
});

describe("ROI attribution models", () => {
  it("Shapley gives equal credit for a simple 3-touchpoint conversion path", () => {
    const paths = buildConversionPaths([
      touch("u1", "meta", 0, "m1"),
      touch("u1", "google", 1, "g1"),
      touch("u1", "email", 2, "e1"),
      conversion("u1", 3),
    ]);

    const credits = calculateShapleyAttribution(paths);

    expect(credits.get("meta::m1")).toBeCloseTo(1 / 3);
    expect(credits.get("google::g1")).toBeCloseTo(1 / 3);
    expect(credits.get("email::e1")).toBeCloseTo(1 / 3);
  });

  it("Markov removal effect gives credit only to channels on converting paths in a known case", () => {
    const paths = buildConversionPaths([
      touch("u1", "email", 0, "e1"),
      conversion("u1", 1),
      touch("u2", "sns", 0, "s1"),
    ]);

    const credits = calculateMarkovAttribution(paths);

    expect(credits.get("email::e1")).toBeCloseTo(1);
    expect(credits.get("sns::s1") ?? 0).toBe(0);
  });
});

describe("golden fixtures", () => {
  it("Shapley accumulates credit across multiple converting paths", () => {
    // u1: A + B → conversion (0.5 each), u2: A → conversion (1.0 to A).
    const paths = buildConversionPaths([
      touch("u1", "A", 0),
      touch("u1", "B", 1),
      conversion("u1", 2),
      touch("u2", "A", 0),
      conversion("u2", 1),
    ]);

    const credits = calculateShapleyAttribution(paths);

    expect(credits.get("A::A")).toBeCloseTo(1.5, 10);
    expect(credits.get("B::B")).toBeCloseTo(0.5, 10);
  });

  it("Markov removal effect: known 3-user fixture yields exact credits", () => {
    // u1: A → conv, u2: B → (no conversion), u3: A → B → conv.
    // Baseline P(conv) = 2/3. Removing A drops it to 1/3 (effect 1/3);
    // removing B leaves it at 2/3 (effect 0). Total conversions = 2,
    // so A receives all the credit (2) and B receives 0.
    const paths = buildConversionPaths([
      touch("u1", "A", 0),
      conversion("u1", 1),
      touch("u2", "B", 0),
      touch("u3", "A", 0),
      touch("u3", "B", 1),
      conversion("u3", 2),
    ]);

    const credits = calculateMarkovAttribution(paths);

    expect(credits.get("A::A")).toBeCloseTo(2, 10);
    expect(credits.get("B::B")).toBeCloseTo(0, 10);
  });

  it("Markov returns an empty map when no removal has any effect", () => {
    // Single non-converting path: baseline probability is already 0.
    const paths = buildConversionPaths([touch("u1", "A", 0)]);
    expect(calculateMarkovAttribution(paths).size).toBe(0);
  });

  it("baseAttributionRows: first-touch / last-click / linear on a 3-touch path", () => {
    const paths = buildConversionPaths([
      touch("u1", "meta", 0, "m1"),
      touch("u1", "google", 1, "g1"),
      touch("u1", "email", 2, "e1"),
      conversion("u1", 3),
    ]);

    const rows = baseAttributionRows(paths);
    const byKey = new Map(rows.map((r) => [`${r.platform}::${r.campaignId}`, r]));

    expect(byKey.get("meta::m1")!.conversionsFirstTouch).toBe(1);
    expect(byKey.get("meta::m1")!.conversionsLastClick).toBe(0);
    expect(byKey.get("email::e1")!.conversionsLastClick).toBe(1);
    for (const key of ["meta::m1", "google::g1", "email::e1"]) {
      expect(byKey.get(key)!.conversionsLinear).toBeCloseTo(1 / 3, 10);
    }
  });
});
