import { describe, expect, it } from "vitest";
import { classifyRisk, DEFAULT_RISK_TIER_CONFIG } from "./riskTier.js";

describe("classifyRisk (3-tier boundaries)", () => {
  it("classifies non-destructive types as low regardless of spend", () => {
    expect(classifyRisk({ type: "draft-save", estimatedSpend: 0 })).toBe("low");
    expect(classifyRisk({ type: "analytics-refresh", estimatedSpend: 999999 })).toBe("low");
  });

  it("classifies budget changes as high even with zero spend", () => {
    expect(classifyRisk({ type: "ad-budget-change", estimatedSpend: 0 })).toBe("high");
  });

  it("classifies spend at the threshold (1000) as high", () => {
    expect(classifyRisk({ type: "publish", estimatedSpend: 1000 })).toBe("high");
  });

  it("classifies spend just below the threshold (999.99) as medium for publish", () => {
    expect(classifyRisk({ type: "publish", estimatedSpend: 999.99 })).toBe("medium");
  });

  it("classifies unknown action types as medium (safe default)", () => {
    expect(classifyRisk({ type: "unknown-thing", estimatedSpend: 0 })).toBe("medium");
  });

  it("classifies unknown types with high spend as high (spend dominates)", () => {
    expect(classifyRisk({ type: "unknown-thing", estimatedSpend: 5000 })).toBe("high");
  });

  it("supports injected config while defaults preserve original behaviour", () => {
    const config = {
      ...DEFAULT_RISK_TIER_CONFIG,
      lowRiskTypes: ["read-only"],
      highSpendThreshold: 10,
    };
    expect(classifyRisk({ type: "read-only", estimatedSpend: 0 }, config)).toBe("low");
    expect(classifyRisk({ type: "publish", estimatedSpend: 10 }, config)).toBe("high");
    // Original default types no longer low under custom config
    expect(classifyRisk({ type: "draft-save", estimatedSpend: 0 }, config)).toBe("medium");
  });
});
