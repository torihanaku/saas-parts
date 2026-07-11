// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import {
  useExperiments,
  useExperimentDetail,
  type AbApiClient,
} from "./useAbTesting.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useExperiments", () => {
  it("reads an { experiments } response", async () => {
    const api: AbApiClient = {
      get: vi.fn().mockResolvedValue({ experiments: [{ id: "e1" }] }),
    };
    const { result } = renderHook(() => useExperiments(api));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(1);
  });

  it("reads a bare array response", async () => {
    const api: AbApiClient = {
      get: vi.fn().mockResolvedValue([{ id: "e1" }, { id: "e2" }]),
    };
    const { result } = renderHook(() => useExperiments(api));
    await waitFor(() => expect(result.current.data).toHaveLength(2));
  });

  it("surfaces an error and empty data on failure", async () => {
    const api: AbApiClient = {
      get: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const { result } = renderHook(() => useExperiments(api));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toEqual([]);
  });
});

describe("useExperimentDetail", () => {
  it("fetches variants and winner", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/variants")) return { variants: [{ id: "v1" }] };
      return { winner: { experimentId: "e1", winnerVariantId: "v1" } };
    });
    const api: AbApiClient = { get: get as unknown as AbApiClient["get"] };
    const { result } = renderHook(() => useExperimentDetail(api, "e1"));
    await waitFor(() => expect(result.current.variants).toHaveLength(1));
    expect(result.current.winner?.winnerVariantId).toBe("v1");
  });

  it("stays idle for a null experimentId", async () => {
    const api: AbApiClient = { get: vi.fn() };
    const { result } = renderHook(() => useExperimentDetail(api, null));
    expect(result.current.variants).toEqual([]);
    expect(api.get).not.toHaveBeenCalled();
  });
});
