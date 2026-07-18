// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BarChart } from "./BarChart";

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

describe("BarChart", () => {
  it("renders one <rect.bar> per data point (single vertical) without crashing", () => {
    const { container } = render(
      <BarChart
        width={600}
        height={300}
        animated={false}
        animationDuration={0}
        data={[
          { label: "A", value: 120 },
          { label: "B", value: 80 },
          { label: "C", value: 200 },
        ]}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("rect.bar")).toHaveLength(3);
  });

  it("themes axis with CSS-variable colors (theme-following)", () => {
    const { container } = render(
      <BarChart
        width={600}
        height={300}
        animated={false}
        animationDuration={0}
        data={[
          { label: "A", value: 120 },
          { label: "B", value: 80 },
        ]}
      />,
    );
    // 軸テキストは --muted-foreground を参照する（ダーク追従の担保）
    const axisText = container.querySelector("g text");
    expect(axisText?.getAttribute("fill")).toContain("var(--muted-foreground");
    // バーの塗りも var(...) 由来
    const bar = container.querySelector("rect.bar");
    expect(bar?.getAttribute("fill")).toContain("var(");
  });

  it("renders grouped multi-series bars (one rect per series per category)", () => {
    const { container } = render(
      <BarChart
        width={600}
        height={300}
        animated={false}
        animationDuration={0}
        variant="grouped"
        series={[
          { key: "s1", label: "Series 1" },
          { key: "s2", label: "Series 2" },
        ]}
        categories={["Q1", "Q2"]}
        seriesData={{
          Q1: { s1: 10, s2: 20 },
          Q2: { s1: 30, s2: 40 },
        }}
      />,
    );
    // 2 categories x 2 series = 4 bars
    expect(container.querySelectorAll("rect.bar")).toHaveLength(4);
  });
});
