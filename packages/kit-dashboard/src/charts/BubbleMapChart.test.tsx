// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { BubbleMapChart, type BubbleMapPoint } from "./BubbleMapChart";

// 最小の world topojson（陸地ベースを1つ描くだけで十分）。
const WORLD_TOPO = {
  type: "Topology",
  arcs: [
    [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 0],
    ],
  ],
  transform: { scale: [1, 1], translate: [0, 0] },
  objects: {
    countries: {
      type: "GeometryCollection",
      geometries: [{ type: "Polygon", id: "392", arcs: [[0]] }],
    },
  },
};

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({ json: () => Promise.resolve(WORLD_TOPO) }),
  ) as unknown as typeof fetch;
});

afterEach(cleanup);

const DATA: BubbleMapPoint[] = [
  { id: "tokyo", label: "東京", value: 2800, lat: 35.6762, lon: 139.6503 },
  { id: "newyork", label: "NY", value: 3500, lat: 40.7128, lon: -74.006 },
];

describe("BubbleMapChart", () => {
  it("renders one <circle.bubble> per data point without crashing", async () => {
    const { container } = render(
      <BubbleMapChart data={DATA} region="world" width={600} height={380} />,
    );
    await waitFor(() =>
      expect(
        container.querySelector("svg[aria-label='バブルマップチャート']"),
      ).toBeTruthy(),
    );
    await waitFor(() =>
      expect(container.querySelectorAll("circle.bubble")).toHaveLength(2),
    );
  });

  it("themes base land and bubble strokes with CSS-variable colors", async () => {
    const { container } = render(
      <BubbleMapChart data={DATA} region="world" width={600} height={380} />,
    );
    await waitFor(() =>
      expect(container.querySelector("path.base-country")).toBeTruthy(),
    );
    // 陸地の基調は CHART_SURFACE = var(--card ...)
    const base = container.querySelector("path.base-country");
    expect(base?.getAttribute("fill")).toContain("var(");
    // バブルの stroke も theme トークン(var(--border ...))
    await waitFor(() =>
      expect(container.querySelector("circle.bubble")).toBeTruthy(),
    );
    const bubble = container.querySelector("circle.bubble");
    expect(bubble?.getAttribute("stroke")).toContain("var(");
  });
});
