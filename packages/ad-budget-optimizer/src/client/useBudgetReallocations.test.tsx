// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup, act } from "@testing-library/react";
import {
  useBudgetReallocations,
  useExecuteReallocation,
  useRejectReallocation,
  type ApiClient,
  type BudgetReallocationDto,
} from "./useBudgetReallocations";

afterEach(cleanup);

function makeApi(over: Partial<ApiClient> = {}): ApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    ...over,
  };
}

describe("useBudgetReallocations", () => {
  it("loads history and exposes data", async () => {
    const rows = [{ id: "r1" }] as BudgetReallocationDto[];
    const api = makeApi({ get: vi.fn().mockResolvedValue({ reallocations: rows }) });
    const { result } = renderHook(() => useBudgetReallocations(api, "proposed"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(rows);
    expect(api.get).toHaveBeenCalledWith("/budget-reallocation/history?status=proposed");
  });

  it("captures errors", async () => {
    const api = makeApi({ get: vi.fn().mockRejectedValue(new Error("boom")) });
    const { result } = renderHook(() => useBudgetReallocations(api));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("boom");
    expect(result.current.data).toEqual([]);
  });
});

describe("useExecuteReallocation", () => {
  it("posts with the reauth header and returns true", async () => {
    const api = makeApi({ post: vi.fn().mockResolvedValue({}) });
    const { result } = renderHook(() => useExecuteReallocation(api));
    let ok = false;
    await act(async () => {
      ok = await result.current.execute("r1", "tok");
    });
    expect(ok).toBe(true);
    expect(api.post).toHaveBeenCalledWith(
      "/budget-reallocation/execute",
      { reallocationId: "r1", riskAcknowledged: true },
      { headers: { "X-Reauth-Token": "tok" } },
    );
  });
});

describe("useRejectReallocation", () => {
  it("patches with rejected status", async () => {
    const api = makeApi({ patch: vi.fn().mockResolvedValue({}) });
    const { result } = renderHook(() => useRejectReallocation(api));
    await act(async () => {
      await result.current.reject("r1", "too risky");
    });
    expect(api.patch).toHaveBeenCalledWith("/budget-reallocation/r1", { status: "rejected", rollbackReason: "too risky" });
  });
});
