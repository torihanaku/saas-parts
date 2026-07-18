// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PieChart } from "./PieChart";
import type { DataPoint } from "../lib/types";

// PieChart は width prop を持たず ResizeObserver 経由でのみサイズを得る。
// jsdom の getBoundingClientRect は 0 を返すので、非ゼロ幅をスタブしてから計測させる。
const originalGBCR = Element.prototype.getBoundingClientRect;

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: 400,
      height: 300,
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON() {},
    } as DOMRect;
  };
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalGBCR;
});

afterEach(cleanup);

const SAMPLE: DataPoint[] = [
  { label: "A", value: 40 },
  { label: "B", value: 30 },
  { label: "C", value: 20 },
  { label: "D", value: 10 },
];

describe("PieChart", () => {
  it("renders one <path.pie-slice> per data point without crashing", () => {
    const { container } = render(
      <PieChart data={SAMPLE} animationDuration={0} legendPosition="none" />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("path.pie-slice")).toHaveLength(4);
  });

  it("fills slices and center label with CSS-variable colors (theme-following)", () => {
    const { container } = render(
      <PieChart
        data={SAMPLE}
        innerRadius={60}
        showCenterLabel
        animationDuration={0}
        legendPosition="none"
      />,
    );
    // スライスの stroke は --card（サーフェス）を参照＝ダーク追従
    const slice = container.querySelector("path.pie-slice");
    expect(slice?.getAttribute("stroke")).toContain("var(--card");
    // 中央ラベルのテキストも var(...) 由来（--foreground）
    const centerText = container.querySelector("g.pie-center-label text");
    expect(centerText?.getAttribute("style") ?? "").toContain("var(");
  });
});
