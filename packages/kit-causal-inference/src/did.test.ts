/**
 * Ported from 実運用SaaS `tests/server/lib/causal/did-service.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { runDid } from "./did.js";

describe("DID Service", () => {
  it("should return null and warning if sample size is < 30", async () => {
    const res = await runDid({
      tenantId: "tenant",
      experimentId: "exp",
      treatmentGroup: Array(10).fill({ entityId: "e", preOutcome: 10, postOutcome: 15 }),
      controlGroup: Array(35).fill({ entityId: "e", preOutcome: 10, postOutcome: 10 }),
    });

    expect(res.effectSize).toBeNull();
    expect(res.warnings).toContain("sample_size_small");
    expect(res.sampleSize.treatment).toBe(10);
    expect(res.assumptions.find(a => a.name === "sample_size_min_30")?.satisfied).toBe(false);
  });

  it("should compute effect size and p-value correctly for sample size >= 30", async () => {
    const treat = Array(30).fill(null).map((_, i) => ({ entityId: `t${i}`, preOutcome: 10, postOutcome: 20 + (i % 5) })); // mean diff = 12
    const control = Array(30).fill(null).map((_, i) => ({ entityId: `c${i}`, preOutcome: 10, postOutcome: 10 + (i % 5) })); // mean diff = 2

    const res = await runDid({
      tenantId: "tenant",
      experimentId: "exp",
      treatmentGroup: treat,
      controlGroup: control,
    });

    expect(res.effectSize).toBeCloseTo(10, 1); // (22 - 10) - (12 - 10) = 12 - 2 = 10
    expect(res.stdError).toBeGreaterThan(0);
    expect(res.pValue).toBeLessThan(0.05);
    expect(res.ciLower).toBeLessThan(res.effectSize!);
    expect(res.ciUpper).toBeGreaterThan(res.effectSize!);
    expect(res.assumptions.find(a => a.name === "sample_size_min_30")?.satisfied).toBe(true);
  });
});
