// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ScoreCard } from "./ScoreCard";

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

describe("ScoreCard", () => {
  it("renders title/value and a sparkline <svg> without crashing", () => {
    const { container, getByText } = render(
      <ScoreCard
        title="MRR"
        value={1234}
        previousValue={1000}
        sparklineData={[1, 2, 3, 2, 4, 5]}
      />,
    );
    // 値が描画される
    expect(getByText("1234")).toBeTruthy();
    // スパークラインの svg が出る
    expect(container.querySelector("svg")).toBeTruthy();
    // トレンドチップ（上昇）
    expect(container.textContent).toContain("↑");
  });

  it("colors sparkline stroke with a theme var (positive trend)", () => {
    const { container } = render(
      <ScoreCard
        title="ARR"
        value={200}
        previousValue={100}
        sparklineData={[1, 2, 3, 4]}
      />,
    );
    // 上昇トレンド → sparklineUpColor 既定は CHART_POSITIVE = var(--chart-positive)
    const strokedPath = Array.from(
      container.querySelectorAll("path"),
    ).find((p) => p.getAttribute("stroke")?.includes("var("));
    expect(strokedPath?.getAttribute("stroke")).toContain(
      "var(--chart-positive",
    );
  });

  it("renders a progress-bar variant with theme-var fill", () => {
    const { container } = render(
      <ScoreCard title="達成率" value={60} variant="progress-bar" />,
    );
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.style.background).toContain("var(");
  });
});
