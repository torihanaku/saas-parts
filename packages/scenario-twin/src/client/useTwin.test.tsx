// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act, cleanup } from "@testing-library/react";
import {
  useTwinSimulate,
  useTwinBacktest,
  useTwinBaseline,
  type TwinApiClient,
} from "./useTwin.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeApi(over?: Partial<TwinApiClient>): TwinApiClient {
  return {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    ...over,
  };
}

describe("useTwinSimulate", () => {
  it("returns the simulation from the POST response", async () => {
    const api = makeApi({
      post: vi.fn().mockResolvedValue({ success: true, simulation: { id: "sim-1" } }),
    });
    const { result } = renderHook(() => useTwinSimulate(api));
    let sim: { id: string } | undefined;
    await act(async () => {
      sim = (await result.current.run({
        scenarioName: "s",
        scenarioInputs: {},
      })) as { id: string };
    });
    expect(sim?.id).toBe("sim-1");
  });
});

describe("useTwinBacktest", () => {
  it("loads records + accuracy on mount", async () => {
    const api = makeApi({
      get: vi.fn(async (path: string) => {
        if (path.includes("accuracy"))
          return { success: true, accuracy: [{ metric: "pv" }] };
        return { success: true, records: [{ id: "bt1" }] };
      }) as unknown as TwinApiClient["get"],
    });
    const { result } = renderHook(() => useTwinBacktest(api));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.records).toHaveLength(1);
    expect(result.current.accuracy).toHaveLength(1);
  });
});

describe("useTwinBaseline", () => {
  it("treats a 404 as no baseline rather than an error", async () => {
    const err = Object.assign(new Error("not found"), { status: 404 });
    const api = makeApi({ get: vi.fn().mockRejectedValue(err) });
    const { result } = renderHook(() => useTwinBaseline(api));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });
});
