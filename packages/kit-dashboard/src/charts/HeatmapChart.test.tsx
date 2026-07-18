// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { HeatmapChart } from "./HeatmapChart";

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

describe("HeatmapChart", () => {
  it("renders one <rect.heatmap-cell> per data point without crashing", () => {
    const { container } = render(
      <HeatmapChart
        width={600}
        height={320}
        rows={["A", "B"]}
        cols={["X", "Y", "Z"]}
        data={[
          { row: "A", col: "X", value: 10 },
          { row: "A", col: "Y", value: 20 },
          { row: "A", col: "Z", value: 30 },
          { row: "B", col: "X", value: 40 },
          { row: "B", col: "Y", value: 50 },
          { row: "B", col: "Z", value: 60 },
        ]}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("rect.heatmap-cell")).toHaveLength(6);
  });

  it("themes axis labels with CSS-variable colors (theme-following)", () => {
    const { container } = render(
      <HeatmapChart
        width={600}
        height={320}
        rows={["A", "B"]}
        cols={["X", "Y"]}
        data={[
          { row: "A", col: "X", value: 10 },
          { row: "A", col: "Y", value: 20 },
          { row: "B", col: "X", value: 30 },
          { row: "B", col: "Y", value: 40 },
        ]}
      />,
    );
    // 軸テキストは --muted-foreground を参照する（ダーク追従の担保）
    const axisText = container.querySelector("g text");
    expect(axisText?.getAttribute("fill")).toContain("var(--muted-foreground");
  });
});
