/**
 * Tests for SeoAdapter (ported from 実運用SaaS seo-adapter.test.ts).
 * supabase-admin / feature-flags / nango-client を注入式 config に置換。
 */
import { describe, it, expect, vi } from "vitest";

import {
  SeoAdapter,
  buildSeoIndexingPayload,
  type SeoTargetRow,
  type SeoAdapterConfig,
  type ProxyRequestFn,
} from "./adapters/seo-adapter";
import type { SubmissionRecord } from "./types";

const SUBMISSION: SubmissionRecord = {
  id: "44444444-4444-4444-4444-444444444444",
  tenant_id: "tenant-seo",
  title: "Folia launch https://example.com/launch#hero",
  content_text: "Approved post body.",
  status: "approved",
  auto_deploy: true,
};

function makeAdapter(opts: {
  targets: SeoTargetRow[];
  proxyRequest?: ProxyRequestFn;
  enabled?: boolean;
}): SeoAdapter {
  const config: SeoAdapterConfig = {
    proxyRequest: opts.proxyRequest ?? (vi.fn().mockResolvedValue({ ok: true }) as unknown as ProxyRequestFn),
    loadTargets: vi.fn().mockResolvedValue(opts.targets),
    enabled: () => opts.enabled ?? true,
  };
  return new SeoAdapter(config);
}

describe("buildSeoIndexingPayload", () => {
  it("uses options.url first and strips fragments", () => {
    const payload = buildSeoIndexingPayload(SUBMISSION, {
      url: "https://example.com/from-options?utm=1#section",
    });
    expect(payload).toEqual({
      endpoint: "/v3/urlNotifications:publish",
      body: { url: "https://example.com/from-options?utm=1", type: "URL_UPDATED" },
    });
  });

  it("extracts the first URL from the approved submission", () => {
    const payload = buildSeoIndexingPayload(SUBMISSION);
    expect(payload?.body.url).toBe("https://example.com/launch");
    expect(payload?.body.type).toBe("URL_UPDATED");
  });

  it("returns null instead of inventing a URL", () => {
    const payload = buildSeoIndexingPayload({
      title: "No canonical URL",
      content_text: "Body without a link.",
    });
    expect(payload).toBeNull();
  });
});

describe("SeoAdapter", () => {
  it("returns skipped when disabled", async () => {
    const adapter = makeAdapter({ targets: [], enabled: false });
    const result = await adapter.run(SUBMISSION);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("feature_flag_disabled");
  });

  it("returns skipped when no SEO targets are configured", async () => {
    const adapter = makeAdapter({ targets: [] });
    const result = await adapter.run(SUBMISSION);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_seo_targets_configured");
  });

  it("calls the proxy for Google Search Console indexing", async () => {
    const proxyRequest = vi.fn().mockResolvedValue({
      data: { urlNotificationMetadata: { latestUpdate: { type: "URL_UPDATED" } } },
      status: 200,
    }) as unknown as ProxyRequestFn;
    const adapter = makeAdapter({
      targets: [
        { platform: "google-search-console", connection_id: "gsc-1", options: { url: "https://example.com/canonical" } },
      ],
      proxyRequest,
    });

    const result = await adapter.run(SUBMISSION);

    expect(result.status).toBe("success");
    expect(proxyRequest).toHaveBeenCalledWith(
      "tenant-seo",
      "google-search-console",
      "gsc-1",
      "POST",
      "/v3/urlNotifications:publish",
      { url: "https://example.com/canonical", type: "URL_UPDATED" },
    );
    expect(result.detail).toMatchObject({
      adapter: "seo",
      indexed: [
        {
          platform: "google-search-console",
          url: "https://example.com/canonical",
          connection_id: "gsc-1",
          notification_type: "URL_UPDATED",
        },
      ],
    });
  });

  it("throws when every configured target lacks an indexable URL", async () => {
    const proxyRequest = vi.fn() as unknown as ProxyRequestFn;
    const adapter = makeAdapter({
      targets: [{ platform: "google-search-console", connection_id: "gsc-1" }],
      proxyRequest,
    });

    await expect(
      adapter.run({ ...SUBMISSION, title: "No URL", content_text: "Still no URL" }),
    ).rejects.toThrow(/seo_all_targets_failed/);
    expect(proxyRequest).not.toHaveBeenCalled();
  });

  it("throws when the proxy returns null for every SEO target", async () => {
    const proxyRequest = vi.fn().mockResolvedValue(null) as unknown as ProxyRequestFn;
    const adapter = makeAdapter({
      targets: [
        { platform: "google-search-console", connection_id: "gsc-1", options: { url: "https://example.com/canonical" } },
      ],
      proxyRequest,
    });
    await expect(adapter.run(SUBMISSION)).rejects.toThrow(/seo_all_targets_failed/);
  });

  it("does not issue a destructive URL_DELETED rollback", async () => {
    const proxyRequest = vi.fn() as unknown as ProxyRequestFn;
    const adapter = makeAdapter({ targets: [], proxyRequest });
    await adapter.rollback(SUBMISSION, {
      target: "seo",
      status: "success",
      startedAt: new Date().toISOString(),
      detail: {
        adapter: "seo",
        indexed: [{ platform: "google-search-console", url: "https://example.com/canonical" }],
      },
    });
    expect(proxyRequest).not.toHaveBeenCalled();
  });
});
