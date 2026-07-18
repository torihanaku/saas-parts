// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TreemapChart } from "./TreemapChart";

beforeAll(() => {
  // jsdom には ResizeObserver が無い。width を明示するので中身は空実装で十分。
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

describe("TreemapChart", () => {
  it("renders one <g.treemap-cell> per non-root node without crashing", () => {
    const { container } = render(
      <TreemapChart
        width={600}
        height={320}
        animated={false}
        data={[
          { id: "root", label: "ルート" },
          { id: "a", label: "A", parent: "root", value: 100 },
          { id: "b", label: "B", parent: "root", value: 60 },
          { id: "c", label: "C", parent: "root", value: 40 },
        ]}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    // depth 1..maxDepth のノード（root 除く3件）が cell として出る
    expect(container.querySelectorAll("g.treemap-cell")).toHaveLength(3);
  });

  it("draws a rect per cell and labels use theme-aware colors", () => {
    const { container } = render(
      <TreemapChart width={600} height={320} animated={false} />,
    );
    // 各セルに rect が1つ
    const rects = container.querySelectorAll("g.treemap-cell rect");
    expect(rects.length).toBeGreaterThan(0);
    // ラベルテキストが存在し fill を持つ（明暗解決 or var(...) 由来）
    const label = container.querySelector("g.treemap-cell text");
    expect(label?.getAttribute("fill")).toBeTruthy();
  });
});
