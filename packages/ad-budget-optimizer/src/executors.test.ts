import { describe, it, expect, vi } from "vitest";
import { applyBudgetChange, isDryRunEnabled } from "./adapters/nango-executor";
import {
  applyBidChange,
  isBidDryRunEnabled,
  BID_FLOOR_JPY,
  BID_CEILING_JPY,
  type BidMutationInput,
} from "./adapters/bid-mutation-executor";
import type { ProxyFn } from "./adapters/adapter";

function makeProxy(impl: ReturnType<typeof vi.fn>): ProxyFn {
  return impl as unknown as ProxyFn;
}

describe("applyBudgetChange", () => {
  it("fails closed in dry-run without calling proxy", async () => {
    const proxy = vi.fn();
    const r = await applyBudgetChange(
      { tenantId: "t1", reallocationId: "r1", platform: "google", campaignId: "customers/123/campaignBudgets/456", newDailyBudgetJpy: 5000 },
      { proxy: makeProxy(proxy), dryRun: true },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("budget_reallocation_dry_run_enabled");
    expect(proxy).not.toHaveBeenCalled();
    expect(isDryRunEnabled({ proxy: makeProxy(proxy), dryRun: true })).toBe(true);
  });

  it("Google Ads success uses google-ads integration + amount_micros", async () => {
    const proxy = vi.fn().mockResolvedValue({ data: { results: [{ resource_name: "customers/123/campaignBudgets/456" }] } });
    const r = await applyBudgetChange(
      { tenantId: "t1", reallocationId: "r2", platform: "google", campaignId: "customers/123/campaignBudgets/456", newDailyBudgetJpy: 5000 },
      { proxy: makeProxy(proxy) },
    );
    expect(r.ok).toBe(true);
    expect(r.externalRef).toBe("customers/123/campaignBudgets/456");
    const [tenantId, integrationId, connectionId, method, , body] = proxy.mock.calls[0]!;
    expect(tenantId).toBe("t1");
    expect(integrationId).toBe("google-ads");
    expect(connectionId).toBe("default");
    expect(method).toBe("POST");
    expect((body as { operations: Array<{ update: { amount_micros: number } }> }).operations[0]!.update.amount_micros).toBe(5_000_000_000);
  });

  it("Meta success uses facebook-ads + daily_budget", async () => {
    const proxy = vi.fn().mockResolvedValue({ data: { id: "act_999/adsets/777" } });
    const r = await applyBudgetChange(
      { tenantId: "t1", reallocationId: "r4", platform: "meta", campaignId: "act_999/adsets/777", newDailyBudgetJpy: 8000 },
      { proxy: makeProxy(proxy) },
    );
    expect(r.ok).toBe(true);
    expect(r.externalRef).toBe("meta-act_999/adsets/777");
    expect(proxy.mock.calls[0]![1]).toBe("facebook-ads");
    expect((proxy.mock.calls[0]![5] as { daily_budget: number }).daily_budget).toBe(8000);
  });

  it("treats meta success:false as failure", async () => {
    const proxy = vi.fn().mockResolvedValue({ data: { success: false } });
    const r = await applyBudgetChange(
      { tenantId: "t1", reallocationId: "r5", platform: "meta", campaignId: "x", newDailyBudgetJpy: 8000 },
      { proxy: makeProxy(proxy) },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("meta_ads_mutation_rejected");
  });

  it("returns ok=false for unsupported platforms", async () => {
    const proxy = vi.fn();
    const r = await applyBudgetChange(
      { tenantId: "t1", reallocationId: "r6", platform: "linkedin", campaignId: "li", newDailyBudgetJpy: 1000 },
      { proxy: makeProxy(proxy) },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unsupported_platform:linkedin");
    expect(proxy).not.toHaveBeenCalled();
  });
});

describe("applyBidChange", () => {
  function makeInput(overrides: Partial<BidMutationInput> = {}): BidMutationInput {
    return { tenantId: "tenant-abc", bidMutationId: "bid-001", platform: "google", campaignId: "456", customerId: "123", newDailyBidJpy: 5_000, ...overrides };
  }

  it("dry-run short-circuits", async () => {
    const proxy = vi.fn();
    const r = await applyBidChange(makeInput(), { proxy: makeProxy(proxy), dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("bid_mutation_dry_run_enabled");
    expect(isBidDryRunEnabled({ proxy: makeProxy(proxy), dryRun: true })).toBe(true);
    expect(proxy).not.toHaveBeenCalled();
  });

  it("rejects below floor and above ceiling", async () => {
    const proxy = vi.fn();
    const cfg = { proxy: makeProxy(proxy) };
    expect((await applyBidChange(makeInput({ newDailyBidJpy: BID_FLOOR_JPY - 1 }), cfg)).error).toMatch(/bid_below_floor/);
    expect((await applyBidChange(makeInput({ newDailyBidJpy: BID_CEILING_JPY + 1 }), cfg)).error).toMatch(/bid_above_ceiling/);
    expect(proxy).not.toHaveBeenCalled();
  });

  it("Google bid: target_cpa_micros + resource name extraction", async () => {
    const proxy = vi.fn().mockResolvedValue({ data: { results: [{ resource_name: "customers/123/campaigns/456" }] } });
    const r = await applyBidChange(makeInput({ campaignId: "customers/999/campaigns/456", newDailyBidJpy: 2_000 }), { proxy: makeProxy(proxy) });
    expect(r.ok).toBe(true);
    expect(r.externalRef).toBe("customers/123/campaigns/456");
    const [, integrationId, , , endpoint, body] = proxy.mock.calls[0]!;
    expect(integrationId).toBe("google-ads");
    expect(endpoint).toBe("customers/123/campaigns:mutate");
    const op = (body as { operations: Array<{ update: { resource_name: string; target_cpa: { target_cpa_micros: number } } }> }).operations[0]!;
    expect(op.update.resource_name).toBe("customers/123/campaigns/456");
    expect(op.update.target_cpa.target_cpa_micros).toBe(2_000 * 1_000_000);
  });

  it("Google bid requires customerId", async () => {
    const proxy = vi.fn();
    const r = await applyBidChange(makeInput({ customerId: undefined }), { proxy: makeProxy(proxy) });
    expect(r.error).toBe("google_ads_customer_id_required");
    expect(proxy).not.toHaveBeenCalled();
  });

  it("Meta bid: bid_amount + strategy, synthetic ref", async () => {
    const proxy = vi.fn().mockResolvedValue({ data: { id: "meta-camp-789" } });
    const r = await applyBidChange(makeInput({ platform: "meta", campaignId: "act_12345", newDailyBidJpy: 3_500 }), { proxy: makeProxy(proxy) });
    expect(r.ok).toBe(true);
    expect(r.externalRef).toBe("meta-bid-meta-camp-789");
    const b = proxy.mock.calls[0]![5] as { bid_amount: number; bid_strategy: string };
    expect(b.bid_amount).toBe(3_500);
    expect(b.bid_strategy).toBe("LOWEST_COST_WITH_BID_CAP");
  });
});
