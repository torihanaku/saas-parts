import { describe, expect, it } from "vitest";
import { fetchSignalDetail } from "./signal-detail";
import { MemoryContextStore, MemorySignalStore } from "./memory-stores";

const USER = "user-1";

describe("fetchSignalDetail", () => {
  it("signal + context + 関連シグナルを返す", async () => {
    const signalStore = new MemorySignalStore();
    const contextStore = new MemoryContextStore();

    const related = await signalStore.insert(USER, {
      source: "hn",
      url: "https://example.com/rel",
      title: "Related",
      fetchedAt: "2026-07-01T00:00:00.000Z",
    });
    const target = await signalStore.insert(USER, {
      source: "hn",
      url: "https://example.com/target",
      title: "Target",
      fetchedAt: "2026-07-02T00:00:00.000Z",
    });
    await contextStore.insert(USER, {
      signalId: target!.id,
      relatedSignalIds: [related!.id],
      importanceScore: 80,
      verdict: "big_deal",
      rationale: "r",
    });

    const detail = await fetchSignalDetail(USER, target!.id, {
      signalStore,
      contextStore,
    });
    expect(detail?.signal.title).toBe("Target");
    expect(detail?.context?.verdict).toBe("big_deal");
    expect(detail?.related.map((s) => s.title)).toEqual(["Related"]);
  });

  it("context が無ければ null context / 空 related", async () => {
    const signalStore = new MemorySignalStore();
    const contextStore = new MemoryContextStore();
    const s = await signalStore.insert(USER, {
      source: "hn",
      url: "https://example.com/1",
      title: "T",
      fetchedAt: "2026-07-01T00:00:00.000Z",
    });
    const detail = await fetchSignalDetail(USER, s!.id, { signalStore, contextStore });
    expect(detail?.context).toBeNull();
    expect(detail?.related).toEqual([]);
  });

  it("他ユーザーのシグナルには触れない (not found)", async () => {
    const signalStore = new MemorySignalStore();
    const contextStore = new MemoryContextStore();
    const s = await signalStore.insert("other-user", {
      source: "hn",
      url: "https://example.com/1",
      title: "T",
      fetchedAt: "2026-07-01T00:00:00.000Z",
    });
    const detail = await fetchSignalDetail(USER, s!.id, { signalStore, contextStore });
    expect(detail).toBeNull();
  });
});
