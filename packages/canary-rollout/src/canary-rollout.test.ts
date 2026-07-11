import { describe, it, expect } from "vitest";
import { isTenantInRollout } from "./index";

describe("CanaryRollout", () => {
  it("should allow if percentage is 100", () => {
    expect(isTenantInRollout("t1", { percentage: 100 })).toBe(true);
  });

  it("should deny if percentage is 0", () => {
    expect(isTenantInRollout("t1", { percentage: 0 })).toBe(false);
  });

  it("should allow if tenant is in canary list", () => {
    expect(
      isTenantInRollout("t-special", { percentage: 0, canaryTenantIds: ["t-special"] })
    ).toBe(true);
  });

  it("should be deterministic for partial rollout", () => {
    const config = { percentage: 50 };
    const id = "some-tenant-id";
    const result1 = isTenantInRollout(id, config);
    const result2 = isTenantInRollout(id, config);
    expect(result1).toBe(result2);
  });

  it("canary list wins even at 0% but not against explicit membership rules", () => {
    expect(isTenantInRollout("not-listed", { percentage: 0, canaryTenantIds: ["other"] })).toBe(
      false
    );
  });

  it("monotonic: a tenant included at N% stays included at any higher percentage", () => {
    const id = "tenant-monotonic-check";
    let firstIncludedAt: number | null = null;
    for (let p = 1; p <= 100; p++) {
      const included = isTenantInRollout(id, { percentage: p });
      if (included && firstIncludedAt === null) firstIncludedAt = p;
      if (firstIncludedAt !== null) {
        expect(included).toBe(true);
      }
    }
    expect(firstIncludedAt).not.toBeNull();
  });

  it("roughly splits a population at 50% (deterministic hash spread)", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `tenant-${i}-${i * 7919}`);
    const included = ids.filter((id) => isTenantInRollout(id, { percentage: 50 })).length;
    // Loose bounds — the hash isn't cryptographic, just needs a sane spread.
    expect(included).toBeGreaterThan(300);
    expect(included).toBeLessThan(700);
  });
});
