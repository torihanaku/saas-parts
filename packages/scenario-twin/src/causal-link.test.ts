/**
 * Tests for causal-link.ts (ported from dev-dashboard-v2 tests/twin/causal-link.test.ts).
 * Store is injected as a fake.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  saveCausalToTwinLink,
  getTenantCausalLinks,
  buildCausalElasticityTable,
  channelToInputKey,
  type CausalLinkStore,
  type CausalLinkRow,
  type CausalToTwinLink,
} from "./causal-link.js";

const TENANT = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-05-05T12:00:00Z");

const upsertCausalLink = vi.fn();
const listCausalLinks = vi.fn();
const store: CausalLinkStore = { upsertCausalLink, listCausalLinks };

beforeEach(() => vi.clearAllMocks());

describe("channelToInputKey", () => {
  it("maps blog channels to blog_count", () => {
    expect(channelToInputKey("blog_organic")).toBe("blog_count");
    expect(channelToInputKey("CONTENT-marketing")).toBe("blog_count");
  });
  it("maps ad channels to ad_budget", () => {
    expect(channelToInputKey("google_ads")).toBe("ad_budget");
    expect(channelToInputKey("Meta Ads")).toBe("ad_budget");
    expect(channelToInputKey("facebook")).toBe("ad_budget");
  });
  it("maps email channels to email_frequency", () => {
    expect(channelToInputKey("email-newsletter")).toBe("email_frequency");
  });
  it("normalises unknown channels to snake_case", () => {
    expect(channelToInputKey("Direct Mail!!")).toBe("direct_mail_");
  });
});

describe("saveCausalToTwinLink", () => {
  it("validates required fields", async () => {
    await expect(
      saveCausalToTwinLink(
        { tenantId: "", experimentId: "e", channel: "blog", effectSize: 1 },
        store,
      ),
    ).rejects.toThrow(/tenantId/);
    await expect(
      saveCausalToTwinLink(
        { tenantId: TENANT, experimentId: "exp1", channel: "blog", effectSize: NaN },
        store,
      ),
    ).rejects.toThrow(/effectSize/);
  });

  it("upserts and returns the persisted DTO", async () => {
    upsertCausalLink.mockResolvedValueOnce({
      id: "row-1",
      tenant_id: TENANT,
      experiment_id: "exp-001",
      channel: "google_ads",
      output_metric: "revenue",
      effect_size: "0.075",
      ci_lower: "0.04",
      ci_upper: "0.11",
      method: "did",
      computed_at: NOW.toISOString(),
    } satisfies CausalLinkRow);

    const link = await saveCausalToTwinLink(
      {
        tenantId: TENANT,
        experimentId: "exp-001",
        channel: "google_ads",
        effectSize: 0.075,
        ciLower: 0.04,
        ciUpper: 0.11,
        method: "did",
      },
      store,
    );
    expect(link.id).toBe("row-1");
    expect(link.effectSize).toBe(0.075);
    expect(link.ciLower).toBe(0.04);
    expect(link.method).toBe("did");
    const payload = upsertCausalLink.mock.calls[0]![0];
    expect(payload.tenantId).toBe(TENANT);
    expect(payload.outputMetric).toBe("revenue");
  });
});

describe("getTenantCausalLinks", () => {
  it("dedupes to latest per (channel, output_metric)", async () => {
    listCausalLinks.mockResolvedValueOnce([
      {
        id: "r2",
        tenant_id: TENANT,
        experiment_id: "exp-NEW",
        channel: "google_ads",
        output_metric: "revenue",
        effect_size: 0.1,
        ci_lower: null,
        ci_upper: null,
        method: "did",
        computed_at: "2026-04-15T00:00:00Z",
      },
      {
        id: "r1",
        tenant_id: TENANT,
        experiment_id: "exp-OLD",
        channel: "google_ads",
        output_metric: "revenue",
        effect_size: 0.05,
        ci_lower: null,
        ci_upper: null,
        method: "did",
        computed_at: "2026-04-01T00:00:00Z",
      },
    ] satisfies CausalLinkRow[]);

    const links = await getTenantCausalLinks(TENANT, store, { now: NOW });
    expect(links).toHaveLength(1);
    expect(links[0]!.experimentId).toBe("exp-NEW");
  });

  it("flags links older than 90 days as stale", async () => {
    listCausalLinks.mockResolvedValueOnce([
      {
        id: "r-old",
        tenant_id: TENANT,
        experiment_id: "exp-STALE",
        channel: "blog",
        output_metric: "revenue",
        effect_size: 0.2,
        ci_lower: null,
        ci_upper: null,
        method: null,
        computed_at: "2026-01-01T00:00:00Z", // > 90 days before NOW
      },
    ] satisfies CausalLinkRow[]);
    const links = await getTenantCausalLinks(TENANT, store, { now: NOW });
    expect(links[0]!.stale).toBe(true);
  });
});

describe("buildCausalElasticityTable", () => {
  it("builds table + provenance and warns on stale links", () => {
    const links: CausalToTwinLink[] = [
      {
        id: "l1",
        tenantId: TENANT,
        experimentId: "exp-1",
        channel: "google_ads",
        outputMetric: "revenue",
        effectSize: 0.08,
        ciLower: null,
        ciUpper: null,
        method: "did",
        computedAt: NOW.toISOString(),
        stale: false,
        ageDays: 5,
      },
      {
        id: "l2",
        tenantId: TENANT,
        experimentId: "exp-2",
        channel: "blog",
        outputMetric: "pv",
        effectSize: 1.5,
        ciLower: null,
        ciUpper: null,
        method: null,
        computedAt: "2026-01-01T00:00:00Z",
        stale: true,
        ageDays: 120,
      },
    ];
    const res = buildCausalElasticityTable(links);
    expect(res.table.ad_budget!.revenue).toBe(0.08);
    expect(res.table.blog_count!.pv).toBe(1.5);
    expect(res.provenance.ad_budget!.revenue).toBe("exp-1");
    expect(res.warnings.some((w) => w.includes("causal_link_stale"))).toBe(true);
  });
});
