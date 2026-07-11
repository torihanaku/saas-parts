import { describe, it, expect } from "vitest";
import {
  NormalizerRegistry,
  createExampleRegistry,
  normalizeChatMessage,
  normalizeEmail,
  normalizeGa4Report,
  normalizeGeneric,
} from "./normalizers";

describe("NormalizerRegistry", () => {
  it("resolves a registered normalizer with its model and sourceType", () => {
    const registry = new NormalizerRegistry().register("slack", {
      model: "messages",
      sourceType: "slack",
      normalize: normalizeChatMessage,
    });
    const resolved = registry.resolve("slack");
    expect(resolved.model).toBe("messages");
    expect(resolved.sourceType).toBe("slack");
  });

  it("falls back to the generic normalizer for unknown integrations", () => {
    const registry = new NormalizerRegistry();
    const resolved = registry.resolve("some-unknown-tool");
    expect(resolved.model).toBe("records");
    expect(resolved.sourceType).toBe("some-unknown-tool");
    expect(resolved.normalize({ title: "T", content: "C", id: "1" })?.title).toBe("T");
  });

  it("defaults sourceType to the integrationId when omitted", () => {
    const registry = new NormalizerRegistry().register("custom", {
      model: "items",
      normalize: normalizeGeneric,
    });
    expect(registry.resolve("custom").sourceType).toBe("custom");
  });

  it("lists registered integrations and supports has()", () => {
    const registry = createExampleRegistry();
    expect(registry.list()).toContain("slack");
    expect(registry.list()).toContain("google-analytics");
    expect(registry.has("slack")).toBe(true);
    expect(registry.has("jira")).toBe(false); // 落としたノーマライザは未登録
  });
});

describe("normalizeChatMessage", () => {
  it("normalizes a Slack message with channel/user metadata", () => {
    const r = normalizeChatMessage({ text: "hello", channel: "#general", user: "U1", ts: "123.456" });
    expect(r?.title).toBe("Slack: #general");
    expect(r?.content).toBe("[U1] hello");
    expect(r?.external_id).toBe("123.456");
    expect(r?.source_type).toBe("slack");
  });

  it("returns null for empty messages", () => {
    expect(normalizeChatMessage({ channel: "#general" })).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("normalizes subject/body and truncates content to 5000 chars", () => {
    const r = normalizeEmail({ subject: "S", body: "x".repeat(6000), id: "m1" });
    expect(r?.title).toBe("S");
    expect(r?.content).toHaveLength(5000);
    expect(r?.external_id).toBe("m1");
  });

  it("returns null when both subject and body are empty", () => {
    expect(normalizeEmail({ from: "a@example.com" })).toBeNull();
  });
});

describe("normalizeGa4Report", () => {
  it("serializes metrics into JSON content with a composite external_id", () => {
    const r = normalizeGa4Report({ page_path: "/lp", sessions: 10, pageviews: 20, date: "2026-07-01" });
    expect(r?.title).toBe("/lp");
    expect(JSON.parse(r?.content ?? "{}")).toEqual({
      sessions: 10,
      pageviews: 20,
      users: 0,
      conversions: 0,
      bounce_rate: 0,
    });
    expect(r?.external_id).toBe("ga4_/lp_2026-07-01");
  });
});

describe("normalizeGeneric", () => {
  it("picks title/content from common field names", () => {
    const r = normalizeGeneric({ name: "N", description: "D", id: "1" });
    expect(r?.title).toBe("N");
    expect(r?.content).toBe("D");
  });

  it("returns null when nothing usable is found", () => {
    expect(normalizeGeneric({ foo: "bar" })).toBeNull();
  });
});
