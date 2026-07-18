// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AreaChart } from "./AreaChart";
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
  { date: new Date("2026-01-01"), value: 100 },
  { date: new Date("2026-02-01"), value: 140 },
  { date: new Date("2026-03-01"), value: 120 },
  { date: new Date("2026-04-01"), value: 180 },
];

describe("AreaChart", () => {
  it("renders an area + line path without crashing (standard variant)", () => {
    const { container } = render(
      <AreaChart width={600} height={300} animated={false} data={SAMPLE} />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    // 少なくとも area と line の 2 本の path が出る
    expect(container.querySelectorAll("path").length).toBeGreaterThanOrEqual(2);
  });

  it("themes axis text with CSS-variable colors (theme-following)", () => {
    const { container } = render(
      <AreaChart width={600} height={300} animated={false} data={SAMPLE} />,
    );
    // 軸テキストは --muted-foreground を参照する（ダーク追従の担保）
    const axisText = container.querySelector("g text");
    expect(axisText?.getAttribute("fill")).toContain("var(--muted-foreground");
  });

  it("renders stacked variant with a legend without crashing", () => {
    const { container } = render(
      <AreaChart
        width={600}
        height={300}
        animated={false}
        variant="stacked"
        data={SAMPLE}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    // stacked mock は 4 系列 → area/line で 8 本以上の path
    expect(container.querySelectorAll("path").length).toBeGreaterThanOrEqual(8);
  });
});
