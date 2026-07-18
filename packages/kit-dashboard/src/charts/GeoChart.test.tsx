// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { GeoChart, type GeoDataPoint } from "./GeoChart";

// 最小の world topojson（1つの三角形ポリゴンを持つ "countries" オブジェクト）。
// feature.id を "392"(日本のダミー) にして着色経路も通す。
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
  // CDN からの地図取得を stub（jsdom では実 fetch できない）。
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({ json: () => Promise.resolve(WORLD_TOPO) }),
  ) as unknown as typeof fetch;
});

afterEach(cleanup);

const DATA: GeoDataPoint[] = [{ id: "392", label: "日本", value: 4500 }];

describe("GeoChart", () => {
  it("renders an svg with country paths without crashing", async () => {
    const { container } = render(
      <GeoChart data={DATA} region="world" width={600} height={380} />,
    );
    await waitFor(() =>
      expect(container.querySelector("svg[aria-label='地図チャート']")).toBeTruthy(),
    );
    await waitFor(() =>
      expect(container.querySelectorAll("path.country").length).toBeGreaterThan(0),
    );
  });

  it("fills unmatched land with a CSS-variable color (theme-following)", async () => {
    const { container } = render(
      <GeoChart
        data={[]}
        region="world"
        width={600}
        height={380}
        colorIndex={0}
      />,
    );
    await waitFor(() =>
      expect(container.querySelector("path.country")).toBeTruthy(),
    );
    const path = container.querySelector("path.country");
    // 値なし領域は CHART_SURFACE = var(--card ...) 参照
    expect(path?.getAttribute("fill")).toContain("var(");
    // 境界線も theme トークン(var(--border ...))
    expect(path?.getAttribute("stroke")).toContain("var(");
  });
});
