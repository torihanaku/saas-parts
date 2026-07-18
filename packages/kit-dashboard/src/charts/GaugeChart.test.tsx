// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { GaugeChart } from "./GaugeChart";

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

describe("GaugeChart", () => {
  it("renders the gauge arcs and needle without crashing", () => {
    const { container } = render(
      <GaugeChart width={300} height={220} animated={false} value={75} title="達成率" />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    // 背景トラック + 3 ゾーン + 値アーク + ニードル = 6 以上の <path>
    expect(container.querySelectorAll("path").length).toBeGreaterThanOrEqual(5);
    // ニードル/センタードットのような主要要素も存在
    expect(container.querySelector("circle")).toBeTruthy();
  });

  it("themes structural fills/strokes with CSS-variable colors (theme-following)", () => {
    const { container } = render(
      <GaugeChart width={300} height={220} animated={false} value={75} showTarget targetValue={80} />,
    );
    // 背景トラックの塗りは --border 由来（ダーク追従の担保）
    const track = container.querySelector("path");
    expect(track?.getAttribute("fill")).toContain("var(--border");
    // ニードル/ターゲットマーカーの色は --foreground 由来
    const foregroundStroke = Array.from(container.querySelectorAll("line, path")).some(
      (el) =>
        (el.getAttribute("stroke") ?? "").includes("var(--foreground") ||
        (el.getAttribute("fill") ?? "").includes("var(--foreground"),
    );
    expect(foregroundStroke).toBe(true);
  });
});
