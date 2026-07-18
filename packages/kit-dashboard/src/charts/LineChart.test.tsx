// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { LineChart } from "./LineChart";
import type { TimeSeriesPoint } from "../lib/types";

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

const SAMPLE: TimeSeriesPoint[] = [
  { date: new Date(2024, 0, 1), value: 100 },
  { date: new Date(2024, 1, 1), value: 180 },
  { date: new Date(2024, 2, 1), value: 140 },
  { date: new Date(2024, 3, 1), value: 220 },
  { date: new Date(2024, 4, 1), value: 260 },
];

describe("LineChart", () => {
  it("renders a line path and dots per data point without crashing", () => {
    const { container } = render(
      <LineChart width={600} height={300} animated={false} data={SAMPLE} />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    // 1系列 → 1本の line-path
    expect(container.querySelectorAll("path.line-path")).toHaveLength(1);
    // showDots 既定 true → 各データ点に circle
    expect(container.querySelectorAll("circle.dot-0")).toHaveLength(SAMPLE.length);
  });

  it("themes axis and data labels with CSS-variable colors (theme-following)", () => {
    const { container } = render(
      <LineChart
        width={600}
        height={300}
        animated={false}
        showDataLabels
        data={SAMPLE}
      />,
    );
    // 軸テキストは --muted-foreground を参照する（ダーク追従の担保）
    const axisText = container.querySelector("g text");
    expect(axisText?.getAttribute("fill")).toContain("var(--muted-foreground");
    // データラベルも var(...) 由来のミュートカラー
    const dataLabel = container.querySelector("text.data-label-0");
    expect(dataLabel?.getAttribute("fill")).toContain("var(");
  });
});
