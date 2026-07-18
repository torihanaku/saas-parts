// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { WordCloudChart } from "./WordCloudChart";

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

describe("WordCloudChart", () => {
  it("renders one <text> per word without crashing", () => {
    const { container } = render(
      <WordCloudChart
        data={[
          { word: "SaaS", count: 90 },
          { word: "デモ", count: 60 },
          { word: "CRM", count: 40 },
        ]}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("svg text")).toHaveLength(3);
  });

  it("colors words via the theme-following palette when no named scheme", () => {
    const { container } = render(
      <WordCloudChart
        colorScheme="__none__"
        data={[{ word: "テーマ", count: 80 }]}
      />,
    );
    // 未知スキーム → getGlobalChartColors() の var(--chart-N) にフォールバック
    const word = container.querySelector("svg text");
    expect(word?.getAttribute("fill")).toContain("var(--chart-");
  });

  it("falls back to sample data when no data prop is given", () => {
    const { container } = render(<WordCloudChart dataCategory="leads" />);
    expect(container.querySelectorAll("svg text").length).toBeGreaterThan(0);
  });
});
