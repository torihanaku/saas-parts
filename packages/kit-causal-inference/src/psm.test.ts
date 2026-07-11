/**
 * Ported from dev-dashboard-v2 `tests/server/lib/causal/psm-service.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { runPsm } from "./psm.js";

describe("PSM Service", () => {
  it("should return null and warning if sample size is < 30", async () => {
    const res = await runPsm({
      tenantId: "tenant",
      experimentId: "exp",
      treatmentGroup: Array(10).fill({ entityId: "e", covariates: [1, 2], outcome: 5 }),
      poolGroup: Array(100).fill({ entityId: "e", covariates: [1, 2], outcome: 5 }),
    });

    expect(res.effectSize).toBeNull();
    expect(res.warnings).toContain("insufficient_pool_size");
  });

  it("should match controls and compute ATT", async () => {
    // Generate synthetic data with n=30
    const treat = Array(30).fill(null).map((_, i) => ({ entityId: `t${i}`, covariates: [i, 2], outcome: 10 + (i % 5) }));
    // Pool has exact matches plus some noise
    const pool = Array(60).fill(null).map((_, i) => ({ entityId: `c${i}`, covariates: [i % 30, 2], outcome: 5 + (i % 3) }));

    const res = await runPsm({
      tenantId: "tenant",
      experimentId: "exp",
      treatmentGroup: treat,
      poolGroup: pool,
    });

    expect(res.effectSize).toBeDefined();
    if (res.effectSize !== null) {
      expect(res.effectSize).toBeGreaterThan(0);
      expect(res.ciLower).toBeLessThan(res.effectSize!);
      expect(res.ciUpper).toBeGreaterThan(res.effectSize!);
    }
  });
});
