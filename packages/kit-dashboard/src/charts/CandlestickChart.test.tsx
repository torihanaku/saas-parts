// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CandlestickChart } from "./CandlestickChart";

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

describe("CandlestickChart", () => {
  it("renders one candle group and volume bar per data point without crashing", () => {
    const { container } = render(
      <CandlestickChart
        width={600}
        height={320}
        animated={false}
        data={[
          { date: "1月", open: 100, high: 125, low: 95, close: 118 },
          { date: "2月", open: 118, high: 130, low: 110, close: 108 },
          { date: "3月", open: 108, high: 120, low: 100, close: 115 },
        ]}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("g.candle-group")).toHaveLength(3);
    expect(container.querySelectorAll("rect.vol-bar")).toHaveLength(3);
  });

  it("colors candles with theme tokens (bull=positive, bear=negative)", () => {
    const { container } = render(
      <CandlestickChart width={600} height={320} animated={false} />,
    );
    // 軸テキストは --muted-foreground を参照する（ダーク追従の担保）
    const axisText = container.querySelector("g text");
    expect(axisText?.getAttribute("fill")).toContain("var(--muted-foreground");
    // ローソク実体は共通の縦グラデ（fillFor）で塗る＝fill は url(#…) 参照。
    const body = container.querySelector("rect.candle-body");
    expect(body?.getAttribute("fill")).toMatch(/^url\(#/);
    // グラデの stop-color が positive/negative トークン由来（ダーク追従の担保）。
    const stopColors = Array.from(container.querySelectorAll("stop")).map((s) =>
      s.getAttribute("stop-color"),
    );
    expect(stopColors.some((c) => c?.includes("var(--chart-"))).toBe(true);
  });
});
