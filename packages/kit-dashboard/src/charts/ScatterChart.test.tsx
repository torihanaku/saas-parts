// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ScatterChart } from "./ScatterChart";

beforeAll(() => {
  // jsdom には ResizeObserver が無い。width を明示するので空実装で十分。
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

describe("ScatterChart", () => {
  it("renders one <circle.scatter-dot> per data point without crashing", () => {
    const { container } = render(
      <ScatterChart
        width={600}
        height={300}
        animated={false}
        data={[
          { x: 10, y: 20, label: "a", series: "A" },
          { x: 30, y: 40, label: "b", series: "B" },
          { x: 50, y: 15, label: "c", series: "A" },
        ]}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("circle.scatter-dot")).toHaveLength(3);
  });

  it("themes axis with CSS-variable colors and dots use var() fills (theme-following)", () => {
    const { container } = render(
      <ScatterChart width={600} height={300} animated={false} />,
    );
    const axisText = container.querySelector("g text");
    expect(axisText?.getAttribute("fill")).toContain("var(--muted-foreground");
    const dot = container.querySelector("circle.scatter-dot");
    expect(dot?.getAttribute("fill")).toContain("var(");
  });

  it("renders a trendline and equation when showTrendline is set", () => {
    const { container } = render(
      <ScatterChart width={600} height={300} animated={false} showTrendline />,
    );
    // clip-path付き line がトレンドライン
    const trend = container.querySelector("line[clip-path]");
    expect(trend).toBeTruthy();
    expect(trend?.getAttribute("stroke")).toContain("var(");
  });
});
