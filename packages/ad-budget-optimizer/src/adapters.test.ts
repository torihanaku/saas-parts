import { describe, it, expect, vi } from "vitest";
import { updateGoogleAdsBudget, createGoogleAdsAdapter } from "./adapters/google-ads";
import { updateMetaAdsBudget } from "./adapters/meta-ads";
import { updateTikTokAdsBudget } from "./adapters/tiktok-ads";
import type { ProxyFn } from "./adapters/adapter";

const onGate = () => true;
const offGate = () => false;

describe("updateGoogleAdsBudget", () => {
  const update = {
    campaignId: "c1",
    budgetResourceName: "customers/123/campaignBudgets/456",
    dailyBudgetJpy: 30_000,
    connectionId: "conn-1",
    customerId: "123",
  };

  it("skips when flag is OFF", async () => {
    const r = await updateGoogleAdsBudget("t", update, {}, offGate);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("feature_flag_disabled");
  });

  it("dry_run returns ok without calling proxy", async () => {
    const proxyImpl = vi.fn();
    const r = await updateGoogleAdsBudget("t", update, { dry_run: true, proxyImpl: proxyImpl as unknown as ProxyFn }, onGate);
    expect(r.ok).toBe(true);
    expect(r.dry).toBe(true);
    expect(proxyImpl).not.toHaveBeenCalled();
  });

  it("converts JPY to micros and calls proxy on success", async () => {
    const proxyImpl = vi.fn().mockResolvedValue({ data: { results: [{}] }, status: 200 });
    const r = await updateGoogleAdsBudget("t", update, { proxyImpl: proxyImpl as unknown as ProxyFn }, onGate);
    expect(r.ok).toBe(true);
    const body = proxyImpl.mock.calls[0]![5] as { operations: Array<{ update: { amountMicros: number } }> };
    expect(body.operations[0]!.update.amountMicros).toBe(30_000_000_000);
  });

  it("returns error when proxy returns null", async () => {
    const proxyImpl = vi.fn().mockResolvedValue(null);
    const r = await updateGoogleAdsBudget("t", update, { proxyImpl: proxyImpl as unknown as ProxyFn }, onGate);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("nango_proxy_failed");
  });

  it("rejects missing required fields", async () => {
    const r = await updateGoogleAdsBudget("t", { ...update, customerId: "" }, {}, onGate);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing_required_fields");
  });

  it("factory wires proxy + gate", async () => {
    const proxyImpl = vi.fn().mockResolvedValue({ data: { results: [{}] } });
    const adapter = createGoogleAdsAdapter(proxyImpl as unknown as ProxyFn, onGate);
    const r = await adapter.update("t", update);
    expect(r.ok).toBe(true);
    expect(proxyImpl).toHaveBeenCalledTimes(1);
  });
});

describe("updateMetaAdsBudget", () => {
  const update = { campaignId: "c1", dailyBudgetJpy: 50_000, connectionId: "conn-1" };

  it("skips when flag is OFF", async () => {
    const r = await updateMetaAdsBudget("t", update, {}, offGate);
    expect(r.error).toBe("feature_flag_disabled");
  });

  it("real call uses proxy and returns ok on success", async () => {
    const proxyImpl = vi.fn().mockResolvedValue({ data: { success: true }, status: 200 });
    const r = await updateMetaAdsBudget("t", update, { proxyImpl: proxyImpl as unknown as ProxyFn }, onGate);
    expect(r.ok).toBe(true);
    expect(proxyImpl).toHaveBeenCalledWith("t", "meta-ads", "conn-1", "POST", "/c1", expect.objectContaining({ daily_budget: 50_000 }));
  });

  it("rejects negative budget", async () => {
    const r = await updateMetaAdsBudget("t", { ...update, dailyBudgetJpy: -10 }, {}, onGate);
    expect(r.error).toBe("negative_budget");
  });
});

describe("updateTikTokAdsBudget", () => {
  const update = { campaignId: "cmp-1", advertiserId: "adv-1", dailyBudgetJpy: 40_000, connectionId: "conn-1" };

  it("real call uses proxy campaign update endpoint", async () => {
    const proxyImpl = vi.fn().mockResolvedValue({ data: { code: 0 }, status: 200 });
    const r = await updateTikTokAdsBudget("t", update, { proxyImpl: proxyImpl as unknown as ProxyFn }, onGate);
    expect(r.ok).toBe(true);
    expect(proxyImpl).toHaveBeenCalledWith("t", "tiktok-ads", "conn-1", "POST", "/open_api/v1.3/campaign/update/", {
      advertiser_id: "adv-1",
      campaign_id: "cmp-1",
      budget: 40_000,
    });
  });

  it("rejects missing advertiser id", async () => {
    const r = await updateTikTokAdsBudget("t", { ...update, advertiserId: "" }, {}, onGate);
    expect(r.error).toBe("missing_required_fields");
  });
});
