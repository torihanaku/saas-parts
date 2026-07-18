// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TimelineChart, TIMELINE_DEFAULT_DATA } from "./TimelineChart";

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

describe("TimelineChart", () => {
  it("renders one bar-group per gantt event without crashing", () => {
    const { container } = render(
      <TimelineChart
        width={800}
        height={320}
        data={TIMELINE_DEFAULT_DATA}
      />,
    );
    expect(container.querySelector("svg")).toBeTruthy();
    // 各イベント（end 有り）に bar-group が1つ
    expect(container.querySelectorAll("g.bar-group")).toHaveLength(
      TIMELINE_DEFAULT_DATA.length,
    );
  });

  it("themes axis text and grid lines with CSS-variable colors", () => {
    const { container } = render(
      <TimelineChart
        width={800}
        height={320}
        data={TIMELINE_DEFAULT_DATA}
      />,
    );
    // 軸テキストは themeAxis 経由で --muted-foreground を参照
    const axisText = container.querySelector("g text");
    expect(axisText?.getAttribute("fill")).toContain("var(");
    // グリッド線は --border を参照
    const gridLine = container.querySelector("line.grid-line");
    expect(gridLine?.getAttribute("stroke")).toContain("var(--border");
  });

  it("renders milestone diamonds in milestone mode", () => {
    const { container } = render(
      <TimelineChart
        width={800}
        height={320}
        mode="milestone"
        data={TIMELINE_DEFAULT_DATA}
      />,
    );
    expect(container.querySelectorAll("g.milestone-group")).toHaveLength(
      TIMELINE_DEFAULT_DATA.length,
    );
  });
});
