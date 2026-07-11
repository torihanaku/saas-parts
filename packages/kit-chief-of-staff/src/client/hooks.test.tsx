// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  buildFeedQuery,
  useCosAsk,
  useCosFeed,
  useCosTasks,
  type CosApiClient,
} from "./hooks";

afterEach(() => cleanup());

function makeApi(overrides: Partial<CosApiClient> = {}): CosApiClient {
  return {
    get: vi.fn(async () => ({}) as never),
    post: vi.fn(async () => ({}) as never),
    patch: vi.fn(async () => ({}) as never),
    ...overrides,
  };
}

describe("buildFeedQuery", () => {
  it("フィルタをクエリ文字列にする（空なら空文字）", () => {
    expect(buildFeedQuery({})).toBe("");
    expect(
      buildFeedQuery({ sourceType: "slack", sinceIso: "2026-07-01T00:00:00Z", limit: 10 }),
    ).toBe("?sourceType=slack&sinceIso=2026-07-01T00%3A00%3A00Z&limit=10");
  });
});

describe("useCosFeed", () => {
  it("マウント時に /cos/feed を取得して items を返す", async () => {
    const api = makeApi({
      get: vi.fn(async () => ({ items: [{ id: "d1" }] }) as never),
    });
    const { result } = renderHook(() => useCosFeed(api));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toEqual([{ id: "d1" }]);
    expect(api.get).toHaveBeenCalledWith("/cos/feed");
  });

  it("失敗時は error を設定して items を空にする", async () => {
    const api = makeApi({
      get: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const { result } = renderHook(() => useCosFeed(api));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("boom");
    expect(result.current.items).toEqual([]);
  });
});

describe("useCosAsk", () => {
  it("ask が POST /cos/ask して result を保持する", async () => {
    const answer = { answer: "回答", citations: [], hasAnswer: true };
    const api = makeApi({ post: vi.fn(async () => answer as never) });
    const { result } = renderHook(() => useCosAsk(api));

    await act(async () => {
      const res = await result.current.ask("先週どうだった？", 5);
      expect(res).toEqual(answer);
    });
    expect(api.post).toHaveBeenCalledWith("/cos/ask", {
      question: "先週どうだった？",
      topK: 5,
    });
    expect(result.current.result).toEqual(answer);

    act(() => result.current.reset());
    expect(result.current.result).toBeNull();
  });
});

describe("useCosTasks", () => {
  it("pending タスクを取得する", async () => {
    const api = makeApi({
      get: vi.fn(async () => ({ items: [{ id: "task-1", status: "pending_review" }] }) as never),
    });
    const { result } = renderHook(() => useCosTasks(api));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.items).toHaveLength(1);
    expect(api.get).toHaveBeenCalledWith("/cos/tasks/pending");
  });
});
