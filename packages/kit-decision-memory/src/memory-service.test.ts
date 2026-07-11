import { describe, expect, it } from "vitest";
import { InstitutionalMemoryService } from "./memory-service.js";
import { InMemoryMemoryStore } from "./stores.js";
import { fixedContext, seedMemories, TENANT } from "./test-helpers.js";
import { DecisionMemoryValidationError } from "./types.js";

function makeService(
  overrides: Partial<ConstructorParameters<typeof InstitutionalMemoryService>[0]> = {},
) {
  const store = new InMemoryMemoryStore();
  const service = new InstitutionalMemoryService({
    store,
    context: fixedContext(),
    ...overrides,
  });
  return { service, store };
}

describe("InstitutionalMemoryService.logMemory", () => {
  it("ナレッジを保存し、embedder の埋め込みをストアへ渡す", async () => {
    const embedded: string[] = [];
    const { service, store } = makeService({
      embedder: {
        embed: async (text) => {
          embedded.push(text);
          return [0.5];
        },
      },
    });
    const item = await service.logMemory(TENANT, {
      memType: "failure_recipe",
      subject: "年末の値引き乱発",
      content: "値引きで CV は増えたが LTV が悪化した",
    });
    expect(item).toMatchObject({
      id: "id-1",
      tenantId: TENANT,
      memType: "failure_recipe",
      decidedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(embedded).toEqual(["年末の値引き乱発\n\n値引きで CV は増えたが LTV が悪化した"]);
    expect(store.embeddings.get("id-1")).toEqual([0.5]);
  });

  it("バリデーション: mem_type / subject / content / decided_at", async () => {
    const { service } = makeService();
    const base = { memType: "failure_recipe", subject: "s", content: "c" };
    await expect(service.logMemory(TENANT, { ...base, memType: "bogus" })).rejects.toThrow(
      /mem_type must be one of/,
    );
    await expect(service.logMemory(TENANT, { ...base, subject: " " })).rejects.toThrow(
      "subject is required",
    );
    await expect(service.logMemory(TENANT, { ...base, subject: "x".repeat(501) })).rejects.toThrow(
      /subject exceeds 500/,
    );
    await expect(service.logMemory(TENANT, { ...base, content: "" })).rejects.toThrow(
      "content is required",
    );
    await expect(
      service.logMemory(TENANT, { ...base, content: "x".repeat(20_001) }),
    ).rejects.toThrow(/content exceeds 20000/);
    await expect(
      service.logMemory(TENANT, { ...base, decidedAt: "not-a-date" }),
    ).rejects.toThrow(/decided_at must be a valid ISO-8601/);
  });

  it("memTypes をパラメータ化できる", async () => {
    const { service } = makeService({ memTypes: ["playbook"] });
    await expect(
      service.logMemory(TENANT, { memType: "failure_recipe", subject: "s", content: "c" }),
    ).rejects.toThrow(/playbook/);
    const item = await service.logMemory(TENANT, {
      memType: "playbook",
      subject: "s",
      content: "c",
    });
    expect(item.memType).toBe("playbook");
  });
});

describe("InstitutionalMemoryService.searchMemory", () => {
  async function seeded(overrides: Parameters<typeof makeService>[0] = {}) {
    const made = makeService(overrides);
    await seedMemories(made.store, [
      {
        id: "mem-fb",
        memType: "decision_log",
        subject: "Facebook 広告の停止",
        content: "CPA 高騰のため停止した",
      },
      {
        id: "mem-blog",
        memType: "success_recipe",
        subject: "ブログ強化",
        content: "オーガニック流入が 2 倍になった",
      },
    ]);
    return made;
  }

  it("BM25 フォールバックで関連順に返す（summary は LLM 未注入で空）", async () => {
    const { service } = await seeded();
    const result = await service.searchMemory(TENANT, "Facebook 広告");
    expect(result.results[0]?.id).toBe("mem-fb");
    expect(result.results[0]?.similarity).toBe(1);
    expect(result.summary).toBe("");
  });

  it("memType フィルタが BM25 パスでも効く", async () => {
    const { service } = await seeded();
    const result = await service.searchMemory(TENANT, "広告 ブログ", {
      memType: "success_recipe",
    });
    expect(result.results.map((r) => r.id)).toEqual(["mem-blog"]);
  });

  it("generateText 注入時は [#id先頭8文字] 付き根拠プロンプトで要約する", async () => {
    const prompts: string[] = [];
    const { service } = await seeded({
      generateText: async (_system, user) => {
        prompts.push(user);
        return "要約 [#mem-fb]";
      },
    });
    const result = await service.searchMemory(TENANT, "Facebook");
    expect(result.summary).toBe("要約 [#mem-fb]");
    expect(prompts[0]).toContain("[#mem-fb]");
  });

  it("LLM が失敗しても summary='' で結果は返す", async () => {
    const { service } = await seeded({
      generateText: async () => {
        throw new Error("llm down");
      },
    });
    const result = await service.searchMemory(TENANT, "Facebook");
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.summary).toBe("");
  });

  it("空クエリはバリデーションエラー、0 件は空レスポンス", async () => {
    const { service } = await seeded();
    await expect(service.searchMemory(TENANT, " ")).rejects.toThrow(
      DecisionMemoryValidationError,
    );
    expect(await service.searchMemory(TENANT, "zzz_nomatch")).toEqual({
      results: [],
      summary: "",
    });
  });
});

describe("InstitutionalMemoryService.getMemoryByType", () => {
  it("decidedAt 降順・limit clamp（1..200）", async () => {
    const { service, store } = makeService();
    await seedMemories(store, [
      { id: "m1", memType: "failure_recipe", subject: "a", content: "c", decidedAt: "2026-01-01T00:00:00.000Z" },
      { id: "m2", memType: "failure_recipe", subject: "b", content: "c", decidedAt: "2026-03-01T00:00:00.000Z" },
      { id: "m3", memType: "success_recipe", subject: "x", content: "c" },
    ]);
    const rows = await service.getMemoryByType(TENANT, "failure_recipe");
    expect(rows.map((r) => r.id)).toEqual(["m2", "m1"]);
    const clamped = await service.getMemoryByType(TENANT, "failure_recipe", 0.5);
    expect(clamped).toHaveLength(1);
    await expect(service.getMemoryByType(TENANT, "bogus")).rejects.toThrow(
      /mem_type must be one of/,
    );
  });
});
