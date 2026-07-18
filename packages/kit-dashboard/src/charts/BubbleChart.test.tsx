// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BubbleChart } from "./BubbleChart";

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

const SAMPLE = [
  { x: 10, y: 20, size: 5, label: "A" },
  { x: 30, y: 15, size: 8, label: "B" },
  { x: 50, y: 40, size: 12, label: "C" },
];

describe("BubbleChart", () => {
  it("renders one <circle.bubble> per data point without crashing", () => {
    const { container } = render(
      <BubbleChart width={600} height={320} data={SAMPLE} />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll("circle.bubble")).toHaveLength(3);
  });

  it("themes axis with CSS-variable colors (theme-following)", () => {
    const { container } = render(
      <BubbleChart width={600} height={320} data={SAMPLE} />,
    );
    // 軸テキストは --muted-foreground を参照する（themeAxis が attr("fill") で当てる）
    const texts = Array.from(container.querySelectorAll("text"));
    const themed = texts.some((t) =>
      (t.getAttribute("fill") ?? "").includes("var(--muted-foreground"),
    );
    expect(themed).toBe(true);
    // 単一系列のバブルは PRIMARY 単色（var(--chart-1)）＝テーマ追従
    const bubble = container.querySelector("circle.bubble");
    expect(bubble?.getAttribute("fill") ?? "").toContain("var(");
  });
});
