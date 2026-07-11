// @vitest-environment jsdom
/**
 * 出典テスト: dev-dashboard-v2 tests/hooks/useBrandDna.test.ts /
 * tests/hooks/useCompanyDnaStats.test.ts のコアシナリオを注入 API 向けに再構成。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import {
  createPatternDnaHooks,
  DEFAULT_PATTERN_DNA_ENDPOINTS,
  type PatternDnaClientApi,
} from "./hooks.js";
import type { DnaStats } from "../types.js";
import type { PatternAlertsResult } from "../pattern-alerts.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const STATS: DnaStats = {
  total: 3,
  byType: { content: 2, brand_voice: 1, customer_reaction: 0, seasonal: 0, glossary: 0 },
  meanConfidence: 0.8,
};

const ALERTS: PatternAlertsResult = {
  failureWarnings: [
    {
      dnaType: "content",
      key: "k",
      source: "manual",
      confidence: 1,
      similarity: 0.5,
      excerpt: "x",
    },
  ],
  successRecommendations: [],
  scanned: 10,
  threshold: 0.2,
};

function apiStub(overrides: Partial<PatternDnaClientApi> = {}): PatternDnaClientApi {
  return {
    get: vi.fn(async () => STATS as never),
    post: vi.fn(async () => ALERTS as never),
    ...overrides,
  };
}

describe("useDnaStats", () => {
  it("fetches stats from the default endpoint and exposes refetch", async () => {
    const api = apiStub();
    const hooks = createPatternDnaHooks(api);
    const { result } = renderHook(() => hooks.useDnaStats());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(STATS);
    expect(result.current.error).toBeNull();
    expect(api.get).toHaveBeenCalledWith(DEFAULT_PATTERN_DNA_ENDPOINTS.stats);
  });

  it("surfaces fetch errors without throwing", async () => {
    const api = apiStub({ get: vi.fn(async () => Promise.reject(new Error("boom"))) });
    const hooks = createPatternDnaHooks(api);
    const { result } = renderHook(() => hooks.useDnaStats());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error?.message).toBe("boom");
  });

  it("honours endpoint overrides", async () => {
    const api = apiStub();
    const hooks = createPatternDnaHooks(api, { stats: "/custom/stats" });
    renderHook(() => hooks.useDnaStats());
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/custom/stats"));
  });
});

describe("usePatternAlerts (imperative)", () => {
  it("posts the check payload and stores the result", async () => {
    const api = apiStub();
    const hooks = createPatternDnaHooks(api);
    const { result } = renderHook(() => hooks.usePatternAlerts());

    expect(result.current.data).toBeNull();
    await act(async () => {
      const res = await result.current.check({ draftText: "下書きテキスト", maxHits: 5 });
      expect(res).toEqual(ALERTS);
    });
    expect(result.current.data).toEqual(ALERTS);
    expect(api.post).toHaveBeenCalledWith(DEFAULT_PATTERN_DNA_ENDPOINTS.alertsCheck, {
      draftText: "下書きテキスト",
      maxHits: 5,
    });
  });

  it("captures errors and reset() clears state", async () => {
    const api = apiStub({ post: vi.fn(async () => Promise.reject(new Error("500"))) });
    const hooks = createPatternDnaHooks(api);
    const { result } = renderHook(() => hooks.usePatternAlerts());

    await act(async () => {
      const res = await result.current.check({ draftText: "x" });
      expect(res).toBeNull();
    });
    expect(result.current.error?.message).toBe("500");

    act(() => result.current.reset());
    expect(result.current.error).toBeNull();
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});

describe("useAutoPatternAlerts (debounced)", () => {
  it("skips short drafts and fires after the debounce for long ones", async () => {
    vi.useFakeTimers();
    try {
      const api = apiStub();
      const hooks = createPatternDnaHooks(api);
      const longDraft = "これは十分に長い下書きテキストです。".repeat(3);

      const { result, rerender } = renderHook(
        ({ draftText }) => hooks.useAutoPatternAlerts({ draftText, debounceMs: 100 }),
        { initialProps: { draftText: "短い" } },
      );

      await act(async () => {
        vi.advanceTimersByTime(150);
      });
      expect(api.post).not.toHaveBeenCalled(); // minLength 未満

      rerender({ draftText: longDraft });
      await act(async () => {
        vi.advanceTimersByTime(150);
      });
      expect(api.post).toHaveBeenCalledTimes(1);
      expect(result.current.data).toEqual(ALERTS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays idle when disabled", async () => {
    vi.useFakeTimers();
    try {
      const api = apiStub();
      const hooks = createPatternDnaHooks(api);
      renderHook(() =>
        hooks.useAutoPatternAlerts({
          draftText: "これは十分に長い下書きテキストです。".repeat(3),
          enabled: false,
          debounceMs: 100,
        }),
      );
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(api.post).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("usePredict / useRecommend", () => {
  it("posts to the predict / recommend endpoints", async () => {
    const api = apiStub({ post: vi.fn(async () => ({ ok: true }) as never) });
    const hooks = createPatternDnaHooks(api);

    const predict = renderHook(() => hooks.usePredict());
    await act(async () => {
      await predict.result.current.predict("本文", "blog");
    });
    expect(api.post).toHaveBeenCalledWith(DEFAULT_PATTERN_DNA_ENDPOINTS.predict, {
      contentText: "本文",
      channel: "blog",
    });

    const recommend = renderHook(() => hooks.useRecommend());
    await act(async () => {
      await recommend.result.current.recommend("本文", ["blog", "email"]);
    });
    expect(api.post).toHaveBeenCalledWith(DEFAULT_PATTERN_DNA_ENDPOINTS.recommend, {
      contentText: "本文",
      candidateChannels: ["blog", "email"],
    });
  });
});

describe("useSnapshots", () => {
  it("builds the query string from filters", async () => {
    const api = apiStub({ get: vi.fn(async () => [] as never) });
    const hooks = createPatternDnaHooks(api);
    renderHook(() =>
      hooks.useSnapshots({ approvalStatus: "approved", limit: 10, offset: 20 }),
    );
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        `${DEFAULT_PATTERN_DNA_ENDPOINTS.snapshots}?approvalStatus=approved&limit=10&offset=20`,
      ),
    );
  });
});
