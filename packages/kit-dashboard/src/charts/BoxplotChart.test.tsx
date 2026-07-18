// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BoxplotChart } from "./BoxplotChart";

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

const DATA = [
  { label: "A", min: 20, q1: 45, median: 65, q3: 80, max: 110, outliers: [5, 125] },
  { label: "B", min: 30, q1: 55, median: 75, q3: 90, max: 120 },
  { label: "C", min: 25, q1: 50, median: 70, q3: 88, max: 115 },
];

describe("BoxplotChart", () => {
  it("renders one <rect.bp-box> per series without crashing (vertical)", () => {
    const { container } = render(
      <BoxplotChart width={600} height={320} animated={false} data={DATA} />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("rect.bp-box")).toHaveLength(3);
  });

  it("renders horizontal orientation without crashing", () => {
    const { container } = render(
      <BoxplotChart
        width={600}
        height={320}
        animated={false}
        orientation="horizontal"
        data={DATA}
      />,
    );
    expect(container.querySelectorAll("rect.bp-box")).toHaveLength(3);
  });

  it("themes axis and box fill with CSS-variable colors (theme-following)", () => {
    const { container } = render(
      <BoxplotChart width={600} height={320} animated={false} data={DATA} />,
    );
    // 軸テキストは --muted-foreground を参照する（ダーク追従の担保）
    const axisText = container.querySelector("g text");
    expect(axisText?.getAttribute("fill")).toContain("var(--muted-foreground");
    // ボックスは tint グラデ塗り（url(#kit-tint…)）。テーマ追従は gradient stop の var(...) が担う。
    const box = container.querySelector("rect.bp-box");
    expect(box?.getAttribute("fill")).toMatch(/^url\(#kit-tint/);
    const stop = container.querySelector("linearGradient stop");
    expect(stop?.getAttribute("stop-color")).toContain("var(");
  });
});
