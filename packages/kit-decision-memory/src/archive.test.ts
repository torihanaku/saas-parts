import { describe, expect, it } from "vitest";
import { extractTagFacets, MemoryArchiveService } from "./archive.js";
import { InMemoryMemoryStore } from "./stores.js";
import { seedMemories, TENANT } from "./test-helpers.js";

describe("extractTagFacets", () => {
  it("[ns:value] 名前空間タグをファセットへ写像する", () => {
    const facets = extractTagFacets("[channel:meta] [segment:sme] [season:fy26q1] 値引き失敗");
    expect(facets.channel).toBe("meta");
    expect(facets.segment).toBe("sme");
    expect(facets.season).toBe("fy26q1");
    expect(facets.tags).toEqual(["channel:meta", "season:fy26q1", "segment:sme"]);
  });

  it("#hashtag はルーズタグとして抽出する（小文字化・重複排除・ソート）", () => {
    const facets = extractTagFacets("#Pricing の反省 #pricing #ltv");
    expect(facets.tags).toEqual(["ltv", "pricing"]);
  });

  it("空文字は空ファセット", () => {
    expect(extractTagFacets("")).toEqual({ tags: [], channel: "", segment: "", season: "" });
  });
});

describe("MemoryArchiveService", () => {
  async function makeService() {
    const store = new InMemoryMemoryStore();
    await seedMemories(store, [
      {
        id: "f1",
        memType: "failure_recipe",
        subject: "値引き乱発 [channel:meta]",
        content: "LTV 悪化 #pricing",
        source: "[segment:sme]",
      },
      {
        id: "f2",
        memType: "failure_recipe",
        subject: "深夜配信のミス [channel:email]",
        content: "苦情が増えた",
      },
      {
        id: "s1",
        memType: "success_recipe",
        subject: "ブログ強化",
        content: "流入 2 倍 #seo",
      },
      {
        id: "d1",
        memType: "decision_log",
        subject: "広告停止",
        content: "decision_log はアーカイブ対象外",
      },
    ]);
    return new MemoryArchiveService({ store });
  }

  it("type=failure で失敗レシピのみ・ファセット付きで返す", async () => {
    const service = await makeService();
    const result = await service.listArchive(TENANT, { type: "failure" });
    expect(result.items.map((i) => i.id)).toEqual(["f1", "f2"]);
    expect(result.total).toBe(2);
    expect(result.facets.channels).toEqual(["email", "meta"]);
    expect(result.facets.tags).toContain("pricing");
    expect(result.items[0]).toMatchObject({ channel: "meta", segment: "sme" });
  });

  it("q / channel / tags フィルタが効く（ファセットはフィルタ前全体）", async () => {
    const service = await makeService();
    const byQ = await service.listArchive(TENANT, { type: "failure", q: "深夜" });
    expect(byQ.items.map((i) => i.id)).toEqual(["f2"]);
    expect(byQ.facets.channels).toEqual(["email", "meta"]);

    const byChannel = await service.listArchive(TENANT, { type: "failure", channel: "META" });
    expect(byChannel.items.map((i) => i.id)).toEqual(["f1"]);

    const byTags = await service.listArchive(TENANT, {
      type: "failure",
      tags: ["pricing", "channel:meta"],
    });
    expect(byTags.items.map((i) => i.id)).toEqual(["f1"]);

    const noMatch = await service.listArchive(TENANT, {
      type: "failure",
      tags: ["pricing", "nonexistent"],
    });
    expect(noMatch.items).toEqual([]);
  });

  it("type=success は成功レシピのみ", async () => {
    const service = await makeService();
    const result = await service.listArchive(TENANT, { type: "success" });
    expect(result.items.map((i) => i.id)).toEqual(["s1"]);
  });

  it("getArchiveItem: レシピ以外（decision_log）や未知 id は null", async () => {
    const service = await makeService();
    const item = await service.getArchiveItem(TENANT, "f1");
    expect(item?.tags).toContain("channel:meta");
    expect(await service.getArchiveItem(TENANT, "d1")).toBeNull();
    expect(await service.getArchiveItem(TENANT, "nope")).toBeNull();
    expect(await service.getArchiveItem(TENANT, "")).toBeNull();
  });
});
