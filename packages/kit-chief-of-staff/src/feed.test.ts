import { describe, expect, it } from "vitest";
import { FeedService, clampFeedLimit, isIsoDate } from "./feed";
import { InMemoryDigestStore } from "./stores";
import type { CosSourceType } from "./types";

async function seed(store: InMemoryDigestStore, sourceType: CosSourceType, relevance: number) {
  await store.insert({
    tenantId: "t1",
    sourceType,
    sourcePermalink: "p",
    sourceActor: null,
    rawTextPreview: "raw",
    rawTextTruncated: false,
    summary: `${sourceType} ${relevance}`,
    tags: [],
    relevanceScore: relevance,
  });
}

describe("clampFeedLimit / isIsoDate", () => {
  it("既定 50・最大 200・不正値は既定", () => {
    expect(clampFeedLimit(undefined)).toBe(50);
    expect(clampFeedLimit(0)).toBe(50);
    expect(clampFeedLimit(-1)).toBe(50);
    expect(clampFeedLimit(10.7)).toBe(10);
    expect(clampFeedLimit(999)).toBe(200);
  });

  it("isIsoDate はパース可能な日付のみ true", () => {
    expect(isIsoDate("2026-07-01T00:00:00Z")).toBe(true);
    expect(isIsoDate("not-a-date")).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });
});

describe("FeedService.list", () => {
  it("relevance 降順で返す", async () => {
    const store = new InMemoryDigestStore();
    await seed(store, "slack", 0.3);
    await seed(store, "email", 0.9);
    await seed(store, "meeting", 0.6);
    const feed = new FeedService({ digestStore: store });
    const items = await feed.list("t1");
    expect(items.map((i) => i.relevanceScore)).toEqual([0.9, 0.6, 0.3]);
  });

  it("sourceType フィルタ（不正値は無視して全件）", async () => {
    const store = new InMemoryDigestStore();
    await seed(store, "slack", 0.5);
    await seed(store, "email", 0.5);
    const feed = new FeedService({ digestStore: store });
    expect(await feed.list("t1", { sourceType: "slack" })).toHaveLength(1);
    expect(await feed.list("t1", { sourceType: "carrier-pigeon" })).toHaveLength(2);
  });

  it("テナント分離", async () => {
    const store = new InMemoryDigestStore();
    await seed(store, "slack", 0.5);
    const feed = new FeedService({ digestStore: store });
    expect(await feed.list("other-tenant")).toHaveLength(0);
  });

  it("limit が効く", async () => {
    const store = new InMemoryDigestStore();
    for (let i = 0; i < 5; i++) await seed(store, "slack", 0.5);
    const feed = new FeedService({ digestStore: store });
    expect(await feed.list("t1", { limit: 2 })).toHaveLength(2);
  });
});
