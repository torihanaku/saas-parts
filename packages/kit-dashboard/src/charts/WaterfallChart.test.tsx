// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { WaterfallChart } from "./WaterfallChart";

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

describe("WaterfallChart", () => {
  it("renders one <rect.wf-bar> per data point without crashing", () => {
    const { container } = render(
      <WaterfallChart
        width={600}
        height={320}
        animated={false}
        data={[
          { label: "開始", value: 800, type: "total" },
          { label: "増加", value: 120 },
          { label: "減少", value: -50 },
          { label: "終了", value: 870, type: "total" },
        ]}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("rect.wf-bar")).toHaveLength(4);
  });

  it("themes axis/labels with CSS-variable colors (theme-following)", () => {
    const { container } = render(
      <WaterfallChart width={600} height={320} animated={false} />,
    );
    // 軸テキストは --muted-foreground を参照する（ダーク追従の担保）
    const axisText = container.querySelector("g text");
    expect(axisText?.getAttribute("fill")).toContain("var(--muted-foreground");
    // バーは共通の標準塗り fillFor（url(#…)）。テーマ追従は gradient stop の var(...) が担う。
    const bar = container.querySelector("rect.wf-bar");
    expect(bar?.getAttribute("fill")).toMatch(/^url\(#/);
    const stop = container.querySelector("linearGradient stop");
    expect(stop?.getAttribute("stop-color")).toContain("var(");
  });
});
