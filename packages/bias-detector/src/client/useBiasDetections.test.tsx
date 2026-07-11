// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import {
  useBiasDetections,
  useBiasDetectionsByDecision,
  type BiasApiClient,
} from "./useBiasDetections.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeApi(response: unknown): BiasApiClient {
  return { get: vi.fn().mockResolvedValue(response) };
}

describe("useBiasDetections", () => {
  it("maps history response into BiasDetection[]", async () => {
    const api = makeApi({
      detections: [
        {
          id: "d1",
          tenantId: "t1",
          decisionId: "dec-1",
          biasType: "sunk_cost",
          confidence: 0.9,
          evidence: { spent: 1 },
          recommendation: "stop",
          detectedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const { result } = renderHook(() => useBiasDetections(api, "dec-1"));
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    expect(result.current.data[0]!.biasType).toBe("sunk_cost");
    expect(result.current.data[0]!.tenantId).toBe("t1");
  });

  it("returns [] when disabled", async () => {
    const api = makeApi({ detections: [] });
    const { result } = renderHook(() => useBiasDetections(api, "dec-1", false));
    expect(result.current.data).toEqual([]);
    expect(api.get).not.toHaveBeenCalled();
  });

  it("surfaces empty data on fetch error", async () => {
    const api: BiasApiClient = {
      get: vi.fn().mockRejectedValue(new Error("403")),
    };
    const { result } = renderHook(() => useBiasDetections(api, "dec-1"));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toEqual([]);
  });
});

describe("useBiasDetectionsByDecision", () => {
  it("counts detections per decisionId", async () => {
    const api = makeApi({
      detections: [
        { decisionId: "a" },
        { decisionId: "a" },
        { decisionId: "b" },
        { decisionId: null },
      ],
    });
    const { result } = renderHook(() => useBiasDetectionsByDecision(api));
    await waitFor(() => expect(result.current.data.size).toBe(2));
    expect(result.current.data.get("a")).toBe(2);
    expect(result.current.data.get("b")).toBe(1);
  });
});
