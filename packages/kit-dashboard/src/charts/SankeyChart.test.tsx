// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  SankeyChart,
  SANKEY_DEFAULT_LINKS,
  SANKEY_DEFAULT_NODES,
} from "./SankeyChart";

beforeAll(() => {
  // jsdom には ResizeObserver が無い。width を明示するので中身は空実装で十分。
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  // jsdom は SVGPathElement.getTotalLength を実装しない（animatedLinks 経路で必要）。
  if (
    typeof SVGPathElement !== "undefined" &&
    typeof SVGPathElement.prototype.getTotalLength !== "function"
  ) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (SVGPathElement.prototype as any).getTotalLength = () => 100;
  }
});

afterEach(cleanup);

describe("SankeyChart", () => {
  it("renders one <path.link> per link and one <rect> per node without crashing", () => {
    const { container } = render(
      <SankeyChart
        width={700}
        height={400}
        nodes={SANKEY_DEFAULT_NODES}
        links={SANKEY_DEFAULT_LINKS}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    // 8 links in the default data set.
    expect(container.querySelectorAll("path.link")).toHaveLength(
      SANKEY_DEFAULT_LINKS.length,
    );
    // 8 nodes → 8 rects.
    expect(container.querySelectorAll("g.node rect")).toHaveLength(
      SANKEY_DEFAULT_NODES.length,
    );
  });

  it("colors nodes and labels with CSS-variable colors (theme-following)", () => {
    const { container } = render(
      <SankeyChart
        width={700}
        height={400}
        nodes={SANKEY_DEFAULT_NODES}
        links={SANKEY_DEFAULT_LINKS}
      />,
    );
    // ノード矩形は共通の縦グラデ（fillFor）で塗る＝fill は url(#…) 参照。
    const rect = container.querySelector("g.node rect");
    expect(rect?.getAttribute("fill")).toMatch(/^url\(#/);
    // グラデの stop-color が categoricalColor(i) = var(--chart-N) 由来（ダーク追従）。
    const stopColors = Array.from(container.querySelectorAll("stop")).map((s) =>
      s.getAttribute("stop-color"),
    );
    expect(stopColors.some((c) => c?.includes("var(--chart-"))).toBe(true);
    // ラベルは --foreground を参照（ダーク追従）。
    const label = container.querySelector("text.node-label");
    expect(label?.getAttribute("fill")).toContain("var(--foreground");
    // gray リンクは --muted-foreground を参照。
    const link = container.querySelector("path.link");
    expect(link?.getAttribute("stroke")).toContain("var(--muted-foreground");
  });
});
