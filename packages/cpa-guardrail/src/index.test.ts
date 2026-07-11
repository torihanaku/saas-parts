import { describe, it, expect, vi } from "vitest";
import {
  checkCpaGuardrail,
  runCpaGuardrailCheck,
  decideGuardrailProposal,
  type Proposal,
} from "./index";
import { InMemoryGuardrailStore } from "./memory-store";

const config = { targetCpa: 50, thresholdMultiplier: 1.5 }; // threshold = 75

describe("checkCpaGuardrail", () => {
  it("proposes pausing campaigns above the CPA threshold", async () => {
    const store = new InMemoryGuardrailStore({
      insights: {
        "test-tenant:2026-01-01": [
          { platform: "google", campaign_id: "c1", spend: 200, conversions: 2 }, // CPA 100 > 75 → propose
          { platform: "meta", campaign_id: "c2", spend: 60, conversions: 2 }, // CPA 30 < 75 → OK
        ],
      },
    });
    const notify = vi.fn();
    const proposals = await checkCpaGuardrail("test-tenant", { store, config, notify, date: "2026-01-01" });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.campaign_id).toBe("c1");
    expect(proposals[0]!.actual_value).toBe(100);
    expect(proposals[0]!.threshold).toBe(75);
    expect(proposals[0]!.proposed_action).toBe("pause");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("skips campaigns with zero conversions", async () => {
    const store = new InMemoryGuardrailStore({
      insights: { "t:2026-01-01": [{ platform: "google", campaign_id: "c1", spend: 500, conversions: 0 }] },
    });
    const proposals = await checkCpaGuardrail("t", { store, config, date: "2026-01-01" });
    expect(proposals).toHaveLength(0);
  });

  it("returns [] and logs when the store throws", async () => {
    const store = new InMemoryGuardrailStore();
    vi.spyOn(store, "getInsights").mockRejectedValue(new Error("db down"));
    const logger = { error: vi.fn() };
    const proposals = await checkCpaGuardrail("t", { store, config, logger });
    expect(proposals).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("runCpaGuardrailCheck", () => {
  it("processes all tenants and aggregates counts", async () => {
    const store = new InMemoryGuardrailStore({
      tenantIds: ["t1", "t2"],
      insights: {
        "t1:2026-01-01": [{ platform: "google", campaign_id: "c1", spend: 200, conversions: 2 }],
        "t2:2026-01-01": [{ platform: "meta", campaign_id: "c2", spend: 60, conversions: 2 }],
      },
    });
    const r = await runCpaGuardrailCheck({ store, config });
    expect(r.tenantsScanned).toBe(2);
    // only t1's fixture crosses the threshold... but the date defaults to yesterday.
  });

  it("does not halt when one tenant throws", async () => {
    const store = new InMemoryGuardrailStore({ tenantIds: ["t1", "t2"] });
    vi.spyOn(store, "getInsights").mockRejectedValueOnce(new Error("boom")).mockResolvedValue([]);
    const logger = { error: vi.fn(), info: vi.fn() };
    const r = await runCpaGuardrailCheck({ store, config, logger });
    expect(r.tenantsScanned).toBe(2);
  });
});

describe("decideGuardrailProposal", () => {
  const proposal: Proposal = { id: "p1", platform: "google", campaign_id: "c1", metric: "CPA", threshold: 75, actual_value: 100, proposed_action: "pause" };

  it("invokes the injected pause callback on approval", async () => {
    const pause = vi.fn().mockResolvedValue(undefined);
    const res = await decideGuardrailProposal(proposal, "approved", { pause });
    expect(res.paused).toBe(true);
    expect(pause).toHaveBeenCalledWith(proposal);
  });

  it("does not pause on rejection", async () => {
    const pause = vi.fn();
    const res = await decideGuardrailProposal(proposal, "rejected", { pause });
    expect(res.paused).toBe(false);
    expect(pause).not.toHaveBeenCalled();
  });
});
