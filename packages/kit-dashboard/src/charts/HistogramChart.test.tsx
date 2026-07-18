// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { HistogramChart } from "./HistogramChart";

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

const SAMPLE = [10, 20, 22, 25, 30, 33, 35, 40, 42, 50, 55, 60, 70, 80, 90, 100];

describe("HistogramChart", () => {
  it("renders histogram bars without crashing", () => {
    const { container } = render(
      <HistogramChart
        width={640}
        height={300}
        animated={false}
        data={SAMPLE}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    // ビンごとに1本の .hist-bar が出る
    expect(container.querySelectorAll("rect.hist-bar").length).toBeGreaterThan(0);
  });

  it("themes bars and axis with CSS-variable colors (theme-following)", () => {
    const { container } = render(
      <HistogramChart
        width={640}
        height={300}
        animated={false}
        data={SAMPLE}
      />,
    );
    // 単一分布の棒は縦 tint グラデ塗り（url(#kit-tint…)）。テーマ追従は gradient stop の var(...) が担う。
    const bar = container.querySelector("rect.hist-bar");
    expect(bar?.getAttribute("fill")).toMatch(/^url\(#kit-tint/);
    const stop = container.querySelector("linearGradient stop");
    expect(stop?.getAttribute("stop-color")).toContain("var(");
    // 軸テキストは --muted-foreground を参照（themeAxis 適用）
    const axisText = container.querySelector("g text");
    expect(axisText?.getAttribute("fill")).toContain("var(--muted-foreground");
  });
});
